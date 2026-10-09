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
  getOllamaVersionStatus: async () => window.__ollamaStatus ?? null,
  // Étape 170 : l'installeur officiel se termine plus tard ; le test diffuse lui-même le nouveau statut.
  updateOllama: async () => ({ success: true, message: 'Installeur lancé.', installerPending: true }),
  onOllamaVersionStatus: (cb) => {
    window.__emitOllamaStatus = cb
    return () => {}
  },
  getAppVersionStatus: async () => ({ current: '0.13.0', latest: '0.13.0', outdated: false }),
  getAppVersion: async () => '0.13.0',
  // Étape 165 : imite l'entrée de démarrage de Windows, relue après chaque bascule.
  getLaunchAtStartup: async () => ({ supported: true, enabled: Boolean(window.__launchAtStartup), blockedByWindows: false }),
  // Étape 245 : retient chaque ouverture du journal des demandes (false = ouvrir, true = montrer le fichier).
  openRequestJournal: async (reveal) => {
    window.__journalOpens = [...(window.__journalOpens ?? []), reveal]
  },
  setLaunchAtStartup: async (enabled) => {
    window.__launchAtStartup = enabled
    return { supported: true, enabled, blockedByWindows: false }
  },
  getModelsLocationStatus: async () => ({
    root: null,
    items: [
      { label: 'le programme Jaris', path: 'C\\\\Jaris' },
      { label: 'les modèles Ollama', path: 'C\\\\models' }
    ]
  }),
  getConversationHistory: async () => [],
  // Étape 180 : le test du mot « Jaris » — le test diffuse lui-même ce que le sidecar aurait compris.
  testWakeWord: async () => {
    if (window.__listeningIssue) return { started: false, reason: window.__listeningIssue }
    window.__wakeTest = 'on'
    return { started: true, reason: null }
  },
  // Étape 188 : le test micro répond s'il a pu démarrer ; sa fin est diffusée par le test lui-même.
  testMicrophone: async () => {
    if (window.__listeningIssue) return { started: false, reason: window.__listeningIssue }
    window.__micTest = 'on'
    return { started: true, reason: null }
  },
  stopTestMicrophone: () => { window.__micTest = 'off' },
  onMicTestDone: (cb) => {
    window.__emitMicDone = cb
    return () => {}
  },
  stopTestWakeWord: () => { window.__wakeTest = 'off' },
  onWakeTestHeard: (cb) => {
    window.__emitWakeHeard = cb
    return () => {}
  },
  getMyModelPicks: async () => ({ gpuName: 'RTX 3070', vramGb: 8, ramGb: window.__ramGb ?? 32, flash: { model: "qwen3.5:4b", vramGb: 3.4, usedIn: [], toolCalling: "6/6", intelligence: null, artificialAnalysisIndex: 13, artificialAnalysisSpeed: 19 }, medium: { model: "qwen3.5:4b", vramGb: 3.4, usedIn: [], toolCalling: "6/6", intelligence: null, artificialAnalysisIndex: 13, artificialAnalysisSpeed: 19 }, large: { model: "qwen3.5:4b", vramGb: 3.4, usedIn: [], toolCalling: "6/6", intelligence: null, artificialAnalysisIndex: 13, artificialAnalysisSpeed: 19 }, vision: { model: "qwen3.5:4b", vramGb: 3.4, usedIn: [], toolCalling: "6/6", intelligence: null, artificialAnalysisIndex: 13, artificialAnalysisSpeed: 19 }, code: { model: "qwen3.5:4b", vramGb: 3.4, usedIn: [], toolCalling: "6/6", intelligence: null, artificialAnalysisIndex: 13, artificialAnalysisSpeed: 19 } , upgrades: {}, installCheck: { notInstalled: [], otherInstalled: [] }, image: window.__imagePick ?? { model: 'FLUX.2 klein 4B', reason: null, installed: false }, video: window.__videoPick ?? { model: 'FastWan 2.2 TI2V 5B', qualityLabel: 'Moyen', quality: 'q6', reason: null, installed: false } }),
  // Étape 168 : test des seuls modèles sans score — le test pilote lui-même les lignes du script et sa fin.
  getUnscoredModels: async () => ['qwen2.5-coder:14b', 'nemotron-3.5-lightning:30b'],
  onModelBenchmarkLine: (cb) => {
    window.__benchLine = cb
    return () => {}
  },
  testUnscoredModels: () => {
    window.__testCalls = (window.__testCalls ?? 0) + 1
    return new Promise((resolve) => (window.__finishTest = () => resolve({ models: [], resultsPath: 'x' })))
  },
  getModelOverview: async () => ({
    vramGb: 8,
    codeModel: 'qwen2.5-coder:7b',
    // Étape 160 : une seule liste de modèles, chacun avec son étiquette (repère affiché seulement).
    entries: [
      { model: 'ministral-3:3b', vramGb: 3.0, category: 'Rapide', readsImages: true, usedIn: ['Rapide', 'Médium'], toolCalling: '6/6', demands: '33/48', intelligence: null, artificialAnalysisIndex: 4.8 },
      { model: 'qwen3:1.7b', vramGb: 2, category: 'Rapide', readsImages: false, usedIn: [], toolCalling: null, intelligence: null, artificialAnalysisIndex: null },
      { model: 'gemma4:31b', vramGb: 20, category: 'Puissant', readsImages: true, usedIn: ['Vision'], toolCalling: null, intelligence: null, artificialAnalysisIndex: null }
    ]
  })
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
    buildSync({ entryPoints: [entryPath], bundle: true, format: 'iife', jsx: 'automatic', alias: { '@': join(projectRoot, 'src') }, loader: { '.png': 'dataurl' }, outfile: bundlePath })
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

// Étape 214 : « Téléphone » revient, pour parler à Jaris depuis son téléphone (Tailscale) — sans rapport avec
// l'ancien onglet Mobile connecté retiré à l'étape 116, qui, lui, ne doit jamais revenir.
test('onglets réduits : les anciens onglets Micro/Activation/Mise à jour/Stockage/Historique ont disparu', options, async () => {
  await withOptions(async (page) => {
    const labels = await page.$$eval('.options-menu__tab', (els) => els.map((el) => el.textContent?.trim()))
    assert.deepEqual(labels, ['Ce que Jaris sait faire', 'Voix', 'Modèles', 'Téléphone', 'Général'], `onglets affichés : ${labels.join(', ')}`)
    assert.doesNotMatch(await page.textContent('body'), /Mobile connecté/)
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
    assert.deepEqual(titles, ['Démarrage', 'Mise à jour', 'Fichiers et moteur local', 'Historique des conversations', 'Journal des demandes'])
    const content = await page.textContent('.options-page__content')
    assert.ok(content.includes('Rechercher une mise à jour'), 'la section mise à jour doit être présente')
    assert.ok(content.includes('Dossier de Jaris'), 'le déplacement du dossier de Jaris doit être présent')
    assert.ok(await page.$('.options-menu__models-location-list'), 'la liste des emplacements doit être présente')
  })
})

test('Général : les deux boutons du journal des demandes ouvrent le fichier, puis le montrent dans son dossier', options, async () => {
  await withOptions(async (page) => {
    await page.click('.options-menu__tab:has-text("Général")')
    await page.click('button:has-text("Ouvrir le journal")')
    await page.click('button:has-text("Montrer le fichier")')
    await page.waitForFunction(() => window.__journalOpens?.length === 2)
    assert.deepEqual(await page.evaluate(() => window.__journalOpens), [false, true])
    // Habillés comme les autres boutons d'Options (leçon du bouton resté gris, étape 97) : jamais le style du navigateur.
    const styled = await page.$$eval('button', (buttons) =>
      buttons
        .filter((b) => b.textContent === 'Ouvrir le journal' || b.textContent === 'Montrer le fichier')
        .map((b) => getComputedStyle(b).color !== 'rgb(0, 0, 0)' && b.classList.contains('options-menu__action'))
    )
    assert.deepEqual(styled, [true, true])
  })
})

test('Général : l’interrupteur « Ouvrir Jaris au démarrage de Windows » s’active puis se désactive', options, async () => {
  await withOptions(async (page) => {
    await page.click('.options-menu__tab:has-text("Général")')
    const toggle = page.getByRole('switch', { name: 'Ouvrir Jaris au démarrage de Windows' })
    await toggle.waitFor()
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    await toggle.click()
    await page.waitForFunction(() => window.__launchAtStartup === true)
    await page.waitForSelector('[role="switch"][aria-checked="true"][aria-label="Ouvrir Jaris au démarrage de Windows"]')
    await toggle.click()
    await page.waitForFunction(() => window.__launchAtStartup === false)
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
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
    assert.ok(!content.includes('Dossier de Jaris'), 'le dossier de Jaris ne doit pas être dans Modèles')
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

// Léo : "dans model ajoute un bouton en dessou de tout les palier, tout les model et met tout les model
// qu'on a utiliser met le score apelle outil la vram necessaire pour le model, et un score d'intelligence externe"
// (AllModelsOverview.tsx). Repris juste après (Léo : "quand on clique sur tout les models on doit ouvrire
// un page entierement pour ça") : un clic n'ouvre plus une liste dépliée EN PLACE dans la petite carte des
// paliers, mais une vraie page plein écran (.options-page--models, empilée par-dessus la page Options),
// avec son propre bouton "Fermer" qui revient sur la page Options — sans perdre l'onglet Modèles en cours.
test('"Tous les modèles" ouvre une page plein écran séparée, pas une liste dépliée sur place', options, async () => {
  await withOptions(async (page) => {
    await page.click('.options-menu__tab:has-text("Modèles")')
    await page.waitForSelector('.options-menu__all-models')
    assert.equal(await page.$('.options-page--models'), null, 'la page plein écran ne doit pas exister avant le clic')

    await page.click('.options-menu__all-models button:has-text("Tous les modèles")')
    await page.waitForSelector('.options-page--models .options-menu__model-overview')

    // "Page entièrement" vérifié pour de vrai (rectangle mesuré), pas juste un nom de classe : elle doit
    // recouvrir tout le viewport, exactement comme la page Options qu'elle empile par-dessus.
    const viewport = page.viewportSize()
    const box = await page.$eval('.options-page--models', (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
    assert.equal(box.x, 0, `la page doit toucher le bord gauche : ${box.x}`)
    assert.equal(box.y, 0, `la page doit toucher le bord haut : ${box.y}`)
    assert.equal(box.width, viewport.width, `la page doit couvrir toute la largeur : ${box.width} vs ${viewport.width}`)
    assert.equal(box.height, viewport.height, `la page doit couvrir toute la hauteur : ${box.height} vs ${viewport.height}`)

    // Réellement AU-DESSUS de la page Options (z-index plus élevé), pas juste peinte par-dessus par hasard.
    const zIndexes = await page.$$eval('.options-page', (els) => els.map((el) => Number(getComputedStyle(el).zIndex)))
    assert.equal(zIndexes.length, 2, `2 pages .options-page attendues (Options + Tous les modèles) : ${zIndexes.length}`)
    assert.ok(Math.max(...zIndexes) > Math.min(...zIndexes), `la page des modèles doit avoir un z-index plus élevé : ${zIndexes}`)

    // Sans colonne de navigation de gauche (contrairement à la page Options qu'elle recouvre) : le contenu
    // doit démarrer près du bord gauche, pas laisser un vide de ~200-250px où vivrait cette colonne absente.
    const contentX = await page.$eval('.options-page--models .options-page__workspace', (el) => el.getBoundingClientRect().x)
    assert.ok(contentX < 50, `le contenu doit occuper toute la largeur, sans gouttière de navigation : x=${contentX}`)

    // Étape 160 (Léo : « tous les modèles au même endroit ») : UN seul tableau, plus de titre par palier.
    assert.equal(await page.$('.options-page--models .options-menu__model-group-title'), null, 'plus aucun tableau par palier')
    assert.equal((await page.$$('.options-page--models table')).length, 1, 'un seul tableau attendu')

    const rows = await page.$$eval('.options-page--models tbody tr', (els) =>
      els.map((el) => Array.from(el.querySelectorAll('td')).map((td) => td.textContent?.trim()))
    )
    assert.equal(rows.length, 3, `3 modèles attendus : ${rows.length}`)
    // La catégorie reste visible comme repère (Léo : « pour que les utilisateurs voient quel modèle est rapide »).
    assert.equal(rows[0][1], 'Faible · lit les images', `catégorie affichée : ${rows[0][1]}`)
    assert.equal(rows[2][1], 'Élevé · lit les images', `catégorie affichée : ${rows[2][1]}`)
    // ministral-3:3b : utilisé pour deux rôles, VRAM et Intelligence Index officiel (5).
    assert.equal(rows[0][2], 'Oui — Rapide, Médium', `rôles actifs attendus : ${rows[0][2]}`)
    assert.ok(rows[0][3].includes('3'), `VRAM du premier modèle : ${rows[0][3]}`)
    // Étape 243 : la colonne des demandes complètes, à côté de l'appel d'outils ; « — » sans score.
    assert.equal(rows[0][5], '33/48', `score de demandes attendu : ${rows[0][5]}`)
    assert.equal(rows[1][5], '—', `pas de score de demandes : ${rows[1][5]}`)
    assert.equal(rows[0][6], '4,8', `Intelligence Index attendu (4,8, avec sa décimale) : ${rows[0][6]}`)
    // "Vitesse (Artificial Analysis)" : "—" quand Artificial Analysis n'a pas publié de mesure fiable.
    assert.equal(rows[0][7], '—', `Vitesse doit rester "—" sans mesure publiée : ${rows[0][7]}`)
    // qwen3:1.7b : aucun score officiel connu, clairement indiqué sans chiffre inventé.
    assert.equal(rows[1][2], 'Non', `le modèle non retenu doit être indiqué : ${rows[1][2]}`)
    assert.equal(rows[1][6], 'Non publié', `absence de score officiel attendue : ${rows[1][6]}`)

    // "Fermer" revient sur la page Options, toujours sur l'onglet Modèles — elle n'a jamais été fermée.
    await page.click('.options-page--models .options-page__close')
    await page.waitForFunction(() => document.querySelector('.options-page--models') === null)
    assert.ok(await page.$('.options-menu__tab--active:has-text("Modèles")'), 'la page Options doit rester ouverte sur Modèles après Fermer')
  })
})

test('le bouton "Tous les modèles" est réellement habillé par le CSS de Jaris, pas laissé au style du navigateur', options, async () => {
  await withOptions(async (page) => {
    await page.click('.options-menu__tab:has-text("Modèles")')
    await page.waitForSelector('.options-menu__all-models')
    const style = await page.$eval('.options-menu__all-models button', (el) => {
      const s = getComputedStyle(el)
      return { radius: s.borderTopLeftRadius, border: s.borderTopStyle, font: s.fontFamily }
    })
    // Refonte « design sobre » : la famille de boutons est une pilule à liseré fin, en Geist.
    assert.equal(style.radius, '9999px', 'bouton sans la pilule de la famille de Jaris (style ChatGPT, étape 266)')
    assert.equal(style.border, 'solid', 'bouton sans le liseré de la famille de Jaris')
    assert.match(style.font, /Geist/)
  })
})

// Étape 166 (convenu avec Léo : « après je peux te donner les scores et après on va enlever l'analyse ») : son
// analyse du 25/09/2026 est recopiée dans verified-tool-scores.md, et plus rien ne permet de la relancer.
test('« Tous les modèles » n’a plus de bouton d’analyse, seulement le tableau des scores', options, async () => {
  await withOptions(async (page) => {
    await page.click('.options-menu__tab:has-text("Modèles")')
    await page.click('.options-menu__all-models button:has-text("Tous les modèles")')
    await page.waitForSelector('.options-page--models .options-menu__model-overview')
    const buttons = await page.$$eval('.options-page--models button', (els) => els.map((el) => el.textContent?.trim() ?? ''))
    assert.ok(!buttons.some((t) => /analyse/i.test(t)), `bouton d'analyse encore présent : ${buttons.join(', ')}`)
  })
})

// Étape 170, Léo : « après la mise à jour le message ne se supprime pas et on peut refaire la mise à jour, faut
// redémarrer l'appli ».
test('mise à jour d’Ollama : pas de second bouton pendant l’installeur, puis « à jour » sans redémarrer', options, async () => {
  const html = buildPage()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1200, height: 900 })
    await page.setContent(html)
    await page.evaluate(() => {
      window.__ollamaStatus = { current: '0.34.2', latest: '0.34.4', outdated: true }
    })
    await page.click('.options-menu__trigger')
    await page.click('.options-menu__tab:has-text("Général")')
    const ollamaRow = page.locator('.options-menu__row', { hasText: 'Ollama' }).first()
    await ollamaRow.locator('button:has-text("Mettre à jour")').click()
    await page.waitForSelector('text=Jaris attend la fin de l\'installation')
    assert.equal(await ollamaRow.locator('button:has-text("Mettre à jour")').count(), 0, 'le bouton ne doit pas revenir pendant l’installeur')

    await page.evaluate(() => {
      window.__ollamaStatus = { current: '0.34.4', latest: '0.34.4', outdated: false }
      window.__emitOllamaStatus(window.__ollamaStatus)
    })
    await page.waitForSelector('text=Ollama est à jour (0.34.4).')
    assert.match(await ollamaRow.textContent(), /0\.34\.4 installée · à jour/)
    assert.equal(await page.locator('text=Jaris attend la fin de l\'installation').count(), 0)
  } finally {
    await browser.close()
  }
})

// Étape 168, Léo : « remets le bouton pour Lightning et qwen2.5-coder:14b ».
test('« Tester ces modèles » : nomme les modèles, confirme, puis suit le test modèle par modèle', options, async () => {
  await withOptions(async (page) => {
    await page.click('.options-menu__tab:has-text("Modèles")')
    await page.click('.options-menu__all-models button:has-text("Tous les modèles")')
    await page.waitForSelector('.options-menu__unscored')
    const title = await page.textContent('.options-menu__unscored-title')
    assert.match(title, /\(2\)/)
    assert.match(title, /qwen2\.5-coder:14b|Qwen2\.5/i)

    // Rien ne démarre avant la confirmation, et Annuler ne lance rien.
    await page.click('.options-menu__unscored button:has-text("Tester ces modèles")')
    // Étape 230 : la durée réelle (plusieurs heures) et la reprise après coupure sont annoncées AVANT de lancer.
    const confirm = await page.textContent('.options-menu__unscored-confirm')
    assert.match(confirm, /plusieurs heures/)
    assert.match(confirm, /40 demandes complètes, dont 8 rejouées/)
    assert.match(confirm, /Microsoft Edge/)
    assert.match(confirm, /reprend/)
    await page.click('.options-menu__unscored button:has-text("Annuler")')
    assert.equal(await page.evaluate(() => window.__testCalls ?? 0), 0)

    await page.click('.options-menu__unscored button:has-text("Tester ces modèles")')
    await page.click('.options-menu__unscored button:has-text("Lancer le test")')
    await page.waitForFunction(() => window.__testCalls === 1 && typeof window.__benchLine === 'function')
    await page.evaluate(() => {
      window.__benchLine('##PULL_MODEL_PROGRESS## nemotron-3.5-lightning:30b 40')
      window.__benchLine('##PROGRESS## 5 10')
    })
    await page.waitForSelector('.options-menu__unscored .options-menu__progress-label:has-text("40 %")')
    const width = await page.$eval('.options-menu__unscored .options-menu__progress-bar-fill', (el) => el.style.width)
    assert.equal(width, '50%')
    await page.evaluate(() => {
      window.__benchLine('##MODEL_DONE## nemotron-3.5-lightning:30b 76 78')
      window.__benchLine('##MODEL_SKIPPED## qwen2.5-coder:14b téléchargement impossible : pull model manifest: file does not exist')
      window.__finishTest()
    })
    await page.waitForSelector('.options-menu__unscored button:has-text("Ouvrir le fichier des résultats")')
    const results = await page.textContent('.options-menu__unscored-results')
    assert.match(results, /76\/78/)
    assert.match(results, /sauté — téléchargement impossible : pull model manifest: file does not exist/)
    // Habillé par le CSS de Jaris (carte), pas du texte nu.
    assert.equal(await page.$eval('.options-menu__unscored', (el) => getComputedStyle(el).borderStyle), 'solid')
  })
})

// Léo, étape 129, sur la première version où SEULS les titres de colonne étaient cliquables : "je voit pas
// de truc pour filtrés dans tout les models". Le tri marchait (le test ci-dessous le prouvait déjà), mais
// rien ne le SIGNALAIT : un titre cliquable avait exactement la même police, la même couleur et la même
// taille qu'un titre normal. Ce test vérifie la COMMANDE VISIBLE, pas seulement le mécanisme — c'est
// précisément la distinction qui manquait pour attraper le problème avant livraison.
test('une barre "Trier par" VISIBLE propose les 5 critères, sans avoir à deviner que les titres sont cliquables', options, async () => {
  await withOptions(async (page) => {
    await page.click('.options-menu__tab:has-text("Modèles")')
    await page.click('.options-menu__all-models button:has-text("Tous les modèles")')
    await page.waitForSelector('.options-page--models .options-menu__model-overview')

    const chips = await page.$$eval('.options-page--models .options-menu__sort-chip', (els) => els.map((el) => el.textContent?.trim()))
    assert.deepEqual(chips, ['VRAM', "Appel d'outils", 'Demandes', 'Intelligence', 'Vitesse', 'Par défaut'], `pastilles de tri attendues : ${chips.join(', ')}`)

    // Réellement habillées par le CSS de Jaris (famille des onglets), pas laissées au style par défaut du
    // navigateur — même piège que le bouton resté gris d'une étape précédente, vérifié par MESURE.
    const style = await page.$eval('.options-page--models .options-menu__sort-chip', (el) => {
      const s = getComputedStyle(el)
      return { radius: s.borderRadius, border: s.borderStyle, cursor: s.cursor }
    })
    assert.match(style.radius, /999px|499\.5px/, `pastille sans coins arrondis : ${style.radius}`)
    assert.equal(style.border, 'solid', 'la pastille doit avoir une vraie bordure visible')
    assert.equal(style.cursor, 'pointer', 'la pastille doit se signaler comme cliquable')

    // Cliquer une pastille trie pour de vrai, et la pastille active se distingue des autres.
    await page.locator('.options-menu__sort-chip', { hasText: 'Intelligence' }).first().click()
    const pressed = await page.$$eval('.options-page--models .options-menu__sort-chip', (els) =>
      els.filter((el) => el.getAttribute('aria-pressed') === 'true').map((el) => el.textContent?.trim())
    )
    assert.deepEqual(pressed, ['Intelligence ▼'], `une seule pastille active attendue : ${pressed.join(', ')}`)
  })
})

// Léo, étape 128 : "ajoute pouvoir filtrer les models par la ram, par de la moin de vram a la plus, le plus
// rapide, le plus inteligent, le plus appelle outils" — un tri (pas un filtre) sur 4 colonnes, cliquables.
test('cliquer une colonne trie "Tous les modèles" ; une seconde fois inverse le sens', options, async () => {
  await withOptions(async (page) => {
    await page.click('.options-menu__tab:has-text("Modèles")')
    await page.click('.options-menu__all-models button:has-text("Tous les modèles")')
    await page.waitForSelector('.options-page--models .options-menu__model-overview')

    const models = () =>
      page.$$eval('.options-page--models tbody tr', (rows) => rows.map((tr) => tr.querySelector('.options-menu__model-name')?.title))

    // Ordre par défaut (aucun tri actif) : celui renvoyé tel quel par getModelOverview.
    assert.deepEqual(await models(), ['ministral-3:3b', 'qwen3:1.7b', 'gemma4:31b'], 'ordre par défaut inattendu')

    // Premier clic sur "VRAM nécessaire" : croissante par défaut (Léo : "de la moin de vram a la plus").
    await page.locator('.options-menu__sort-button', { hasText: 'VRAM nécessaire' }).first().click()
    assert.deepEqual(await models(), ['qwen3:1.7b', 'ministral-3:3b', 'gemma4:31b'], 'tri croissant par VRAM attendu au premier clic')

    // Second clic sur la MÊME colonne : inverse le sens plutôt que de rester bloqué en croissant.
    await page.locator('.options-menu__sort-button', { hasText: 'VRAM nécessaire' }).first().click()
    assert.deepEqual(await models(), ['gemma4:31b', 'ministral-3:3b', 'qwen3:1.7b'], 'un second clic doit inverser le sens du tri')

    // "Appel d'outils" : décroissant par défaut. Un score absent finit toujours en dernier, jamais en tête.
    await page.locator('.options-menu__sort-button', { hasText: "Appel d'outils" }).first().click()
    const byTools = await models()
    assert.equal(byTools[0], 'ministral-3:3b', 'le seul modèle testé doit passer en tête')

    // Étape 243 : « Demandes complètes » se trie pareil, un modèle sans score de demandes en dernier (en partant
    // d'un tri par VRAM croissante, qui met qwen3:1.7b en tête).
    await page.locator('.options-menu__sort-button', { hasText: 'VRAM nécessaire' }).first().click()
    assert.equal((await models())[0], 'qwen3:1.7b')
    await page.locator('.options-menu__sort-button', { hasText: 'Demandes complètes' }).first().click()
    assert.equal((await models())[0], 'ministral-3:3b', 'le seul modèle avec un score de demandes doit passer en tête')
  })
})

// Étape 226 (Léo : « ajoute une barre de recherche à côté des filtres dans tous les modèles »).
test('« Tous les modèles » : la recherche est dans la barre des tris et filtre réellement le tableau', options, async () => {
  await withOptions(async (page) => {
    await page.click('.options-menu__tab:has-text("Modèles")')
    await page.click('.options-menu__all-models button:has-text("Tous les modèles")')
    await page.waitForSelector('.options-page--models .options-menu__model-overview')
    const models = () =>
      page.$$eval('.options-page--models tbody tr', (rows) => rows.map((tr) => tr.querySelector('.options-menu__model-name')?.title))

    // À côté des filtres : dans la même barre, sur la même ligne que les pastilles de tri.
    const layout = await page.$eval('.options-page--models .options-menu__sort-bar', (bar) => {
      const input = bar.querySelector('.options-menu__model-search')
      const chip = bar.querySelector('.options-menu__sort-chip')
      if (!input || !chip) return null
      const a = input.getBoundingClientRect()
      const b = chip.getBoundingClientRect()
      const style = getComputedStyle(input)
      return { sameRow: Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) < 6, radius: parseFloat(style.borderTopLeftRadius) }
    })
    assert.ok(layout, 'champ de recherche absent de la barre des tris')
    assert.ok(layout.sameRow, 'la recherche doit être sur la même ligne que les filtres')
    assert.ok(layout.radius > 8, `pilule attendue, coins droits du style général des champs : ${layout.radius}px`)

    await page.fill('.options-menu__model-search', 'qwen')
    assert.deepEqual(await models(), ['qwen3:1.7b'])
    // Ponctuation et majuscules ignorées : « GEMMA 4 » trouve gemma4:31b.
    await page.fill('.options-menu__model-search', 'GEMMA 4')
    assert.deepEqual(await models(), ['gemma4:31b'])

    // La recherche se combine avec le tri.
    await page.fill('.options-menu__model-search', '3')
    await page.locator('.options-menu__sort-button', { hasText: 'VRAM nécessaire' }).first().click()
    assert.deepEqual(await models(), ['qwen3:1.7b', 'ministral-3:3b', 'gemma4:31b'])

    // Aucun résultat : une phrase, jamais un tableau vide.
    await page.fill('.options-menu__model-search', 'introuvable')
    assert.equal(await page.$('.options-page--models .options-menu__model-overview'), null)
    const empty = await page.textContent('.options-page--models .options-menu__model-search-empty')
    assert.match(empty ?? '', /Aucun modèle ne correspond à « introuvable »/)
    // La barre reste là pour corriger la recherche.
    await page.fill('.options-menu__model-search', '')
    assert.equal((await models()).length, 3)
  })
})

/** Ligne « Image » du tableau des modèles (étape 174) : son texte, et la ligne d'explication juste dessous. */
async function imageRow(page, pick) {
  if (pick) await page.evaluate((p) => { window.__imagePick = p }, pick)
  await page.click('.options-menu__tab:has-text("Modèles")')
  await page.waitForSelector('.capacity-scan__tier-image')
  return page.evaluate(() => {
    const row = document.querySelector('.capacity-scan__tier-image')
    const next = row.nextElementSibling
    return {
      cells: [...row.cells].map((c) => c.textContent.trim()),
      note: next && next.classList.contains('capacity-scan__tier-upgrade') ? next.textContent.trim() : null,
      afterCode: row.previousElementSibling ? true : false
    }
  })
}

test('Modèles : une ligne « Image » avec le seul modèle d’image quand la machine le fait tourner', options, async () => {
  await withOptions(async (page) => {
    const row = await imageRow(page)
    assert.deepEqual(row.cells, ['Image', 'FLUX.2 klein 4B', '—', '—', ''])
    assert.equal(row.note, "Pas installé sur ce PC pour l'instant — clique « Retester la configuration » (environ 5 Go).", 'pas encore installé : dit, avec le même bouton que les autres modèles')
  })
})

/** Ligne « Vidéo » (04/10/2026, Léo : « ajoute vidéo et le modèle vidéo »). */
async function videoRow(page, pick, ramGb) {
  await page.evaluate(([p, r]) => { if (p) window.__videoPick = p; if (r) window.__ramGb = r }, [pick ?? null, ramGb ?? null])
  await page.click('.options-menu__tab:has-text("Modèles")')
  await page.waitForSelector('.capacity-scan__tier-video')
  return page.evaluate(() => {
    const row = document.querySelector('.capacity-scan__tier-video')
    const next = row.nextElementSibling
    return {
      cells: [...row.cells].map((c) => c.textContent.trim()),
      note: next && next.classList.contains('capacity-scan__tier-upgrade') ? next.textContent.trim() : null,
      afterImage: Boolean(row.previousElementSibling?.closest('tbody') && document.querySelector('.capacity-scan__tier-image') !== row),
      hardware: document.querySelector('.capacity-scan__tier-hardware')?.textContent ?? ''
    }
  })
}

test('Modèles : une ligne « Vidéo » avec le modèle vidéo et sa meilleure qualité, et la RAM arrondie', options, async () => {
  await withOptions(async (page) => {
    const row = await videoRow(page, null, 63.161624908447266)
    assert.deepEqual(row.cells, ['Vidéo', 'FastWan 2.2 TI2V 5B · qualité Moyen', '—', '—', ''])
    assert.equal(row.note, "Pas installé sur ce PC pour l'instant — télécharge-le depuis le mode Vidéo.")
    assert.ok(row.afterImage, 'la ligne Vidéo suit la ligne Image')
    assert.match(row.hardware, /63 Go de RAM/)
    assert.doesNotMatch(row.hardware, /63\.16/)
  })
})

test('Modèles : vidéo impossible → « Aucun modèle », avec la raison', options, async () => {
  await withOptions(async (page) => {
    const row = await videoRow(page, { model: null, qualityLabel: null, quality: null, reason: 'carte graphique trop petite (6 Go de VRAM, il en faut 8 ou plus)' })
    assert.deepEqual(row.cells.slice(0, 2), ['Vidéo', 'Aucun modèle'])
    assert.equal(row.note, 'Pas assez de puissance pour la vidéo : carte graphique trop petite (6 Go de VRAM, il en faut 8 ou plus).')
  })
})

test('Modèles : pas assez de puissance → « Aucun modèle », avec la raison', options, async () => {
  await withOptions(async (page) => {
    const row = await imageRow(page, { model: null, reason: 'carte graphique trop petite (4 Go de VRAM, il en faut 6 ou plus)' })
    assert.equal(row.cells[1], 'Aucun modèle')
    assert.equal(row.note, 'Pas assez de puissance pour dessiner : carte graphique trop petite (4 Go de VRAM, il en faut 6 ou plus).')
  })
})

test('Modèles : modèle d’image déjà téléchargé → aucune note de téléchargement', options, async () => {
  await withOptions(async (page) => {
    const row = await imageRow(page, { model: 'FLUX.2 klein 4B', reason: null, installed: true })
    assert.equal(row.cells[1], 'FLUX.2 klein 4B')
    assert.equal(row.note, null)
  })
})

test('Voix : le test du mot « Jaris » regroupe les essais en tableau — réussites, puis chaque mot raté avec son nombre de fois', options, async () => {
  await withOptions(async (page) => {
    const row = page.locator('.options-menu__row', { hasText: 'Tester le mot « Jaris »' })
    await row.locator('button').click()
    assert.equal(await page.evaluate(() => window.__wakeTest), 'on')
    await page.waitForSelector('.options-menu__wake-test')
    assert.match(await page.textContent('.options-menu__wake-test-summary'), /dis « Jaris »/)

    // Étape 187 (Léo : « fais un tableau avec par exemple réussi 10, Jain 5 fois, Onal 10 fois »).
    await page.evaluate(() => {
      const heard = (text, matched, tooShort = false) => window.__emitWakeHeard({ text, matched, tooShort, peak: 0.5 })
      heard('Jaris.', true)
      heard('Rice.', false)
      heard('Jain', false)
      heard('Jaice.', true)
      heard('Rice?', false)
      heard('', false, true)
    })
    await page.waitForFunction(() => document.querySelectorAll('.options-menu__wake-test-table tbody tr').length === 4)
    assert.equal(await page.textContent('.options-menu__wake-test-summary'), '2 reconnu(s) sur 6')
    const rows = await page.$$eval('.options-menu__wake-test-table tbody tr', (els) =>
      els.map((tr) => [...tr.cells].map((td) => td.textContent).concat(tr.className))
    )
    assert.deepEqual(rows, [
      ['Reconnu', '2', 'options-menu__mic-result--ok'],
      ['« Rice »', '2', 'options-menu__mic-result--bad'],
      ['« Jain »', '1', 'options-menu__mic-result--bad'],
      ['Son trop court ou trop faible', '1', 'options-menu__mic-result--bad']
    ])

    await row.locator('button').click()
    assert.equal(await page.evaluate(() => window.__wakeTest), 'off', 'Arrêter doit vraiment arrêter le test côté Jaris')
    assert.equal(await page.locator('.options-menu__wake-test-table tbody tr').count(), 4, 'le tableau reste lisible après l’arrêt')
  })
})

// Étape 188 (l'ami de Léo : « il parle, il entend rien ») : un test envoyé à une écoute qui charge encore
// ne recevait jamais de réponse, et l'écran restait muet comme si le micro était en cause.
test('Voix : le test micro dit POURQUOI il ne démarre pas quand l’écoute charge encore', options, async () => {
  await withOptions(async (page) => {
    await page.evaluate(() => {
      window.__listeningIssue = "L'écoute démarre encore. Au premier lancement, Jaris télécharge la transcription (environ 2,5 Go) : réessaie dans quelques minutes."
    })
    const row = page.locator('.options-menu__row', { hasText: 'Tester le micro' })
    await row.locator('button').click()
    await page.waitForSelector('.options-menu__voice-test-issue')
    assert.match(await page.textContent('.options-menu__voice-test-issue'), /télécharge la transcription/)
    assert.equal(await row.locator('button').textContent(), 'Tester', 'le bouton ne doit pas rester bloqué sur « Arrêter »')
    assert.equal(await page.locator('.options-menu__mic-bars').count(), 0, 'pas de barres vides qui font croire à un micro muet')

    const color = await page.$eval('.options-menu__voice-test-issue', (el) => getComputedStyle(el).color)
    assert.notEqual(color, 'rgb(0, 0, 0)', 'le message doit être habillé par le CSS de Jaris')

    // Même garde sur le test du mot « Jaris », message affiché sous CE test-là.
    const wakeRow = page.locator('.options-menu__row', { hasText: 'Tester le mot « Jaris »' })
    await wakeRow.locator('button').click()
    await page.waitForFunction(() => document.querySelectorAll('.options-menu__voice-test-issue').length === 1)
    assert.equal(await wakeRow.locator('button').textContent(), 'Tester')
    assert.equal(await page.evaluate(() => window.__wakeTest), undefined)
  })
})

test('Voix : un flux de silence total désigne Windows (micro coupé ou bloqué), un son faible désigne le micro', options, async () => {
  await withOptions(async (page) => {
    const row = page.locator('.options-menu__row', { hasText: 'Tester le micro' })
    await row.locator('button').click()
    assert.equal(await page.evaluate(() => window.__micTest), 'on')
    await page.evaluate(() => window.__emitMicDone({ detected: false, silentStream: true }))
    await page.waitForSelector('.options-menu__mic-result--bad')
    assert.match(await page.textContent('.options-menu__mic-result--bad'), /Confidentialité.*Microphone/)

    await row.locator('button').click()
    await page.evaluate(() => window.__emitMicDone({ detected: false, silentStream: false }))
    await page.waitForFunction(() => /trop faible/.test(document.querySelector('.options-menu__mic-result--bad')?.textContent ?? ''))

    await row.locator('button').click()
    await page.evaluate(() => window.__emitMicDone({ detected: true, silentStream: false }))
    await page.waitForSelector('.options-menu__mic-result--ok')
    assert.match(await page.textContent('.options-menu__mic-result--ok'), /Micro détecté/)
  })
})
