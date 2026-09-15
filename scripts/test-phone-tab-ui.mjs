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
 * Ce que ce test NE prouve pas : que KDE Connect fonctionne sur la machine de Léo (ni Windows, ni iPhone,
 * ni KDE Connect ici) — le pont lui-même est testé à part, sur les commandes construites.
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

const state = { phone: null, ringCalls: 0 }
window.__setPhone = (status) => { state.phone = status }
window.__ringCalls = () => state.ringCalls

const overrides = {
  getProfile: async () => ({ name: 'Léo' }),
  saveProfile: async () => {},
  getPhoneStatus: async () => state.phone,
  ringPhone: async () => { state.ringCalls += 1; return 'Le téléphone sonne.' },
  sendToPhone: async () => 'Texte déposé sur ton téléphone.',
  pickKdeConnectCli: async () => null
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

const REACHABLE = {
  installed: true,
  reachable: true,
  devices: [{ id: 'abc123', name: 'iPhone de Léo' }],
  message: ''
}

async function withPhoneTab(status, run) {
  const html = buildPage()
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1100, height: 800 })
    await page.setContent(html)
    await page.waitForSelector('.options-menu__trigger')
    await page.evaluate((s) => window.__setPhone(s), status)
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

test("l'onglet dit ce qu'Apple interdit, plutôt que de laisser espérer des SMS", options, async () => {
  await withPhoneTab(REACHABLE, async (page) => {
    const texte = await page.textContent('.options-menu__section')
    assert.match(texte, /SMS/)
    assert.match(texte, /notifications/)
    assert.match(texte, /iPhone de Léo/)
  })
})

test('les boutons sont habillés par le CSS de Jaris, pas laissés au style par défaut', options, async () => {
  await withPhoneTab(REACHABLE, async (page) => {
    const mesure = await page.evaluate(() => {
      // TOUS les boutons de la rangée, sélectionnés par leur BALISE et non par la classe attendue : un
      // bouton qui aurait perdu la classe doit être examiné lui aussi, pas ignoré par le sélecteur. Première
      // version de ce test : il visait `.options-menu__action` et passait donc encore quand un bouton perdait
      // sa classe — il trouvait simplement le bouton suivant, resté stylé (le piège même de l'étape 97).
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
    assert.ok(mesure.boutons.length >= 2, `rangée quasi vide : ${JSON.stringify(mesure.boutons)}`)
    for (const bouton of mesure.boutons) {
      // Exactement ce qui manquait au bouton resté gris de l'étape 97 : un fond, une casse, une police.
      assert.match(bouton.background, /gradient/, `« ${bouton.texte} » n'a aucun fond : CSS partagé non appliqué`)
      assert.equal(bouton.transform, 'uppercase', `« ${bouton.texte} » n'est pas en majuscules`)
      assert.match(bouton.police, /Rajdhani/i, `« ${bouton.texte} » n'a pas la police du HUD`)
    }
    // La rangée a rejoint une règle existante par sélecteur groupé : vérifier qu'elle s'applique vraiment.
    assert.equal(mesure.rangee, 'flex')
  })
})

test('faire sonner appelle vraiment le pont, et affiche sa réponse', options, async () => {
  await withPhoneTab(REACHABLE, async (page) => {
    await page.click('.options-menu__actions .options-menu__action:has-text("Faire sonner")')
    await page.waitForFunction(() => document.body.textContent.includes('Le téléphone sonne.'))
    assert.equal(await page.evaluate(() => window.__ringCalls()), 1)
  })
})

test("sans téléphone joignable, le bouton est désactivé au lieu d'échouer une fois cliqué", options, async () => {
  const injoignable = {
    installed: true,
    reachable: true,
    devices: [],
    message: 'Aucun téléphone joignable pour l\'instant.'
  }
  await withPhoneTab(injoignable, async (page) => {
    const bouton = await page.$('.options-menu__actions .options-menu__action:has-text("Faire sonner")')
    assert.equal(await bouton.isDisabled(), true)
    assert.match(await page.textContent('.options-menu__section'), /Aucun téléphone joignable/)
  })
})

test("quand KDE Connect est introuvable, le bouton pour le désigner soi-même apparaît", options, async () => {
  const absent = {
    installed: false,
    reachable: false,
    devices: [],
    message: "KDE Connect n'est pas installé (ou Jaris ne l'a pas trouvé)."
  }
  await withPhoneTab(absent, async (page) => {
    const boutons = await page.$$eval('.options-menu__actions .options-menu__action', (els) =>
      els.map((el) => el.textContent.trim())
    )
    assert.ok(
      boutons.some((texte) => /Trouver KDE Connect/i.test(texte)),
      `bouton de repli absent : ${JSON.stringify(boutons)}`
    )
  })
})

test.after(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})
