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

// Simule l'IPC runModelAnalysis/onModelBenchmarkLine (useModelAnalysis.ts) pour tester le bouton "Lancer
// l'analyse" (AllModelsOverview.tsx) sans jamais lancer de vrai processus : un run reste "en cours" tant que
// window.__releaseAnalysis() n'a pas été appelé depuis le test, pour observer l'état intermédiaire.
const benchmarkListeners = new Set()
let releaseAnalysis = null
window.__releaseAnalysis = () => releaseAnalysis && releaseAnalysis()
window.__overviewCallCount = 0

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
  previewHardwareTiers: async () => [],
  getModelOverview: async () => {
    window.__overviewCallCount += 1
    // Score frais UNIQUEMENT après un run terminé (2e appel ou plus) : vérifie que le tableau se rafraîchit
    // vraiment avec le résultat du run, pas juste avec les mêmes données statiques rechargées à l'identique.
    const toolCalling = window.__overviewCallCount > 1 ? '5/6' : null
    return {
      vramGb: 8,
      codeModel: 'qwen2.5-coder:7b',
      groups: [
        {
          tier: 'Rapide',
          entries: [
            { model: 'ministral-3:3b', vramGb: 3.0, usedIn: ['Rapide', 'Médium'], speedTokPerSec: 120.4, toolCalling: '6/6', intelligence: null, artificialAnalysisIndex: 5 },
            { model: 'qwen3:1.7b', vramGb: 2, usedIn: [], speedTokPerSec: 200.1, toolCalling, intelligence: null, artificialAnalysisIndex: null }
          ]
        },
        {
          tier: 'Vision',
          entries: [{ model: 'gemma4:31b', vramGb: 20, usedIn: ['Vision'], speedTokPerSec: null, toolCalling: null, intelligence: null, artificialAnalysisIndex: null }]
        }
      ]
    }
  },
  onModelBenchmarkLine: (cb) => {
    benchmarkListeners.add(cb)
    return () => benchmarkListeners.delete(cb)
  },
  runModelAnalysis: async (scope) => {
    window.__lastAnalysisScope = scope
    benchmarkListeners.forEach((cb) => cb('##MODEL_TESTING## qwen3:1.7b'))
    await new Promise((resolve) => {
      releaseAnalysis = resolve
    })
    benchmarkListeners.forEach((cb) => cb('##MODEL_DONE## qwen3:1.7b 5 6'))
    return {
      gpuName: 'Test GPU',
      vramGb: 8,
      models: { flash: 'qwen3:1.7b', medium: 'qwen3:1.7b', large: 'qwen3:1.7b' },
      visionModel: 'gemma4:31b',
      codeModel: 'qwen2.5-coder:7b'
    }
  }
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

    const groupTitles = await page.$$eval('.options-page--models .options-menu__model-group-title', (els) => els.map((el) => el.textContent))
    assert.deepEqual(groupTitles, ['Rapide', 'Vision'], `paliers affichés : ${groupTitles.join(', ')}`)

    const rows = await page.$$eval('.options-page--models tbody tr', (els) =>
      els.map((el) => Array.from(el.querySelectorAll('td')).map((td) => td.textContent?.trim()))
    )
    assert.equal(rows.length, 3, `3 modèles attendus (2 Rapide + 1 Vision) : ${rows.length}`)
    // ministral-3:3b : utilisé pour deux paliers, VRAM et Intelligence Index officiel (5).
    assert.equal(rows[0][1], 'Oui — Rapide, Médium', `paliers actifs attendus : ${rows[0][1]}`)
    assert.ok(rows[0][2].includes('3'), `VRAM du premier modèle : ${rows[0][2]}`)
    assert.equal(rows[0][4], '5', `Intelligence Index attendu (5) : ${rows[0][4]}`)
    // qwen3:1.7b : aucun score officiel connu, clairement indiqué sans chiffre inventé.
    assert.equal(rows[1][1], 'Non', `le modèle non retenu doit être indiqué : ${rows[1][1]}`)
    assert.equal(rows[1][4], 'Non publié', `absence de score officiel attendue : ${rows[1][4]}`)

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
      return { background: s.backgroundImage, clip: s.clipPath }
    })
    assert.match(style.background, /gradient/, 'bouton sans le fond de la famille HUD')
    assert.match(style.clip, /polygon/, 'bouton sans les coins coupés de la famille HUD')
  })
})

// Léo : "il manque encore des scores d'intelligence et ajoute le bouton dans cette mis a jour pour que j'analyse et
// je te donne les appelle outils pour ceux que je peut" — le bouton "Lancer l'analyse" (useModelAnalysis +
// ModelAnalysisProgress, existants mais jamais rendus nulle part avant ce correctif) doit réellement se
// déclencher, afficher un suivi en direct PENDANT le run (un seul cadre à la fois, jamais les deux tableaux
// en même temps — même discipline que l'étape 101 du changelog), puis rafraîchir le tableau avec les
// VRAIS résultats une fois terminé.
test('"Lancer l\'analyse" affiche un suivi en direct puis rafraîchit le tableau avec les résultats du run', options, async () => {
  await withOptions(async (page) => {
    await page.click('.options-menu__tab:has-text("Modèles")')
    await page.click('.options-menu__all-models button:has-text("Tous les modèles")')
    await page.waitForSelector('.options-page--models .options-menu__model-overview')

    // Avant le run : le tableau STATIQUE avec l'Intelligence Index officiel, aucun suivi en direct.
    const headersBefore = await page.$$eval('.options-page--models thead th', (els) => els.map((el) => el.textContent))
    assert.ok(headersBefore.includes('Utilisé par Jaris'), `colonne d'utilisation attendue : ${headersBefore.join(', ')}`)
    assert.ok(headersBefore.includes('Intelligence (Artificial Analysis)'), `tableau statique attendu avant le run : ${headersBefore.join(', ')}`)
    assert.equal(await page.$('.options-menu__progress'), null, 'aucune barre de progression avant le clic')

    await page.click('.options-page--models .options-menu__all-models-analysis button:has-text("Lancer l\'analyse")')
    await page.waitForSelector('.options-menu__progress')

    // Pendant le run : UN SEUL cadre affiché, celui du suivi en direct (colonnes Fiabilité connue/Statut),
    // jamais le tableau statique en même temps à côté (étape 101 : deux cadres qui racontent la même chose).
    // Deux paliers dans le mock (Rapide + Vision), donc ces 3 en-têtes reviennent une fois par groupe — dédupliqués
    // ici, ce qui compte est qu'AUCUN autre jeu d'en-têtes (celui du tableau statique) n'apparaisse en même temps.
    const headersDuring = await page.$$eval('.options-page--models thead th', (els) => [...new Set(els.map((el) => el.textContent))])
    assert.deepEqual(headersDuring, ['Modèle', 'Fiabilité connue', 'Statut'], `un seul tableau (suivi en direct) attendu pendant le run : ${headersDuring.join(', ')}`)
    assert.equal(await page.$('.options-page--models .options-menu__col-num:has-text("Intelligence (Artificial Analysis)")'), null, 'le tableau statique ne doit pas rester affiché pendant le run')

    const scope = await page.evaluate(() => window.__lastAnalysisScope)
    assert.equal(scope, 'all', `périmètre 'all' attendu (Léo dit "LE bouton", singulier) : ${scope}`)

    // Débloque le run simulé (voir runModelAnalysis dans le pont de test) et attend le retour au tableau statique.
    await page.evaluate(() => window.__releaseAnalysis())
    await page.waitForSelector('.options-page--models .options-menu__model-overview thead th:has-text("Intelligence (Artificial Analysis)")')

    // Le tableau doit refléter le RÉSULTAT FRAIS du run (getModelOverview rappelé après coup) : qwen3:1.7b
    // passe de "—" (aucun score connu) à "5/6" une fois le run terminé, sans recharger la page.
    const rows = await page.$$eval('.options-page--models tbody tr', (els) =>
      els.map((el) => Array.from(el.querySelectorAll('td')).map((td) => td.textContent?.trim()))
    )
    const qwenRow = rows.find((r) => r[0] === 'qwen3:1.7b')
    assert.ok(qwenRow, `ligne qwen3:1.7b introuvable après rafraîchissement : ${JSON.stringify(rows)}`)
    assert.equal(qwenRow[3], '5/6', `score d'appel d'outils frais attendu (5/6) : ${qwenRow[3]}`)
  })
})
