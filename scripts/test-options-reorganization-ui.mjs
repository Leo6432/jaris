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
    assert.ok((await page.textContent('.options-menu__section--voix')).includes('Dire « Jaris » à voix haute'), 'la case Activation doit être présente')
  })
})

test('chaque page de réglages a son titre + sous-titre de la maquette (repéré seulement à la capture complète)', options, async () => {
  // Léo, après 4 correctifs successifs sur des cartes déjà comparées : "non tu a pas compris ma demande" —
  // ce titre/sous-titre était absent des DEUX branches parallèles depuis le premier commit de cette série,
  // parce qu'aucune comparaison précédente n'avait pris une capture de la page COMPLÈTE (toujours recadrée
  // sur les cartes elles-mêmes). Un test dédié plutôt qu'une simple relecture de la classe CSS : vérifie le
  // texte RÉEL affiché pour les 3 onglets de réglages, pas juste que `TAB_META` existe dans le code.
  await withOptions(async (page) => {
    for (const [tabName, title, subtitle] of [
      ['Voix', 'Voix', "La voix de Jaris, les périphériques qu'il utilise, et les façons de le réveiller."],
      ['Modèles', 'Modèles', 'Ce que ta machine fait tourner, et combien Jaris garde en tête pendant une conversation.'],
      ['Général', 'Général', "L'application elle-même : version, fichiers, historique."]
    ]) {
      await page.click(`.options-menu__tab:has-text("${tabName}")`)
      await page.waitForSelector('.options-page__tab-header h3')
      const heading = await page.textContent('.options-page__tab-header h3')
      const sub = await page.textContent('.options-page__tab-header p')
      assert.equal(heading, title, `titre de la page ${tabName}`)
      assert.equal(sub, subtitle, `sous-titre de la page ${tabName}`)
    }
    // "Ce que Jaris sait faire" garde sa propre intro DANS sa section (étape 111), jamais ce gabarit.
    await page.click('.options-menu__tab:has-text("Ce que Jaris sait faire")')
    assert.equal(await page.$('.options-page__tab-header'), null, "capacités ne doit pas avoir ce titre de page")
  })
})

test('Général regroupe VRAIMENT mise à jour, fichiers/moteur local et historique sur UNE seule page', options, async () => {
  await withOptions(async (page) => {
    await page.click('.options-menu__tab:has-text("Général")')
    await page.waitForSelector('.options-menu__section-title')
    const titles = await page.$$eval('.options-page__content .options-menu__section-title', (els) => els.map((el) => el.textContent))
    // "Fichiers et moteur local" (Ollama + dossier des modèles) était passé dans Modèles à l'étape 119
    // (maquette "Options Jaris.dc.html"), remis ici à l'étape 122 sur demande explicite de Léo ("deplace
    // Fichiers et moteur local avec dossier etc... dans général") — voir le test "Modèles regroupe..."
    // ci-dessous, qui vérifie qu'il a bien disparu de Modèles plutôt que d'avoir simplement été dupliqué.
    assert.deepEqual(titles, ['Mise à jour', 'Fichiers et moteur local', 'Historique des conversations'])
    const content = await page.textContent('.options-page__content')
    assert.ok(content.includes('Rechercher une mise à jour'), 'la section mise à jour doit être présente')
    assert.ok(content.includes('Dossier des modèles'), 'le déplacement du dossier des modèles doit être présent')
    assert.ok(await page.$('.options-menu__models-location-list'), 'la liste des emplacements doit être présente')
  })
})

test('Modèles regroupe VRAIMENT mémoire et matériel, sans fichiers/moteur local (déplacé dans Général)', options, async () => {
  await withOptions(async (page) => {
    await page.click('.options-menu__tab:has-text("Modèles")')
    await page.waitForSelector('.options-menu__section-title')
    const titles = await page.$$eval('.options-page__content .options-menu__section-title', (els) => els.map((el) => el.textContent))
    // Titres alignés sur la copie exacte de la maquette (étape 119) : "Mémoire de conversation" et "Ce que
    // ta machine fait tourner" au lieu de "Longueur de mémoire"/"Les paliers de configuration".
    assert.deepEqual(titles, ['Mémoire de conversation', 'Ce que ta machine fait tourner'])
    const content = await page.textContent('.options-page__content')
    assert.ok(!content.includes('Dossier des modèles'), 'le dossier des modèles ne doit plus être dans Modèles')
    assert.ok(!(await page.$('.options-menu__models-location-list')), 'la liste des emplacements ne doit plus être dans Modèles')
  })
})

test("l'orbe de la voix reste visible et cliquable une fois partagé avec les autres sections", options, async () => {
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

test('"La voix de Jaris" est une carte COMPACTE (orbe à gauche, texte à droite), pas la grande carte centrée verticalement', options, async () => {
  // Léo, capture recadrée sur cette seule carte à l'appui, après plusieurs allers-retours sur des écarts de
  // texte : "tu a toujours pas compris que c'etais ça que faut changer, je veut que ça ressemble a ça" —
  // aucune comparaison précédente n'avait remis en cause la DISPOSITION elle-même (héritée des étapes
  // 76-78, "même taille que l'accueil"), qui n'a jamais été celle de la maquette pour cette carte précise.
  await withOptions(async (page) => {
    await page.click('.options-menu__tab:has-text("Voix")')
    await page.waitForSelector('.jaris-orb canvas')
    const orbBox = await page.locator('.jaris-orb canvas').first().boundingBox()
    const nameBox = await page.locator('.options-menu__voice-name').boundingBox()
    const cardBox = await page.locator('.options-menu__section--voix .options-menu__group').first().boundingBox()
    // Horizontal, pas vertical : le nom doit être À CÔTÉ de l'orbe (chevauchement vertical réel), pas
    // dessous. Une disposition verticale centrée mettrait nameBox bien plus bas que le bas de l'orbe.
    assert.ok(nameBox.y < orbBox.y + orbBox.height, `"M3" doit être à côté de l'orbe, pas dessous : orbe ${JSON.stringify(orbBox)}, nom ${JSON.stringify(nameBox)}`)
    assert.ok(nameBox.x > orbBox.x + orbBox.width, `"M3" doit être à DROITE de l'orbe : orbe ${JSON.stringify(orbBox)}, nom ${JSON.stringify(nameBox)}`)
    // Compacte : la grande carte centrée verticalement (avant ce correctif) dépassait 600px de haut à elle
    // seule ; la carte compacte de la maquette tient sur une seule bande, largement sous 250px.
    assert.ok(cardBox.height < 250, `la carte doit être compacte, pas la grande carte verticale d'avant : ${cardBox.height}px`)
  })
})

test('les cartes de réglages ont de l\'air entre le titre et le contenu, et entre le contenu et le bas de la carte', options, async () => {
  // Léo, capture annotée de rouge sur plusieurs cartes : "augmente un peut la taille des carre la ou j'ai
  // entourée entre la barre et le texte et la fin du rectangle pour tout les rectangle dans option" — avant
  // ce correctif, le premier réglage touchait quasiment le trait sous le titre (14px, seulement le padding
  // propre de la ligne) et le dernier réglage touchait quasiment le bord bas de la carte (14px). Les deux
  // gaps doivent être mesurablement plus grands maintenant, sans pour autant écarter les réglages ENTRE eux
  // (jamais demandé, et ça casserait l'alignement avec les autres onglets déjà validés).
  await withOptions(async (page) => {
    await page.click('.options-menu__tab:has-text("Voix")')
    await page.waitForSelector('.options-menu__voice-picker')
    const group = page.locator('.options-menu__section--voix .options-menu__group').nth(1) // "Son et périphériques"
    const title = await group.locator('.options-menu__section-title').boundingBox()
    const rows = await group.locator('.options-menu__row').all()
    const firstLabel = await rows[0].locator('.options-menu__row-label').boundingBox()
    const lastRowBox = await rows[rows.length - 1].boundingBox()
    const cardBox = await group.boundingBox()
    const titleToFirstRow = firstLabel.y - (title.y + title.height)
    const lastRowToBottom = cardBox.y + cardBox.height - (lastRowBox.y + lastRowBox.height)
    assert.ok(titleToFirstRow > 18, `l'écart titre -> premier réglage doit être visiblement augmenté (était 14px) : ${titleToFirstRow}px`)
    assert.ok(lastRowToBottom > 18, `l'écart dernier réglage -> bas de la carte doit être visiblement augmenté (était 14px) : ${lastRowToBottom}px`)
    // Pas de dérive vers l'excès non plus : "un peu", pas un vide béant qui casserait la compacité voulue
    // pour la carte "La voix de Jaris" juste au-dessus.
    assert.ok(titleToFirstRow < 40, `l'écart titre -> premier réglage ne doit pas devenir excessif : ${titleToFirstRow}px`)
  })
})
