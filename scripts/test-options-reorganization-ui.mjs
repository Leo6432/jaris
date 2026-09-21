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
  previewHardwareTiers: async () => [],
  getModelOverview: async () => ({
    vramGb: 8,
    codeModel: 'qwen2.5-coder:7b',
    groups: [
      {
        tier: 'Rapide',
        entries: [
          { model: 'ministral-3:3b', vramGb: 3.0, usedIn: ['Rapide', 'Médium'], toolCalling: '6/6', intelligence: null, artificialAnalysisIndex: 5 },
          { model: 'qwen3:1.7b', vramGb: 2, usedIn: [], toolCalling: null, intelligence: null, artificialAnalysisIndex: null }
        ]
      },
      {
        tier: 'Vision',
        entries: [{ model: 'gemma4:31b', vramGb: 20, usedIn: ['Vision'], toolCalling: null, intelligence: null, artificialAnalysisIndex: null }]
      }
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
    // "Vitesse (Artificial Analysis)" (nouveau champ, étape 122) : "—" quand Artificial Analysis n'a pas
    // publié de mesure de vitesse fiable pour ce modèle.
    assert.equal(rows[0][5], '—', `Vitesse doit rester "—" sans mesure publiée : ${rows[0][5]}`)
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

// Léo, relayant un avis de ChatGPT : "enleve le bouton lancer l'analyse pour le public c'est pas bien" —
// le bouton "Lancer l'analyse" (ajouté puis restauré dans une étape précédente) déclenchait potentiellement
// des dizaines de Go de téléchargement et un run de plusieurs dizaines de minutes, sans garde-fou pour
// quelqu'un qui ne sait pas ce qu'il fait. Retiré de l'interface (le canal IPC/le composant
// ModelAnalysisProgress.tsx restent intacts, juste plus exposés ici) : ce test vérifie que la page "Tous
// les modèles" affiche bien le tableau statique SANS jamais montrer ce bouton ni le moindre suivi en direct.
test('le bouton "Lancer l\'analyse" a disparu de "Tous les modèles" — seul le tableau statique reste', options, async () => {
  await withOptions(async (page) => {
    await page.click('.options-menu__tab:has-text("Modèles")')
    await page.click('.options-menu__all-models button:has-text("Tous les modèles")')
    await page.waitForSelector('.options-page--models .options-menu__model-overview')

    const buttonTexts = await page.$$eval('.options-page--models button', (els) => els.map((el) => el.textContent?.trim()))
    assert.ok(!buttonTexts.some((t) => t?.includes("Lancer l'analyse")), `le bouton "Lancer l'analyse" ne doit plus exister : ${buttonTexts.join(', ')}`)
    assert.equal(await page.$('.options-menu__progress'), null, 'aucune barre de progression ne doit jamais apparaître ici')

    // Comparaison par SOUS-CHAÎNE, pas égalité stricte : les colonnes triables portent depuis l'étape 129 un
    // indicateur permanent (" ↕"/" ▲"/" ▼") collé au titre, qui n'a rien à voir avec ce que ce test vérifie.
    const headers = await page.$$eval('.options-page--models thead th', (els) => els.map((el) => el.textContent))
    assert.ok(headers.includes('Utilisé par Jaris'), `colonne d'utilisation attendue : ${headers.join(', ')}`)
    assert.ok(
      headers.some((h) => h?.includes('Intelligence (Artificial Analysis)')),
      `tableau statique attendu : ${headers.join(', ')}`
    )
  })
})

// Léo, étape 129, sur la première version où SEULS les titres de colonne étaient cliquables : "je voit pas
// de truc pour filtrés dans tout les models". Le tri marchait (le test ci-dessous le prouvait déjà), mais
// rien ne le SIGNALAIT : un titre cliquable avait exactement la même police, la même couleur et la même
// taille qu'un titre normal. Ce test vérifie la COMMANDE VISIBLE, pas seulement le mécanisme — c'est
// précisément la distinction qui manquait pour attraper le problème avant livraison.
test('une barre "Trier par" VISIBLE propose les 4 critères, sans avoir à deviner que les titres sont cliquables', options, async () => {
  await withOptions(async (page) => {
    await page.click('.options-menu__tab:has-text("Modèles")')
    await page.click('.options-menu__all-models button:has-text("Tous les modèles")')
    await page.waitForSelector('.options-page--models .options-menu__model-overview')

    const chips = await page.$$eval('.options-page--models .options-menu__sort-chip', (els) => els.map((el) => el.textContent?.trim()))
    assert.deepEqual(chips, ['VRAM', "Appel d'outils", 'Intelligence', 'Vitesse', 'Par défaut'], `pastilles de tri attendues : ${chips.join(', ')}`)

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

    const rapideModels = () =>
      page.$$eval('.options-page--models .options-menu__model-group', (groups) => {
        const rapide = groups.find((g) => g.querySelector('.options-menu__model-group-title')?.textContent === 'Rapide')
        return Array.from(rapide.querySelectorAll('tbody tr')).map((tr) => tr.querySelector('.options-menu__model-name')?.title)
      })

    // Ordre par défaut (aucun tri actif) : celui renvoyé tel quel par getModelOverview, ministral-3:3b avant
    // qwen3:1.7b dans le faux pont de ce test.
    assert.deepEqual(await rapideModels(), ['ministral-3:3b', 'qwen3:1.7b'], 'ordre par défaut inattendu')

    // Premier clic sur "VRAM nécessaire" : croissante par défaut (Léo : "de la moin de vram a la plus") —
    // qwen3:1.7b (2 Go) doit passer devant ministral-3:3b (3 Go).
    await page.locator('.options-menu__sort-button', { hasText: 'VRAM nécessaire' }).first().click()
    assert.deepEqual(await rapideModels(), ['qwen3:1.7b', 'ministral-3:3b'], 'tri croissant par VRAM attendu au premier clic')

    // Second clic sur la MÊME colonne : inverse le sens plutôt que de rester bloqué en croissant.
    await page.locator('.options-menu__sort-button', { hasText: 'VRAM nécessaire' }).first().click()
    assert.deepEqual(await rapideModels(), ['ministral-3:3b', 'qwen3:1.7b'], 'un second clic doit inverser le sens du tri')

    // "Appel d'outils" : décroissant par défaut (Léo : "le plus appelle outils" — la meilleure valeur en
    // tête). qwen3:1.7b (aucun score connu, null) doit toujours finir en dernier, jamais remonter en tête
    // par erreur — sinon un modèle jamais testé se ferait passer pour "le meilleur en appel d'outils".
    await page.locator('.options-menu__sort-button', { hasText: "Appel d'outils" }).first().click()
    assert.deepEqual(await rapideModels(), ['ministral-3:3b', 'qwen3:1.7b'], 'un score absent doit toujours finir en fin de tri')
  })
})
