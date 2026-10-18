import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * MyModelPicks (écran d'accueil + Options -> Modèles). Étape 137, Léo : "a la place de plalier 1 2 3 on vas
 * faire un palier personnaliser a chacun, il ya plus de palier". Une seule carte : le matériel détecté et,
 * pour chaque rôle, le modèle choisi avec ses scores. Vérifie qu'aucun "Palier N" ne réapparaît, que chaque
 * score est affiché avec son libellé (ce tableau n'a pas d'en-tête), "—" quand rien n'est publié, et aucun
 * débordement en fenêtre étroite. Playwright n'étant pas une dépendance du projet (absent du runner Windows
 * de la CI), les tests se marquent "ignorés" avec une raison explicite plutôt que d'échouer.
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-my-picks-entry.tsx')

const ENTRY = `
import { createRoot } from 'react-dom/client'
import MyModelPicks from './src/components/MyModelPicks'
import { setLanguage } from './shared/i18n'

// Langue de l'écran (français par défaut) : les libellés des rôles n'ont pas la même longueur partout.
if (window.__lang) setLanguage(window.__lang.code, window.__lang.messages)

const e = (model, tool, ai, aiSpeed, demands = null) => ({
  model, vramGb: 8, usedIn: [],
  toolCalling: tool, demands, intelligence: null, artificialAnalysisIndex: ai, artificialAnalysisSpeed: aiSpeed
})

const picks = {
  gpuName: 'NVIDIA GeForce RTX 3070', vramGb: window.__vramGb ?? 8, ramGb: 32,
  flash: e('hf.co/bartowski/ai9stars_G9v3-3B-GGUF', '62/78', 10.8, null, '26/48'),
  medium: e('qwen3.5:4b', '74/78', 13.1, 22, '38/48'),
  large: e('qwen3.8:27b', '77/78', 33.7, 46, '45/48'),
  vision: e('qwen3-vl:4b', '30/34', 7, 109, '40/48'),
  // Modèle sans score publié chez Artificial Analysis : doit afficher "—", jamais un chiffre inventé.
  code: e('qwen2.5-coder:14b', '5/5', null, null),
  // Étape 138 : Médium a un meilleur choix pas encore installé (il suffit de retester), Vision un meilleur
  // choix BLOQUÉ au téléchargement.
  upgrades: {
    medium: { model: 'qwen3.5:9b', blockedReason: null },
    vision: { model: 'hf.co/ggml-org/GLM-4.6V-Flash-GGUF:Q4_K_M', blockedReason: "bloqué par ta version d'Ollama" }
  },
  installCheck: '__installCheck' in window ? window.__installCheck : { notInstalled: [], otherInstalled: [] },
  pilot: window.__pilot
}
window.__deleted = []

const root = createRoot(document.getElementById('root'))
root.render(<div style={{ padding: 20, maxWidth: 760 }}><MyModelPicks picks={picks} onDeleteUnused={async (m) => { window.__deleted.push(m) }} /></div>)
`

let pageHtml = null

function buildPage() {
  if (pageHtml) return pageHtml
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-my-picks-'))
  const bundlePath = join(outDir, 'bundle.js')
  writeFileSync(entryPath, ENTRY)
  try {
    buildSync({ entryPoints: [entryPath], bundle: true, format: 'iife', jsx: 'automatic', alias: { '@': join(projectRoot, 'src') }, loader: { '.png': 'dataurl' }, outfile: bundlePath })
  } finally {
    rmSync(entryPath, { force: true })
  }
  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  pageHtml = `<!doctype html><html><head><style>html,body{margin:0;background:#05070c;}${css}</style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  return pageHtml
}

async function withPreview(run, width = 760, installCheck = undefined, pilot = undefined, lang = 'fr', vramGb = undefined) {
  const html = buildPage()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width, height: 900 })
    // Données de vérification propres à ce test, posées AVANT le script de la page (setContent n'exécute pas
    // les scripts d'initialisation de Playwright).
    const messages = lang === 'fr' ? {} : JSON.parse(readFileSync(join(projectRoot, `shared/i18n/locales/${lang}.json`), 'utf8'))
    const injected =
      (installCheck === undefined ? '' : `<script>window.__installCheck = ${JSON.stringify(installCheck)}</script>`) +
      (pilot === undefined ? '' : `<script>window.__pilot = ${JSON.stringify(pilot)}</script>`) +
      (lang === 'fr' ? '' : `<script>window.__lang = ${JSON.stringify({ code: lang, messages }).replace(/</g, '\\u003c')}</script>`) +
      (vramGb === undefined ? '' : `<script>window.__vramGb = ${JSON.stringify(vramGb)}</script>`)
    await page.setContent(html.replace('<div id="root"></div>', `${injected}<div id="root"></div>`))
    await page.waitForSelector('.capacity-scan__tier-table')
    await run(page)
  } finally {
    await browser.close()
  }
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test("une seule carte pour la machine détectée, sans aucun \"Palier N\"", options, async () => {
  await withPreview(async (page) => {
    const cards = await page.$$eval('.capacity-scan__tier', (els) => els.length)
    assert.equal(cards, 1, `une seule carte attendue, obtenu ${cards}`)
    const text = await page.$eval('.capacity-scan__tiers', (el) => el.textContent)
    assert.doesNotMatch(text, /Palier/, 'plus aucun palier de comparaison ne doit être affiché')
    const hardware = await page.$eval('.capacity-scan__tier-hardware', (el) => el.textContent?.trim())
    assert.equal(hardware, 'NVIDIA GeForce RTX 3070 · 8 Go de VRAM · 32 Go de RAM')
  })
})

test('chaque rôle affiche son modèle, sa vitesse et son Intelligence (avec libellé, "—" si non publié)', options, async () => {
  await withPreview(async (page) => {
    const rows = await page.$$eval('.capacity-scan__tier-table tr:not(.capacity-scan__tier-upgrade)', (trs) =>
      trs.map((tr) => [...tr.querySelectorAll('td')].slice(0, 4).map((td) => td.textContent?.trim()))
    )
    assert.deepEqual(JSON.parse(JSON.stringify(rows)), [
      ['Faible', 'G9v3-3B', '—', 'Intelligence 10,8'],
      ['Moyen', 'qwen3.5:4b', '22 tok/s', 'Intelligence 13,1'],
      ['Élevé', 'qwen3.8:27b', '46 tok/s', 'Intelligence 33,7'],
      ['Vision', 'qwen3-vl:4b', '109 tok/s', 'Intelligence 7,0'],
      ['Code', 'qwen2.5-coder:14b', '—', '—']
    ])
  })
})

// Jusqu'à la version 0.34.31, l'Intelligence s'écrivait à la française dans toutes les langues (locale figée
// 'fr-FR' : « Intelligence 13,1 » en anglais) et une VRAM avec décimale gardait le point de JavaScript (« 7.8 Go »
// en français). Les deux suivent maintenant la langue de Jaris.
test('les nombres suivent la langue : « 13.1 » et « 7.8 GB » en anglais, « 7,8 Go » en français', options, async () => {
  const intelligence = (page) =>
    page.$$eval('.capacity-scan__tier-table tr:not(.capacity-scan__tier-upgrade)', (trs) => trs.map((tr) => tr.querySelectorAll('td')[3]?.textContent?.trim()))
  const hardware = (page) => page.$eval('.capacity-scan__tier-hardware', (el) => el.textContent?.trim())
  await withPreview(
    async (page) => {
      assert.deepEqual(JSON.parse(JSON.stringify(await intelligence(page))), ['Intelligence 10.8', 'Intelligence 13.1', 'Intelligence 33.7', 'Intelligence 7.0', '—'])
      assert.equal(await hardware(page), 'NVIDIA GeForce RTX 3070 · 7.8 GB of VRAM · 32 GB of RAM')
    },
    760,
    undefined,
    undefined,
    'en',
    7.8
  )
  await withPreview(
    async (page) => {
      assert.equal(await hardware(page), 'NVIDIA GeForce RTX 3070 · 7,8 Go de VRAM · 32 Go de RAM')
    },
    760,
    undefined,
    undefined,
    'fr',
    7.8
  )
})

test('la légende dit que ces chiffres ne prédisent pas la vitesse sur la machine', options, async () => {
  await withPreview(async (page) => {
    const legend = await page.$eval('.capacity-scan__tier-legend', (el) => el.textContent ?? '')
    assert.match(legend, /Artificial Analysis/)
    assert.match(legend, /pas la vitesse sur ta\s+machine/)
  })
})

test('la carte ne déborde pas, même dans une fenêtre étroite', options, async () => {
  await withPreview(async (page) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
    assert.equal(overflow, false, 'la carte ne doit pas déborder horizontalement à 560px')
  }, 560)
})

test('un meilleur modèle non utilisé est signalé sous sa ligne, avec la raison s\'il est bloqué', options, async () => {
  await withPreview(async (page) => {
    const notes = await page.$$eval('.capacity-scan__tier-upgrade', (els) => els.map((el) => el.textContent?.trim()))
    assert.equal(notes.length, 2, `deux rôles concernés attendus : ${JSON.stringify(notes)}`)
    assert.match(notes[0], /Meilleur choix disponible : qwen3\.5:9b .*Retester la configuration/)
    assert.match(notes[1], /GLM-4\.6V-Flash \(Q4_K_M\), pas encore installé — bloqué par ta version d'Ollama/)
  })
})

// Étape 140, Léo : "je veut etre sur que les model visbile sont réel et pas un autre model".
test('tout est vérifié auprès d\'Ollama et rien d\'autre n\'est installé : la carte le dit clairement', options, async () => {
  await withPreview(async (page) => {
    const text = await page.$eval('.capacity-scan__install-check', (el) => el.textContent ?? '')
    assert.match(text, /Vérifié auprès d'Ollama/)
    assert.match(text, /Aucun autre modèle installé/)
  })
})

test('un modèle affiché mais pas installé est signalé en rouge sous sa ligne', options, async () => {
  await withPreview(
    async (page) => {
      const notes = await page.$$eval('.capacity-scan__tier-missing', (els) => els.map((el) => el.textContent?.trim()))
      assert.equal(notes.length, 1)
      assert.match(notes[0], /Pas installé sur ce PC/)
      const text = await page.$eval('.capacity-scan__install-check', (el) => el.textContent ?? '')
      assert.doesNotMatch(text, /Vérifié auprès d'Ollama/, 'jamais "vérifié" quand un modèle manque')
    },
    760,
    { notInstalled: ['large'], otherInstalled: [] }
  )
})

test('les autres modèles installés sont listés, et la suppression demande une confirmation', options, async () => {
  await withPreview(
    async (page) => {
      const items = await page.$$eval('.capacity-scan__other-models li span[title]', (els) => els.map((el) => el.textContent))
      assert.deepEqual(JSON.parse(JSON.stringify(items)), ['ministral-3:3b'])
      await page.click('.capacity-scan__other-models button:has-text("Supprimer")')
      assert.deepEqual(await page.evaluate(() => window.__deleted), [], 'un premier clic ne supprime rien : il demande confirmation')
      await page.click('.capacity-scan__delete-confirm')
      await page.waitForFunction(() => window.__deleted.length === 1)
      assert.deepEqual(await page.evaluate(() => window.__deleted), ['ministral-3:3b'])
    },
    760,
    { notInstalled: [], otherInstalled: ['ministral-3:3b'] }
  )
})

test("Ollama injoignable : la carte le dit au lieu de prétendre que tout est installé", options, async () => {
  await withPreview(
    async (page) => {
      const text = await page.$eval('.capacity-scan__install-check', (el) => el.textContent ?? '')
      assert.match(text, /Impossible de vérifier/)
    },
    760,
    null
  )
})

// Étape 231 : rôle « Pilotage d'écran », comme Image/Vidéo — absent si la carte est trop petite.
test("pilotage d'écran : nom lisible quand la machine le fait tourner, rappel s'il n'est pas installé", options, async () => {
  const pilot = { model: 'hf.co/mradermacher/MAI-UI-8B-GGUF:Q4_K_M', reason: null, installed: false }
  await withPreview(async (page) => {
    const row = await page.$eval('.capacity-scan__tier-pilot', (el) => el.textContent)
    assert.match(row, /Pilotage d'écran\s*MAI-UI 8B/)
    assert.doesNotMatch(row, /hf\.co/, "jamais l'identifiant technique à l'écran")
    const text = await page.$eval('.capacity-scan__tier-table', (el) => el.textContent)
    assert.match(text, /Pas installé sur ce PC pour l'instant — clique « Retester la configuration » \(environ 6 Go\)/)
  }, 760, undefined, pilot)
})

test("pilotage d'écran : carte trop petite = aucun modèle, et le modèle Vision pilote à sa place", options, async () => {
  const pilot = { model: null, reason: 'carte graphique trop petite (6 Go de VRAM, il en faut 8 ou plus)' }
  await withPreview(async (page) => {
    assert.match(await page.$eval('.capacity-scan__tier-pilot', (el) => el.textContent), /Aucun modèle/)
    const text = await page.$eval('.capacity-scan__tier-table', (el) => el.textContent)
    assert.match(text, /Pas assez de puissance : carte graphique trop petite \(6 Go.*Le modèle Vision pilote l'écran à sa place/)
  }, 760, undefined, pilot)
})

// Étape 243, Léo : « il y a seulement les questions visibles le score et pas le score de demandes ».
test('Faible, Moyen et Élevé montrent les deux scores, chacun avec son nom ; Vision et Code seulement le leur', options, async () => {
  await withPreview(async (page) => {
    const scores = await page.$$eval('.capacity-scan__tier-scores', (tds) => tds.map((td) => [...td.querySelectorAll('.options-menu__badge')].map((b) => b.textContent?.trim())))
    assert.deepEqual(JSON.parse(JSON.stringify(scores.slice(0, 5))), [
      ['Questions 62/78', 'Demandes 26/48'],
      ['Questions 74/78', 'Demandes 38/48'],
      ['Questions 77/78', 'Demandes 45/48'],
      // Vision : les demandes ne comptent pas dans son choix — jamais affichées, même si le modèle en a un score.
      ['Images 30/34'],
      ['Code 5/5']
    ])
    const legend = await page.$eval('.capacity-scan__tier-legend', (el) => el.textContent ?? '')
    assert.match(legend, /Demandes/)
    // En largeur normale, les deux scores tiennent côte à côte, sur la même ligne.
    const tops = await page.$$eval('.capacity-scan__tier-scores', (tds) => [...tds[0].querySelectorAll('.options-menu__badge')].map((b) => Math.round(b.getBoundingClientRect().top)))
    assert.equal(tops[0], tops[1])
  })
  // Fenêtre la plus étroite permise par Jaris (480 px, main.ts) : les scores passent l'un sous l'autre, rien n'est coupé.
  for (const width of [420, 480]) {
    await withPreview(async (page) => {
      const [card, table] = await page.evaluate(() => [document.querySelector('.capacity-scan__tier').clientWidth, document.querySelector('.capacity-scan__tier-table').scrollWidth])
      assert.ok(table <= card, `à ${width} px, le tableau (${table} px) dépasse de la carte (${card} px)`)
    }, width)
  }
})

/** Pour chaque ligne de rôle : le libellé (nombre de lignes à l'écran, coupé ou non) et la position du nom du modèle. */
const roleLayout = (page) =>
  page.evaluate(() => {
    const card = document.querySelector('.capacity-scan__tier').getBoundingClientRect()
    return [...document.querySelectorAll('.capacity-scan__tier-table tr:not(.capacity-scan__tier-upgrade)')].map((tr) => {
      const slot = tr.querySelector('td.capacity-scan__tier-slot')
      const range = document.createRange()
      range.selectNodeContents(slot)
      const lineTops = new Set([...range.getClientRects()].map((r) => Math.round(r.top)))
      const name = tr.querySelector('td.capacity-scan__tier-model').getBoundingClientRect()
      return { label: slot.textContent, lines: lineTops.size, slotRight: slot.getBoundingClientRect().right, nameLeft: Math.round(name.left), nameRight: name.right, cardRight: card.right }
    })
  })

// Relecteur, après la carte sur deux lignes par rôle : la marge fixe du rôle (8,5em) coupait « Bildschirmsteuer / ung »
// au milieu du mot en allemand. Le rôle prend maintenant la largeur de son plus long libellé, sur UNE ligne.
for (const [lang, longest] of [['de', 'Bildschirmsteuerung'], ['hu', 'Képernyővezérlés'], ['it', 'Controllo dello schermo'], ['fr', "Pilotage d'écran"]]) {
  test(`${lang} : « ${longest} » et chaque rôle tiennent sur une ligne, les noms alignés en colonne, rien hors de la carte`, options, async () => {
    for (const width of [760, 420]) {
      await withPreview(
        async (page) => {
          const rows = await roleLayout(page)
          assert.ok(rows.some((row) => row.label === longest), `libellé attendu : ${JSON.stringify(rows.map((r) => r.label))}`)
          for (const row of rows) {
            assert.equal(row.lines, 1, `à ${width} px, « ${row.label} » est coupé sur ${row.lines} lignes`)
            assert.ok(row.slotRight <= row.nameLeft + 0.5, `à ${width} px, « ${row.label} » chevauche le nom du modèle`)
            assert.ok(row.nameRight <= row.cardRight + 0.5, `à ${width} px, le nom de « ${row.label} » dépasse de la carte`)
          }
          assert.equal(new Set(rows.map((row) => row.nameLeft)).size, 1, `à ${width} px, les noms ne commencent pas tous au même endroit : ${rows.map((r) => r.nameLeft)}`)
        },
        width,
        undefined,
        { model: 'hf.co/mradermacher/MAI-UI-8B-GGUF:Q4_K_M', reason: null, installed: true },
        lang
      )
    }
  })
}

// Relecteurs : sur deux lignes par rôle, un « — » n'est plus sous un titre de colonne et ne veut plus rien dire
// (« – —  Code 5/5 »). Une vitesse ou une intelligence non publiée disparaît ; les vraies valeurs restent.
test('carte sur deux lignes par rôle : aucun « — » orphelin, les valeurs publiées restent', options, async () => {
  for (const width of [760, 560]) {
    await withPreview(async (page) => {
      const visible = await page.$$eval('.capacity-scan__tier-table td', (tds) =>
        tds.filter((td) => td.getClientRects().length > 0).map((td) => td.textContent.trim())
      )
      assert.ok(!visible.includes('—'), `à ${width} px, un « — » seul reste visible : ${JSON.stringify(visible)}`)
      for (const value of ['Intelligence 10,8', '22 tok/s', 'Intelligence 13,1', '109 tok/s', 'Intelligence 7,0']) {
        assert.ok(visible.includes(value), `à ${width} px, « ${value} » a disparu`)
      }
      // Code : ni vitesse ni intelligence publiées, mais son score reste.
      const code = await page.$$eval('.capacity-scan__tier-table tr', (trs) =>
        trs
          .filter((tr) => tr.querySelector('.capacity-scan__tier-slot')?.textContent === 'Code')
          .map((tr) => [...tr.querySelectorAll('td')].filter((td) => td.getClientRects().length > 0).map((td) => td.textContent.trim()))
      )
      assert.deepEqual(JSON.parse(JSON.stringify(code)), [['Code', 'qwen2.5-coder:14b', 'Code 5/5']])
    }, width)
  }
})
