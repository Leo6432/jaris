import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Onglet Options → Téléphone (étape 21), sur le VRAI OptionsMenu et le vrai CSS compilé.
 *
 * Deux choses que seule une mesure dans un navigateur peut prouver, et qui sont exactement les pièges déjà
 * payés dans ce dépôt : (1) les boutons sont réellement habillés par la famille HUD partagée et pas laissés
 * au style par défaut du navigateur (le bouton resté gris de l'étape 97 portait pourtant le bon nom de
 * classe) ; (2) la rangée de boutons, rattachée à une règle CSS existante par sélecteur groupé, s'applique
 * vraiment — une règle qui ne matche rien ne lève aucune erreur, elle est juste ignorée.
 *
 * Ce que ce test NE prouve pas : que Windows accorde l'autorisation, ni que Mobile connecté relaie bien les
 * notifications de l'iPhone (aucun Windows ici) — la lecture elle-même est testée à part, sur la sortie.
 */
let chromium = null
try {
  ;({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-phone-tab-entry.tsx')

/**
 * Le faux pont preload est un Proxy plutôt qu'une liste de canaux : OptionsMenu en appelle beaucoup (profil,
 * micro, modèles, mise à jour, stockage...) et il suffit d'en oublier UN pour que le composant ne se monte
 * jamais et que le test expire en 30 s sans le moindre message — piège vécu deux fois (étapes 96 et 99).
 * Tout canal inconnu répond donc quelque chose d'inoffensif, et tout `onXxx` rend une fonction de
 * désabonnement, comme le vrai preload.
 */
const ENTRY = `
import { createRoot } from 'react-dom/client'
import OptionsMenu from './src/components/OptionsMenu'

const state = { calls: [], openCalls: 0 }
window.__setCalls = (calls) => { state.calls = calls }
window.__openCalls = () => state.openCalls

const overrides = {
  getProfile: async () => ({ name: 'Léo' }),
  saveProfile: async () => {},
  getPhoneCalls: async () => state.calls,
  inspectPhoneCache: async () => ({ packages: [], databases: [], message: 'rien' }),
  openPhoneLink: async () => { state.openCalls += 1; return "L'application Mobile connecté a été lancée." }
}

window.jaris = new Proxy({}, {
  get: (_target, name) => {
    if (typeof name !== 'string') return undefined
    if (name in overrides) return overrides[name]
    if (name.startsWith('on')) return () => () => {}
    return async () => null
  }
})

const root = createRoot(document.getElementById('root'))
root.render(<OptionsMenu />)
`

let pageHtml = null
let outDir = null

function buildPage() {
  if (pageHtml) return pageHtml
  outDir = mkdtempSync(join(tmpdir(), 'jaris-phone-tab-'))
  const bundlePath = join(outDir, 'bundle.js')

  writeFileSync(entryPath, ENTRY)
  try {
    execFileSync(
      'npx',
      [
        'esbuild',
        entryPath,
        '--bundle',
        '--format=iife',
        '--loader:.tsx=tsx',
        '--jsx=automatic',
        `--alias:@=${join(projectRoot, 'src')}`,
        `--outfile=${bundlePath}`
      ],
      { cwd: projectRoot, stdio: 'pipe' }
    )
  } finally {
    rmSync(entryPath, { force: true })
  }

  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  pageHtml = `<!doctype html><html><head><style>html,body{margin:0;background:#05070c;}${css}</style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  return pageHtml
}

const APPELS = [
  { name: 'Maman', number: '+33600000001', date: new Date().toISOString(), durationSeconds: 120 }
]

async function withPhoneTab(calls, run) {
  const html = buildPage()
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1100, height: 800 })
    await page.setContent(html)
    await page.waitForSelector('.options-menu__trigger')
    await page.evaluate((c) => window.__setCalls(c), calls)
    await page.click('.options-menu__trigger')
    // Vrai clic sur l'onglet, pas un setState forcé : c'est le chemin qu'emprunte Léo.
    await page.click('.options-menu__tab:has-text("Téléphone")')
    await page.waitForSelector('.options-menu__actions')
    await run(page)
  } finally {
    await browser.close()
  }
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test("l'onglet dit ce qui marche et ce qui est impossible, sans laisser espérer les messages", options, async () => {
  await withPhoneTab(APPELS, async (page) => {
    const texte = await page.textContent('.options-menu__section')
    assert.match(texte, /appels/i)
    assert.match(texte, /contacts/i)
    // Le point qui compte : ne pas laisser croire aux messages, puisque Mobile connecté ne les garde pas.
    assert.match(texte, /messages/i)
    assert.match(texte, /ni les lire ni en envoyer/i)
  })
})

test('les boutons sont habillés par le CSS de Jaris, pas laissés au style par défaut', options, async () => {
  await withPhoneTab(APPELS, async (page) => {
    const mesure = await page.evaluate(() => {
      // TOUS les boutons de la rangée, sélectionnés par leur BALISE et non par la classe attendue : un
      // bouton qui aurait perdu la classe doit être examiné lui aussi, pas ignoré par le sélecteur (piège
      // de l'étape 97, retrouvé dans ce test même à l'étape 21).
      const boutons = [...document.querySelectorAll('.options-menu__actions button')].map((bouton) => {
        const calcule = getComputedStyle(bouton)
        return {
          texte: bouton.textContent.trim(),
          background: calcule.backgroundImage,
          transform: calcule.textTransform,
          police: calcule.fontFamily
        }
      })
      return { boutons, rangee: getComputedStyle(document.querySelector('.options-menu__actions')).display }
    })
    assert.ok(mesure.boutons.length >= 3, `rangée incomplète : ${JSON.stringify(mesure.boutons)}`)
    for (const bouton of mesure.boutons) {
      assert.match(bouton.background, /gradient/, `« ${bouton.texte} » n'a aucun fond : CSS partagé non appliqué`)
      assert.equal(bouton.transform, 'uppercase', `« ${bouton.texte} » n'est pas en majuscules`)
      assert.match(bouton.police, /Rajdhani/i, `« ${bouton.texte} » n'a pas la police du HUD`)
    }
    assert.equal(mesure.rangee, 'flex')
  })
})

test('rien ne se lit tant que Léo ne clique pas', options, async () => {
  await withPhoneTab(APPELS, async (page) => {
    const texte = await page.textContent('.options-menu__section')
    assert.doesNotMatch(texte, /Maman/, 'les appels ont été lus sans clic')
  })
})

test('après le clic, les appels sont affichés avec leur date lisible', options, async () => {
  await withPhoneTab(APPELS, async (page) => {
    await page.click('.options-menu__action:has-text("Voir mes derniers appels")')
    await page.waitForSelector('.options-menu__notifications li')
    const texte = await page.textContent('.options-menu__notifications')
    assert.match(texte, /Maman/)
    assert.match(texte, /2 min/)
    // Une date ISO brute à l'écran serait illisible : elle doit être mise en forme.
    assert.doesNotMatch(texte, /\dT\d\d:/)
  })
})

test("aucun appel trouvé : on explique, au lieu d'afficher une liste vide", options, async () => {
  await withPhoneTab([], async (page) => {
    await page.click('.options-menu__action:has-text("Voir mes derniers appels")')
    await page.waitForFunction(() => document.body.textContent.includes('Aucun appel trouvé'))
    const liste = await page.$('.options-menu__notifications')
    assert.equal(liste, null, 'une liste vide est affichée alors qu’il n’y a aucun appel')
  })
})

test('le bouton d’ouverture appelle vraiment Mobile connecté', options, async () => {
  await withPhoneTab(APPELS, async (page) => {
    await page.click('.options-menu__action:has-text("Ouvrir Mobile connecté")')
    await page.waitForFunction(() => document.body.textContent.includes('a été lancée'))
    assert.equal(await page.evaluate(() => window.__openCalls()), 1)
  })
})

test.after(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})
