import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, globSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Mise en page du mode Code (étapes 94-97), sur le VRAI composant et le vrai CSS compilé.
 *
 * Léo : "le design de code c'est mal fait, on comprend pas trop les truc recent en bas apres il ya des
 * bouton". Deux défauts mesurés sur une capture réelle avant correction : la liste des applications déjà
 * créées était une suite de lignes sous une micro-étiquette, au-dessus d'un grand vide ; et une fois une
 * application chargée, QUATRE bandes s'empilaient (champ, deux gros boutons, onglets, aperçu) avant
 * d'arriver à l'application.
 *
 * Ce test verrouille ce qui a été corrigé : une seule barre (onglets + actions sur la même ligne, dans le
 * panneau de l'application) et une liste lisible. Un empilement qui reviendrait le ferait échouer.
 *
 * Playwright n'est pas une dépendance du projet (absent du runner Windows de la CI) : chargé en import
 * dynamique, tests explicitement ignorés s'il manque — jamais silencieusement verts.
 */
let chromium = null
try {
  ;({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-code-panel-entry.tsx')

const APP_HTML = '<!DOCTYPE html><html><body><h1>Ma liste</h1></body></html>'

/** Faux pont preload : trois applications déjà générées, et une génération qui répond tout de suite. */
const ENTRY = `
import { createRoot } from 'react-dom/client'
import Panel from './src/components/CodePanel'

const APP = {
  html: ${JSON.stringify(APP_HTML)},
  path: 'C:/Users/leo/Jaris/generated-apps/2026-09-14-liste-de-courses',
  issues: [],
  previewUrl: 'about:blank'
}

window.__apps = [
  { path: 'C:/apps/liste', label: 'liste de courses', timestamp: Date.now() - 3600_000 },
  { path: 'C:/apps/snake', label: 'jeu snake', timestamp: Date.now() - 90_000_000 }
]
window.__deleted = []

window.jaris = {
  // Rappel gardé pour que le test puisse simuler une vraie ligne de journal (voir le test du cadre unique).
  onCodeGenStatus: (cb) => {
    window.__status = cb
    return () => {}
  },
  // Étape 99 : CodePanel s'abonne à l'avancement au montage. Un canal manquant ne donne aucune erreur
  // lisible — l'effet React plante, le composant ne se monte jamais, et le test expire au bout de 30 s
  // sans dire pourquoi (piège déjà vécu à l'étape 96). Le rappel est gardé pour que le test puisse
  // simuler de vrais messages d'avancement, comme le ferait le main process.
  onCodeGenProgress: (cb) => {
    window.__emitProgress = cb
    return () => {}
  },
  getGeneratedApps: () => Promise.resolve(window.__apps),
  // Étape 277 : le bouton GitHub du champ demande l'état de la connexion au montage (masqué si indisponible).
  githubStatus: () => Promise.resolve({ available: false, connected: false, login: null }),
  loadGeneratedApp: (path) => Promise.resolve({ ...APP, path }),
  // Génération pilotée par le test (étape 99) : elle reste EN COURS tant que le test ne la termine pas,
  // seule façon d'observer le bandeau d'avancement, qui n'existe que pendant ce temps-là.
  generateApp: () =>
    new Promise((resolve, reject) => {
      window.__finishGen = () => resolve(APP)
      window.__failGen = (err) => reject(err)
    }),
  cancelCodeGen: () => {
    window.__cancelled = true
    window.__failGen?.(new Error('aborted'))
  },
  openGeneratedApp: () => Promise.resolve(),
  getModelChoice: () => Promise.resolve({ selected: null, installed: [], autoModel: null }),
  setModelChoice: () => Promise.resolve(),
  pickImageFile: () => Promise.resolve(null),
  // Le vrai main process efface le dossier puis la liste est rechargée : simulé à l'identique ici, pour
  // que le test vérifie aussi que la liste affichée se met à jour après la suppression.
  deleteGeneratedApp: (path) => {
    window.__deleted.push(path)
    window.__apps = window.__apps.filter((app) => app.path !== path)
    return Promise.resolve()
  }
}

createRoot(document.getElementById('root')).render(<Panel />)
`

let pageHtml = null
let outDir = null

function buildPage() {
  if (pageHtml) return pageHtml
  outDir = mkdtempSync(join(tmpdir(), 'jaris-code-ui-'))
  const bundlePath = join(outDir, 'bundle.js')

  // L'entrée est écrite DANS le projet (puis supprimée) : esbuild résout node_modules depuis son
  // emplacement. --jsx=automatic parce que le projet est en runtime JSX automatique (React 18).
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
        '--loader:.png=dataurl',
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
  pageHtml = `<!doctype html><html><head><style>
    html,body{margin:0;height:100%;background:#05070c;}
    #root{height:100%;display:flex;}
    ${css}
  </style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  return pageHtml
}

/** try/finally obligatoire : une assertion qui échoue laisserait sinon Chromium ouvert, et `node --test`
 *  ne se terminerait jamais — l'échec ne s'afficherait même pas. */
async function withPage(run, width = 1280) {
  const html = buildPage()
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width, height: 860 })
    await page.setContent(html)
    await page.waitForSelector('.workspace__rail')
    await run(page)
  } finally {
    await browser.close()
  }
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test('les applications déjà créées sont listées en colonne, avec des dates lisibles', options, async () => {
  await withPage(async (page) => {
    assert.equal(await page.locator('.workspace__list li').count(), 2)
    assert.match(await page.textContent('.workspace__new'), /Nouvelle application/i)

    const dates = await page.locator('.workspace__item-meta').allTextContents()
    assert.equal(dates.length, 2)
    // Plus d'horodatage à la seconde ("14/09/2026 15:11:52") : c'était plus long que le nom lui-même.
    for (const date of dates) assert.doesNotMatch(date, /\d{2}:\d{2}:\d{2}/)
    assert.match(dates[0], /Aujourd'hui/)
  })
})

test('conversation à gauche, aperçu à droite, champ de saisie en bas de la conversation (étape 282)', options, async () => {
  // Léo, capture de Claude à l'appui : « pour le code fais chat à gauche et aperçu à droite comme Claude et ChatGPT ».
  await withPage(async (page) => {
    await page.click('.workspace__item')
    await page.waitForSelector('.code-panel__preview')

    const layout = await page.evaluate(() => {
      const box = (selector) => document.querySelector(selector).getBoundingClientRect()
      const chat = box('.code-chat')
      const preview = box('.code-preview')
      return {
        railLeftOfContent: box('.workspace__rail').right <= box('.workspace__main').left + 1,
        chatLeftOfPreview: chat.right <= preview.left + 1,
        sideBySide: Math.abs(chat.top - preview.top) < 2,
        iframeInPreview: document.querySelector('.code-preview').contains(document.querySelector('.code-panel__preview')),
        composerInChat: document.querySelector('.code-chat').lastElementChild.classList.contains('composer'),
        composerAtBottom: Math.abs(box('.composer').bottom - chat.bottom) < 24,
        previewWiderThanChat: preview.width > chat.width
      }
    })
    assert.deepEqual(layout, {
      railLeftOfContent: true,
      chatLeftOfPreview: true,
      sideBySide: true,
      iframeInPreview: true,
      composerInChat: true,
      composerAtBottom: true,
      previewWiderThanChat: true
    })
  })
})

test('la conversation garde les demandes ; le bandeau de fin rejoint l’historique à la demande suivante', options, async () => {
  await withPage(async (page) => {
    await startGeneration(page)
    assert.equal(await page.textContent('.code-chat__user'), 'une liste de courses')
    // La demande n'est plus en double : le champ est vidé dès l'envoi, comme ChatGPT.
    assert.equal(await page.inputValue('.composer__input'), '')
    await page.evaluate(() => window.__finishGen())
    await page.waitForSelector('.code-panel__done')
    // Deuxième demande : la fin de la première ne disparaît pas, elle devient un message de la conversation.
    await page.fill('.composer textarea', 'ajoute un mode sombre')
    await page.click('.composer__send')
    await page.waitForSelector('.code-panel__live')
    const thread = await page.locator('.code-chat__thread > *').evaluateAll((nodes) => nodes.map((n) => n.className.split(' ')[0]))
    assert.deepEqual(thread.slice(0, 3), ['code-chat__user', 'code-chat__reply', 'code-chat__user'])
    assert.match(await page.textContent('.code-chat__reply'), /Terminé en \d+ s/)
  })
})

test('fenêtre étroite : l’aperçu passe au-dessus de la conversation, sans débordement', options, async () => {
  await withPage(async (page) => {
    await page.click('.workspace__item')
    await page.waitForSelector('.code-panel__preview')
    const layout = await page.evaluate(() => {
      const chat = document.querySelector('.code-chat').getBoundingClientRect()
      const preview = document.querySelector('.code-preview').getBoundingClientRect()
      return { previewAbove: preview.bottom <= chat.top + 1, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }
    })
    assert.deepEqual(layout, { previewAbove: true, overflow: 0 })
  }, 760)
})

test('la poignée règle la taille de l’aperçu, sans jamais écraser une colonne (étape 283)', options, async () => {
  // Léo : « pouvoir régler la taille de l'aperçu ».
  await withPage(async (page) => {
    await page.click('.workspace__item')
    await page.waitForSelector('.code-panel__preview')
    const widths = () =>
      page.evaluate(() => ({
        chat: Math.round(document.querySelector('.code-chat').getBoundingClientRect().width),
        preview: Math.round(document.querySelector('.code-preview').getBoundingClientRect().width),
        split: Math.round(document.querySelector('.code-split').getBoundingClientRect().width)
      }))
    const handle = await page.locator('.code-split__handle').boundingBox()
    const y = handle.y + handle.height / 2
    const start = await widths()

    // Glisser de 200 px vers la droite, en passant AU-DESSUS de l'aperçu (une iframe avalerait les mouvements).
    await page.mouse.move(handle.x + handle.width / 2, y)
    await page.mouse.down()
    await page.mouse.move(handle.x + 100, y, { steps: 5 })
    await page.mouse.move(handle.x + handle.width / 2 + 200, y, { steps: 5 })
    await page.mouse.up()
    const dragged = await widths()
    assert.ok(Math.abs(dragged.chat - (start.chat + 200)) <= 6, `conversation : ${start.chat} → ${dragged.chat}`)
    assert.ok(dragged.preview < start.preview - 150, 'l’aperçu n’a pas rétréci')

    // Tout à droite : l'aperçu garde 360 px. Tout à gauche : la conversation garde 300 px.
    let box = await page.locator('.code-split__handle').boundingBox()
    await page.mouse.move(box.x + box.width / 2, y)
    await page.mouse.down()
    await page.mouse.move(2000, y, { steps: 4 })
    await page.mouse.up()
    assert.ok((await widths()).preview >= 355, `aperçu écrasé : ${(await widths()).preview}`)
    box = await page.locator('.code-split__handle').boundingBox()
    await page.mouse.move(box.x + box.width / 2, y)
    await page.mouse.down()
    await page.mouse.move(0, y, { steps: 4 })
    await page.mouse.up()
    assert.ok((await widths()).chat >= 299, `conversation écrasée : ${(await widths()).chat}`)

    // Clavier : flèche droite = 24 px de plus.
    const before = (await widths()).chat
    await page.focus('.code-split__handle')
    await page.keyboard.press('ArrowRight')
    assert.equal((await widths()).chat, before + 24)

    // Double-clic : retour à la taille d'origine.
    box = await page.locator('.code-split__handle').boundingBox()
    await page.mouse.dblclick(box.x + box.width / 2, y)
    assert.equal((await widths()).chat, start.chat)

    // Largeur maximale choisie sur une grande fenêtre, puis fenêtre réduite : l'aperçu garde quand même 360 px.
    await page.setViewportSize({ width: 1600, height: 860 })
    box = await page.locator('.code-split__handle').boundingBox()
    await page.mouse.move(box.x + box.width / 2, y)
    await page.mouse.down()
    await page.mouse.move(2000, y, { steps: 4 })
    await page.mouse.up()
    await page.setViewportSize({ width: 1280, height: 860 })
    assert.ok((await widths()).preview >= 355, `aperçu écrasé après réduction : ${(await widths()).preview}`)
  })
})

test('la taille choisie est retenue d’une ouverture à l’autre ; pas de poignée en fenêtre étroite', options, async () => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 860 })
    // Servie depuis une vraie adresse : sur about:blank, le stockage du navigateur est refusé.
    await page.route('http://localhost/', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: buildPage() }))
    await page.goto('http://localhost/')
    await page.waitForSelector('.code-split__handle')
    await page.focus('.code-split__handle')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    const chosen = await page.evaluate(() => Math.round(document.querySelector('.code-chat').getBoundingClientRect().width))
    await page.reload()
    await page.waitForSelector('.code-split__handle')
    assert.equal(await page.evaluate(() => Math.round(document.querySelector('.code-chat').getBoundingClientRect().width)), chosen)

    await page.setViewportSize({ width: 760, height: 860 })
    await page.click('.workspace__item')
    await page.waitForSelector('.code-panel__preview')
    assert.equal(await page.isVisible('.code-split__handle'), false)
  } finally {
    await browser.close()
  }
})

test('supprimer demande confirmation, puis retire vraiment la ligne', options, async () => {
  await withPage(async (page) => {
    assert.equal(await page.locator('.workspace__list li').count(), 2)

    // Un simple clic sur la corbeille ne supprime RIEN : effacer un dossier est définitif.
    await page.click('.workspace__list li:first-child .workspace__delete')
    await page.waitForSelector('.workspace__confirm')
    assert.match(await page.textContent('.workspace__confirm span'), /liste de courses/)
    assert.deepEqual(await page.evaluate(() => window.__deleted), [])

    // Annuler laisse la ligne intacte.
    await page.click('.workspace__confirm-no')
    assert.equal(await page.locator('.workspace__confirm').count(), 0)
    assert.equal(await page.locator('.workspace__list li').count(), 2)
    assert.deepEqual(await page.evaluate(() => window.__deleted), [])

    // Confirmer supprime, et la liste affichée se met à jour.
    await page.click('.workspace__list li:first-child .workspace__delete')
    await page.click('.workspace__confirm-yes')
    await page.waitForFunction(() => document.querySelectorAll('.workspace__list li').length === 1)
    assert.deepEqual(await page.evaluate(() => window.__deleted), ['C:/apps/liste'])
    assert.match(await page.textContent('.workspace__list li'), /jeu snake/)
  })
})

test("la corbeille d'une ligne n'ouvre jamais l'application par erreur", options, async () => {
  await withPage(async (page) => {
    // Les deux boutons sont dans la MÊME ligne : un clic sur la corbeille ne doit pas déclencher l'ouverture
    // (ce qui arriverait si la corbeille était imbriquée dans le bouton d'ouverture).
    await page.click('.workspace__list li:first-child .workspace__delete')
    assert.equal(await page.locator('.code-panel__preview').count(), 0)
  })
})

test('cliquer une application de la liste la rouvre', options, async () => {
  await withPage(async (page) => {
    await page.click('.workspace__item')
    await page.waitForSelector('.code-panel__preview')
    // La liste reste visible à gauche pendant qu'on regarde l'application (contrairement à l'étape 94, où
    // elle disparaissait dès qu'une application était chargée), et la ligne ouverte est signalée.
    assert.equal(await page.locator('.workspace__item--active').count(), 1)
  })
})

for (const width of [1280, 760]) {
  test(`onglets et actions tiennent sur UNE seule barre, dans le panneau (${width}px)`, options, async () => {
    await withPage(async (page) => {
      await page.click('.workspace__item')
      await page.waitForSelector('.code-panel__preview')

      const layout = await page.evaluate(() => {
        const box = (selector) => {
          const el = document.querySelector(selector)
          return el ? el.getBoundingClientRect() : null
        }
        const tabs = box('.code-panel__view-tabs')
        const actions = box('.code-panel__result-actions')
        const preview = box('.code-panel__preview')
        return {
          sameRow: Math.abs(tabs.top - actions.top) < 8,
          actionsInsideResult: document.querySelector('.code-panel__result').contains(document.querySelector('.code-panel__result-actions')),
          // Les actions étaient à gauche sous le composeur : elles sont maintenant à droite des onglets.
          actionsAfterTabs: actions.left > tabs.right,
          barAbovePreview: tabs.bottom <= preview.top,
          horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          previewHeight: Math.round(preview.height)
        }
      })

      assert.equal(layout.sameRow, true, 'les actions ne sont plus sur la même ligne que les onglets')
      assert.equal(layout.actionsInsideResult, true, "les actions flottent hors du panneau de l'application")
      assert.equal(layout.actionsAfterTabs, true)
      assert.equal(layout.barAbovePreview, true)
      assert.equal(layout.horizontalOverflow, 0, 'la barre déborde en largeur')
      // L'aperçu doit rester le plus gros élément de l'écran, pas être écrasé par ses commandes.
      assert.ok(layout.previewHeight > 400, `aperçu écrasé : ${layout.previewHeight}px`)
    }, width)
  })
}

/** Lance une génération et attend que le bandeau d'avancement apparaisse. */
async function startGeneration(page) {
  await page.fill('.composer__input', 'une liste de courses')
  await page.click('.composer__send')
  await page.waitForSelector('.code-panel__live')
}

test("pendant une génération, l'écran dit où on en est au lieu de rester figé", options, async () => {
  // Le retour de Léo, mot pour mot : "on ne sait pas quand c'est terminé et des fois c'est bloqué et ça
  // fait rien". Avant l'étape 99, ce bandeau n'existait pas : seul un bouton grisé "Génération…" restait
  // affiché, parfois plusieurs minutes, sans rien d'autre.
  await withPage(async (page) => {
    await startGeneration(page)
    assert.match(await page.textContent('.code-panel__live-title'), /Préparation/)

    await page.evaluate(() =>
      window.__emitProgress({
        label: "Écriture de l'application",
        stepIndex: 1,
        stepCount: 2,
        charsWritten: 4210,
        thinking: false,
        idleMs: 0
      })
    )
    assert.equal(await page.textContent('.code-panel__live-title'), "Étape 1 sur 2 · Écriture de l'application")
    assert.match((await page.textContent('.code-panel__live-detail')).replace(/\s/g, ' '), /4 210 caractères écrits/)

    // Un silence prolongé est DIT, au lieu de laisser un écran immobile sans explication.
    await page.evaluate(() =>
      window.__emitProgress({
        label: "Écriture de l'application",
        stepIndex: 1,
        stepCount: 2,
        charsWritten: 4210,
        thinking: false,
        idleMs: 45_000
      })
    )
    assert.match(await page.textContent('.code-panel__live-detail'), /rien reçu du modèle depuis 45 s/)
  })
})

test('le bouton "Arrêter" arrête vraiment, et ne laisse pas une erreur rouge', options, async () => {
  await withPage(async (page) => {
    await startGeneration(page)

    // Le nom de classe présent dans le JSX ne prouve pas que le CSS s'y applique (piège du bouton resté
    // gris, étape 97) : on mesure le style RÉELLEMENT calculé.
    const style = await page.evaluate(() => {
      const css = getComputedStyle(document.querySelector('.code-panel__live-stop'))
      return { radius: css.borderTopLeftRadius, font: css.fontFamily, transform: css.textTransform }
    })
    // Refonte « design sobre » : la famille de boutons est une pilule en Geist, sans capitales.
    assert.equal(style.radius, '9999px', 'le bouton Arrêter est resté au style par défaut du navigateur')
    assert.match(style.font, /Geist/)
    assert.equal(style.transform, 'none')

    await page.click('.code-panel__live-stop')
    assert.equal(await page.evaluate(() => window.__cancelled), true)

    // L'arrêt est une décision de l'utilisateur, pas une panne : il s'annonce dans le bandeau, à la place
    // même de l'avancement qu'il interrompt, jamais en rouge.
    await page.waitForSelector('.code-panel__done')
    assert.match(await page.textContent('.code-panel__done'), /Génération arrêtée après \d+ s/)
    assert.equal(await page.locator('.code-panel__error').count(), 0)
    assert.equal(await page.locator('.code-panel__live').count(), 0)
    // Neutre, et surtout pas la couleur de succès : ce n'est pas une application livrée.
    const stopped = await page.evaluate(() => {
      const css = getComputedStyle(document.querySelector('.code-panel__done'))
      return { color: css.color, shadow: css.boxShadow }
    })
    assert.doesNotMatch(stopped.color, /49, 255, 176/)
    assert.equal(stopped.shadow, 'none')
  })
})

test('une génération terminée annonce sa durée', options, async () => {
  await withPage(async (page) => {
    await startGeneration(page)
    await page.evaluate(() => window.__finishGen())
    await page.waitForSelector('.code-panel__done')
    assert.match(await page.textContent('.code-panel__done'), /Terminé en \d+ s/)
    assert.equal(await page.locator('.code-panel__live').count(), 0)
  })
})

test("pendant une génération, UN SEUL cadre s'affiche", options, async () => {
  // Léo : "c'est bizarre il y a étape 2 etc. plus un autre rectangle". Le journal répétait les étapes du
  // bandeau et s'affichait même vide, ce qui donnait deux cadres côte à côte pour la même information.
  await withPage(async (page) => {
    await startGeneration(page)
    assert.equal(await page.locator('.code-panel__live').count(), 1)
    assert.equal(await page.locator('.code-panel__status').count(), 0, 'un second cadre (vide) est affiché')

    // Le journal ne revient QUE pour ce que le bandeau ne dit pas — ici, des problèmes réparés.
    await page.evaluate(() => window.__status('2 problème(s) trouvé(s) dans le code, corrigé(s) automatiquement.'))
    assert.equal(await page.locator('.code-panel__status').count(), 1)
    const log = await page.textContent('.code-panel__status')
    assert.doesNotMatch(log, /Génération de l'application|Relecture du code/, 'le journal répète encore les étapes')
  })
})

test("changer d'application efface le bandeau de la génération précédente", options, async () => {
  // Léo : "quand on est dans code on change de conversation ça change pas Terminé en 7 min 56 — ton
  // application est à jour". Le bandeau décrit UNE génération : affiché au-dessus d'une autre application,
  // il affirme quelque chose de faux sur celle qu'on regarde.
  await withPage(async (page) => {
    await startGeneration(page)
    await page.evaluate(() => {
      window.__status('2 problème(s) trouvé(s) dans le code, corrigé(s) automatiquement.')
      window.__finishGen()
    })
    await page.waitForSelector('.code-panel__done')

    // Ouvrir une AUTRE application depuis la colonne de gauche.
    await page.click('.workspace__list li:nth-child(2) .workspace__item')
    await page.waitForFunction(() => document.querySelectorAll('.code-panel__done').length === 0)
    assert.equal(await page.locator('.code-panel__status').count(), 0, 'le journal de la génération précédente est resté')
  })
})

test('"Nouvelle application" repart d\'un écran propre', options, async () => {
  await withPage(async (page) => {
    await startGeneration(page)
    await page.evaluate(() => window.__finishGen())
    await page.waitForSelector('.code-panel__done')

    await page.click('.workspace__new')
    await page.waitForFunction(() => document.querySelectorAll('.code-panel__done').length === 0)
  })
})

test.after(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})
