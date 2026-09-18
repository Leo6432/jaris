import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Refonte des Options (étape 115), demande de Léo : "il ya des categorie dans les options qui peuvent etre
 * ensemble, refait totalement option bien comme claude gpt". 9 onglets réduits : Micro et Activation
 * rejoignent Voix, Mise à jour/Stockage/Historique rejoignent un nouvel onglet Général — chacun devient une
 * VRAIE page de réglages avec plusieurs sections, à la manière de l'onglet "Général" de ChatGPT/Claude
 * (thème, langue, effacer les discussions... tout sur une seule page), plutôt qu'une multitude de tout
 * petits onglets à un seul réglage. L'onglet Téléphone (Mobile connecté) a depuis été retiré complètement à
 * l'étape 116 (Léo : "enleve totalement mobile connect"), sans rapport avec cette refonte visuelle.
 *
 * Ce test vérifie le VRAI composant compilé, pas une relecture du JSX : que les anciens onglets ont
 * vraiment disparu de la barre de navigation, que leur contenu est bien réapparu à l'intérieur du bon
 * onglet fusionné, et que l'orbe de la voix (qui dépendait jusqu'ici d'un `position: absolute` spécial pour
 * se centrer seul sur la page) reste bien positionné et cliquable maintenant qu'il partage la page avec
 * plusieurs autres sections.
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-options-reorg-entry.tsx')

const ENTRY = `
import { createRoot } from 'react-dom/client'
import OptionsMenu from './src/components/OptionsMenu'

window.__orbClicks = 0
const overrides = {
  getProfile: async () => ({ name: 'Léo' }),
  saveProfile: async () => {},
  listAudioInputDevices: async () => [],
  getContextLengthOptions: async () => ({ current: 8192, max: 32768, availableSteps: [8192, 16384, 24576, 32768] }),
  getOllamaVersionStatus: async () => null,
  getAppVersionStatus: async () => ({ current: '0.13.0', latest: '0.13.0', outdated: false }),
  getAppVersion: async () => '0.13.0',
  getModelsLocationStatus: async () => ({
    ollamaModelsDir: 'C\\\\models',
    pythonRuntimeDir: 'C\\\\python',
    hfCacheDir: 'C\\\\cache'
  }),
  getConversationHistory: async () => [],
  previewHardwareTiers: async () => []
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

function buildPage() {
  if (pageHtml) return pageHtml
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-options-reorg-'))
  const bundlePath = join(outDir, 'bundle.js')

  writeFileSync(entryPath, ENTRY)
  try {
    buildSync({ entryPoints: [entryPath], bundle: true, format: 'iife', jsx: 'automatic', alias: { '@': join(projectRoot, 'src') }, outfile: bundlePath })
  } finally {
    rmSync(entryPath, { force: true })
  }

  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  pageHtml = `<!doctype html><html><head><style>html,body{margin:0;background:#05070c;}${css}</style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  return pageHtml
}

async function withOptions(run) {
  const html = buildPage()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1200, height: 900 })
    await page.setContent(html)
    await page.waitForSelector('.options-menu__trigger')
    await page.click('.options-menu__trigger')
    await run(page)
  } finally {
    await browser.close()
  }
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test('onglets réduits : les anciens onglets Micro/Activation/Mise à jour/Stockage/Historique/Téléphone ont disparu', options, async () => {
  await withOptions(async (page) => {
    const labels = await page.$$eval('.options-menu__tab', (els) => els.map((el) => el.textContent?.trim()))
    assert.deepEqual(labels, ['Ce que Jaris sait faire', 'Voix', 'Modèles', 'Général'], `onglets affichés : ${labels.join(', ')}`)
  })
})

test('Voix regroupe VRAIMENT le sélecteur de voix, le micro et l’activation sur UNE seule page', options, async () => {
  await withOptions(async (page) => {
    await page.click('.options-menu__tab:has-text("Voix")')
    await page.waitForSelector('.options-menu__voice-picker')
    // Toutes les sections doivent être présentes SIMULTANÉMENT dans le DOM (une seule page qui défile),
    // pas seulement atteignables une par une derrière un second niveau de navigation. Depuis la refonte de
    // l'étape 116 (lignes de réglage uniformes), ce sont des GROUPES (`SettingGroup`) plutôt qu'un titre par
    // réglage individuel. Depuis l'étape 119 (maquette "Options Jaris.dc.html") : le sélecteur de voix est
    // lui aussi un groupe titré ("La voix de Jaris", il était auparavant le seul bloc sans bordure/titre de
    // tout l'écran) ; "Son" et "Micro et haut-parleur" ont fusionné en "Son et périphériques" ("Son" ne
    // portait qu'UNE ligne, la carte à une seule ligne que la maquette dit d'éliminer) ; "Comment déclencher
    // l'écoute" est redevenu "Déclencher l'écoute" (copie exacte de la maquette).
    const titles = await page.$$eval('.options-menu__section--voix .options-menu__section-title', (els) => els.map((el) => el.textContent))
    assert.deepEqual(titles, ['La voix de Jaris', 'Son et périphériques', "Déclencher l'écoute"])
    // Un réglage de chaque ancien onglet, pour prouver qu'il ne s'agit pas que des titres.
    assert.ok((await page.textContent('.options-menu__section--voix')).includes('Tester le micro'), 'le test micro doit être présent')
    assert.ok((await page.textContent('.options-menu__section--voix')).includes('Dire "Jaris" à voix haute'), 'la case Activation doit être présente')
  })
})

test('Général regroupe VRAIMENT mise à jour et historique sur UNE seule page', options, async () => {
  await withOptions(async (page) => {
    await page.click('.options-menu__tab:has-text("Général")')
    await page.waitForSelector('.options-menu__section-title')
    const titles = await page.$$eval('.options-page__content .options-menu__section-title', (els) => els.map((el) => el.textContent))
    // "Emplacement des modèles" a rejoint Modèles à l'étape 119 (maquette "Options Jaris.dc.html") : ce
    // n'est plus un réglage de l'application elle-même, donc plus une section de Général — voir le test
    // "Modèles regroupe..." ci-dessous, qui vérifie qu'elle est bien réapparue là-bas plutôt que d'avoir
    // simplement disparu.
    assert.deepEqual(titles, ['Mise à jour', 'Historique des conversations'])
    assert.ok((await page.textContent('.options-page__content')).includes('Rechercher une mise à jour'), 'la section mise à jour doit être présente')
  })
})

test('Modèles regroupe VRAIMENT mémoire, matériel et fichiers/moteur local (dont l’emplacement des modèles) sur UNE seule page', options, async () => {
  await withOptions(async (page) => {
    await page.click('.options-menu__tab:has-text("Modèles")')
    await page.waitForSelector('.options-menu__section-title')
    const titles = await page.$$eval('.options-page__content .options-menu__section-title', (els) => els.map((el) => el.textContent))
    // Titres alignés sur la copie exacte de la maquette (étape 119) : "Mémoire de conversation" et "Ce que
    // ta machine fait tourner" au lieu de "Longueur de mémoire"/"Les paliers de configuration".
    assert.deepEqual(titles, ['Mémoire de conversation', 'Ce que ta machine fait tourner', 'Fichiers et moteur local'])
    const content = await page.textContent('.options-page__content')
    assert.ok(content.includes('Dossier des modèles'), 'le déplacement du dossier des modèles doit être présent')
    assert.ok(await page.$('.options-menu__models-location-list'), 'la liste des emplacements doit être présente')
  })
})

test("l'orbe de la voix reste centré et cliquable une fois partagé avec les autres sections", options, async () => {
  await withOptions(async (page) => {
    await page.click('.options-menu__tab:has-text("Voix")')
    await page.waitForSelector('.jaris-orb canvas')
    // Plus de `position: absolute` spécial (retiré à l'étape 115) : l'orbe doit rester dans le flux normal,
    // entièrement visible (jamais rogné/décalé hors de l'écran) même avec tout le contenu ajouté en dessous.
    const box = await page.locator('.jaris-orb canvas').first().boundingBox()
    assert.ok(box, "l'orbe doit avoir une position mesurable")
    assert.ok(box.width > 0 && box.height > 0, `l'orbe ne doit pas être réduit à rien : ${JSON.stringify(box)}`)
    assert.ok(box.x >= 0 && box.y >= 0, `l'orbe ne doit pas être positionné hors écran : ${JSON.stringify(box)}`)
    // Un vrai clic Playwright échoue si un élément invisible intercepte le point cliqué (ex: un ancien
    // conteneur `pointer-events: none` mal dimensionné) — ce test échouerait avec une erreur explicite de
    // Playwright si un tel conteneur existait encore au-dessus de l'orbe.
    await page.locator('.jaris-orb canvas').first().click()
  })
})
