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

// __presetApps : la liste telle qu'un redémarrage la retrouve (test des conversations conservées, étape 288).
window.__apps = window.__presetApps ?? [
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
  // Étape 286 : chaque action sur un fichier, pour que le test simule « Modifié index.html +500 −3 ».
  onCodeGenActivity: (cb) => {
    window.__emitActivity = cb
    return () => {}
  },
  // Étape 286 : la phrase de l'agent, écrite en direct dans la conversation.
  onCodeGenNarration: (cb) => {
    window.__emitNarration = cb
    return () => {}
  },
  // Étape 288 : le fichier que Jaris écrit en ce moment, et ses lignes (« Écrit index.html +20 lignes »).
  onCodeGenLive: (cb) => {
    window.__emitLive = cb
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

// Étape 285 : la même structure que App.tsx autour de l'écran — barre latérale qui accueille la liste par
// portail, barre de titre dont le titre est écrit par l'écran, bandeau éventuel, enveloppe KeepAlive —, pour
// mesurer la carte d'aperçu par rapport à la VRAIE barre de Jaris. Sans la barre latérale, la liste s'afficherait
// à gauche de l'écran et le bouton de la barre tomberait au-dessus d'elle, pas au-dessus de la conversation.
import { useState } from 'react'
import { ShellSlotsContext } from './src/lib/shellContext'

const shell = window.__shell
if (shell?.label) window.__apps[0].label = shell.label

function Shell() {
  const [newSlot, setNewSlot] = useState(null)
  const [recentsSlot, setRecentsSlot] = useState(null)
  const [titleSlot, setTitleSlot] = useState(null)
  return (
    <ShellSlotsContext.Provider value={{ newSlot, recentsSlot, titleSlot }}>
      <aside className="app-sidebar" style={{ width: 240, flex: '0 0 240px' }}>
        <div className="panel__new" ref={setNewSlot} />
        <div className="panel__list" ref={setRecentsSlot} />
      </aside>
      <main className="app-main">
        <header className="app-header">
          <button className="panel__icon-button shell-toggle" onClick={() => { window.__toggled = (window.__toggled ?? 0) + 1 }}>≡</button>
          <span className="app-header__title" ref={setTitleSlot} data-label="Code" />
        </header>
        {shell.banner && <div className="app__new-models"><p>Nouveau modèle disponible : qwen3.5:9b.</p><button>Fermer</button></div>}
        <div className="keep-alive" style={{ display: 'contents' }} aria-hidden="false">
          <Panel />
        </div>
      </main>
    </ShellSlotsContext.Provider>
  )
}

createRoot(document.getElementById('root')).render(shell ? <Shell /> : <Panel />)
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
    await page.waitForSelector('.code-chat__live')
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
  test(`titre, onglets et actions tiennent sur UNE seule barre, en haut de la carte (${width}px)`, options, async () => {
    await withPage(async (page) => {
      await page.click('.workspace__item')
      await page.waitForSelector('.code-panel__preview')

      const layout = await page.evaluate(() => {
        const box = (selector) => document.querySelector(selector).getBoundingClientRect()
        const head = box('.code-preview__head')
        const title = box('.code-preview__title')
        const tabs = box('.code-panel__view-tabs')
        const tools = box('.code-preview__tools')
        const preview = box('.code-panel__preview')
        const inHead = (r) => r.top >= head.top - 1 && r.bottom <= head.bottom + 1
        return {
          title: document.querySelector('.code-preview__title').textContent,
          allInHead: inHead(title) && inHead(tabs) && inHead(tools),
          headInsideCard: document.querySelector('.code-preview__card').contains(document.querySelector('.code-preview__head')),
          // Le nom à gauche, les commandes à droite, comme la barre des aperçus de Claude.
          titleLeftOfTabs: title.right <= tabs.left,
          toolsAtRightEdge: Math.abs(box('.code-preview__card').right - tools.right) < 16,
          headAbovePreview: head.bottom <= preview.top + 1,
          horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          previewHeight: Math.round(preview.height)
        }
      })

      assert.equal(layout.title, 'liste de courses', 'le titre de la carte ne nomme pas l’application ouverte')
      assert.equal(layout.allInHead, true, 'le titre, les onglets et les actions ne sont plus sur la même barre')
      assert.equal(layout.headInsideCard, true, 'la barre flotte hors de la carte')
      assert.equal(layout.titleLeftOfTabs, true)
      assert.equal(layout.toolsAtRightEdge, true, 'les commandes ne sont pas collées à droite')
      assert.equal(layout.headAbovePreview, true)
      assert.equal(layout.horizontalOverflow, 0, 'la barre déborde en largeur')
      // L'aperçu doit rester le plus gros élément de l'écran, pas être écrasé par ses commandes.
      assert.ok(layout.previewHeight > 400, `aperçu écrasé : ${layout.previewHeight}px`)
    }, width)
  })
}

test('l’aperçu est une carte encadrée, sans second cadre autour de l’application (étape 284)', options, async () => {
  // Léo, capture de Claude à l'appui : « fais exactement comme ça avec un contour ».
  await withPage(async (page) => {
    await page.click('.workspace__item')
    await page.waitForSelector('.code-panel__preview')
    const card = await page.evaluate(() => {
      const el = document.querySelector('.code-preview__card')
      const style = getComputedStyle(el)
      const frame = document.querySelector('.code-panel__preview')
      const cardBox = el.getBoundingClientRect()
      const frameBox = frame.getBoundingClientRect()
      const preview = document.querySelector('.code-preview').getBoundingClientRect()
      return {
        border: style.borderTopWidth + ' ' + style.borderTopStyle,
        borderVisible: style.borderTopColor !== 'rgba(0, 0, 0, 0)',
        radius: parseFloat(style.borderTopLeftRadius),
        clipsCorners: style.overflow === 'hidden',
        background: style.backgroundColor,
        // Détachée du bord de la zone, comme chez Claude (pas collée au bord de la fenêtre).
        inset: Math.round(cardBox.top - preview.top),
        frameBorder: getComputedStyle(frame).borderTopWidth,
        // L'application va jusqu'aux bords de la carte (à 1 px de contour près).
        frameFlush: Math.abs(frameBox.left - cardBox.left) <= 1.5 && Math.abs(frameBox.right - cardBox.right) <= 1.5
      }
    })
    assert.equal(card.border, '1px solid')
    assert.equal(card.borderVisible, true)
    assert.ok(card.radius >= 8, `coins : ${card.radius}px`)
    assert.equal(card.clipsCorners, true, 'l’aperçu dépasserait des coins arrondis')
    assert.notEqual(card.background, 'rgba(0, 0, 0, 0)', 'carte sans fond')
    assert.ok(card.inset >= 4, `carte collée au bord : ${card.inset}px`)
    assert.equal(card.frameBorder, '0px', 'un second cadre entoure encore l’application')
    assert.equal(card.frameFlush, true)
  })
})

test('« Agrandir » replie la conversation ; le même bouton ou Échap la ramènent (étape 284)', options, async () => {
  // Léo : « pouvoir mettre en grand l'aperçu ».
  await withPage(async (page) => {
    await page.click('.workspace__item')
    await page.waitForSelector('.code-panel__preview')
    const state = () =>
      page.evaluate(() => ({
        chat: getComputedStyle(document.querySelector('.code-chat')).display !== 'none',
        handle: getComputedStyle(document.querySelector('.code-split__handle')).display !== 'none',
        previewWidth: Math.round(document.querySelector('.code-preview').getBoundingClientRect().width),
        splitWidth: Math.round(document.querySelector('.code-split').getBoundingClientRect().width),
        pressed: document.querySelector('.code-preview__expand').getAttribute('aria-pressed'),
        label: document.querySelector('.code-preview__expand').getAttribute('aria-label')
      }))
    const normal = await state()
    assert.equal(normal.chat, true)
    assert.equal(normal.label, "Agrandir l'aperçu")

    await page.click('.code-preview__expand')
    const big = await state()
    assert.equal(big.chat, false, 'la conversation reste affichée')
    assert.equal(big.handle, false, 'la poignée reste affichée sans rien à régler')
    assert.equal(big.previewWidth, big.splitWidth, 'l’aperçu ne prend pas toute la largeur')
    assert.equal(big.pressed, 'true')
    assert.equal(big.label, "Réduire l'aperçu")

    await page.click('.code-preview__expand')
    assert.deepEqual(await state(), normal)

    await page.click('.code-preview__expand')
    await page.keyboard.press('Escape')
    assert.deepEqual(await state(), normal, 'Échap ne ramène pas la conversation')
  })
})

test('aperçu agrandi : une génération en cours reste visible, et « Nouvelle application » ramène la conversation', options, async () => {
  await withPage(async (page) => {
    await page.click('.workspace__item')
    await page.waitForSelector('.code-panel__preview')
    await startGeneration(page)
    await page.click('.code-preview__expand')
    // La ligne en direct est dans la conversation, repliée : la barre de la carte prend le relais (étape 288 : ce
    // que Jaris fait, pas un numéro d'étape).
    assert.equal(await page.textContent('.code-preview__busy'), 'Réfléchit…')
    await page.evaluate(() => window.__emitLive({ kind: 'write', path: 'index.html', lines: 20 }))
    assert.equal(await page.textContent('.code-preview__busy'), 'Écrit index.html +20 lignes')
    await page.evaluate(() => window.__finishGen())
    await page.waitForSelector('.code-panel__done', { state: 'attached' })
    assert.equal(await page.locator('.code-preview__busy').count(), 0)

    // Plus rien à montrer : la conversation revient d'elle-même, sinon elle resterait repliée sans bouton pour la
    // faire revenir (la carte vide n'a pas de bouton « Agrandir »).
    await page.click('.workspace__new')
    await page.waitForSelector('.code-preview--empty', { state: 'attached' })
    assert.equal(await page.isVisible('.code-chat'), true)
    assert.equal(await page.locator('.code-preview__expand').count(), 0)
  })
})

test('la poignée est une petite pastille centrée, plus un filet sur toute la hauteur (étape 284)', options, async () => {
  await withPage(async (page) => {
    await page.click('.workspace__item')
    await page.waitForSelector('.code-panel__preview')
    const grip = await page.evaluate(() => {
      const handle = document.querySelector('.code-split__handle')
      const box = handle.getBoundingClientRect()
      const before = getComputedStyle(handle, '::before')
      return { handleHeight: box.height, gripHeight: parseFloat(before.height), top: before.top, radius: parseFloat(before.borderTopLeftRadius) }
    })
    assert.ok(grip.gripHeight <= 48, `pastille de ${grip.gripHeight}px`)
    assert.ok(grip.gripHeight < grip.handleHeight / 4, 'encore un filet sur toute la hauteur')
    assert.equal(grip.top, `${grip.handleHeight / 2}px`, 'pastille pas centrée verticalement')
    assert.ok(grip.radius >= 2, 'pastille sans bouts arrondis')

    // Au survol, elle grandit un peu pour montrer qu'elle s'attrape, sans redevenir un filet.
    const handle = await page.locator('.code-split__handle').boundingBox()
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.waitForTimeout(250)
    const hovered = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.code-split__handle'), '::before').height))
    assert.ok(hovered > grip.gripHeight && hovered <= 48, `pastille survolée : ${hovered}px`)
  })
})

/** Ouvre l'écran Code DANS une barre de titre comme celle de Jaris (étape 285), puis l'application de la liste. */
async function withShell(run, { width = 1640, label = null, banner = false } = {}) {
  const html = buildPage().replace('<div id="root">', `<script>window.__shell = ${JSON.stringify({ label, banner })}</script><div id="root">`)
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width, height: 860 })
    await page.setContent(html)
    await page.click('.workspace__item')
    await page.waitForSelector('.code-panel__preview')
    await run(page)
  } finally {
    await browser.close()
  }
}

const shellLayout = (page) =>
  page.evaluate(() => {
    const box = (selector) => document.querySelector(selector).getBoundingClientRect()
    const main = box('.app-main')
    const header = box('.app-header')
    const banner = document.querySelector('.app__new-models')
    return {
      cardTop: Math.round(box('.code-preview__card').top - main.top),
      cardLeft: Math.round(box('.code-preview__card').left),
      headerBottom: Math.round(header.bottom - main.top),
      bannerBottom: banner ? Math.round(banner.getBoundingClientRect().bottom - main.top) : null,
      threadTop: Math.round(box('.code-chat__thread').top - main.top),
      titleRight: Math.round(box('.app-header__title').right)
    }
  })

test('la carte monte jusqu’en haut, à côté de la barre de titre de Jaris (étape 285)', options, async () => {
  // Léo, capture à l'appui : « trop gros espace » au-dessus de la carte — la barre « Code » prenait toute la largeur.
  await withShell(async (page) => {
    const layout = await shellLayout(page)
    assert.ok(layout.cardTop <= 12, `carte à ${layout.cardTop}px du haut (barre de ${layout.headerBottom}px)`)
    // La conversation, elle, reste sous la barre : son titre ne passe pas sur le premier message.
    assert.ok(layout.threadTop >= layout.headerBottom, `conversation à ${layout.threadTop}px, sous une barre de ${layout.headerBottom}px`)

    // La zone qui remonte laisse passer les clics : le bouton de la barre (rouvrir la liste) reste cliquable.
    const toggle = await page.locator('.shell-toggle').boundingBox()
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.className, [toggle.x + toggle.width / 2, toggle.y + toggle.height / 2])
    assert.match(String(hit), /shell-toggle/, `le clic tombe sur « ${hit} » au lieu du bouton de la barre`)
    await page.click('.shell-toggle')
    assert.equal(await page.evaluate(() => window.__toggled), 1)

    // À l'inverse, la barre de Jaris ne recouvre pas les boutons de la carte, qui sont à sa hauteur.
    const expand = await page.locator('.code-preview__expand').boundingBox()
    const expandHit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('button')?.className, [expand.x + expand.width / 2, expand.y + expand.height / 2])
    assert.match(String(expandHit), /code-preview__expand/, `le clic tombe sur « ${expandHit} » au lieu de « Agrandir »`)

    // Et le reste fonctionne toujours : une suggestion remplit le champ, la poignée se règle au clavier.
    await page.click('.empty-state__suggestion')
    assert.notEqual(await page.inputValue('.composer__input'), '')
    const before = await page.evaluate(() => Math.round(document.querySelector('.code-chat').getBoundingClientRect().width))
    await page.focus('.code-split__handle')
    await page.keyboard.press('ArrowRight')
    assert.equal(await page.evaluate(() => Math.round(document.querySelector('.code-chat').getBoundingClientRect().width)), before + 24)
  })
})

test('un long titre de barre ne passe jamais sous la carte', options, async () => {
  await withShell(
    async (page) => {
      const layout = await shellLayout(page)
      assert.ok(layout.titleRight <= layout.cardLeft, `titre jusqu'à ${layout.titleRight}px, carte à ${layout.cardLeft}px`)
    },
    { label: 'un convertisseur de devises avec graphique historique et alertes de seuil par courriel' }
  )
})

test('la carte reste SOUS la barre : aperçu agrandi, bandeau affiché, fenêtre étroite', options, async () => {
  // Agrandie, elle recouvrirait toute la barre, bouton de la liste compris.
  await withShell(async (page) => {
    await page.click('.code-preview__expand')
    const layout = await shellLayout(page)
    assert.ok(layout.cardTop >= layout.headerBottom, `agrandie : carte à ${layout.cardTop}px, barre jusqu'à ${layout.headerBottom}px`)
  })
  // Un bandeau (nouveau modèle, mise à jour) sous la barre ne doit pas être recouvert.
  await withShell(
    async (page) => {
      const layout = await shellLayout(page)
      assert.ok(layout.cardTop >= layout.bannerBottom, `carte à ${layout.cardTop}px sur un bandeau qui finit à ${layout.bannerBottom}px`)
    },
    { banner: true }
  )
  // Colonnes l'une sur l'autre : l'aperçu prend toute la largeur, il recouvrirait la barre entière.
  await withShell(
    async (page) => {
      const layout = await shellLayout(page)
      assert.ok(layout.cardTop >= layout.headerBottom, `étroite : carte à ${layout.cardTop}px, barre jusqu'à ${layout.headerBottom}px`)
    },
    { width: 1000 }
  )
})

/** Lance une génération et attend que la ligne « en direct » apparaisse (étape 288 : plus de bandeau). */
async function startGeneration(page) {
  await page.fill('.composer__input', 'une liste de courses')
  await page.click('.composer__send')
  await page.waitForSelector('.code-chat__live')
}

/** La ligne en direct, morceau par morceau (les espaces sont faits en CSS, par `gap`). */
const liveText = (page) =>
  page.evaluate(() => [...document.querySelectorAll('.code-chat__live > span:not(.code-chat__live-dot)')].map((part) => part.textContent).join(' '))

test("pendant une génération, l'écran dit ce que Jaris écrit, en direct (étape 288)", options, async () => {
  // Léo, sur le bandeau « Étape 3 · Travail sur … · 2 min 52 · 1696 caractères écrits [Arrêter] » : « enlève ça […]
  // on s'en fout, mais mets ce qu'il fait en direct, par exemple code index.html plus 20 lignes ». Avant l'étape 99,
  // rien ne bougeait du tout ; l'étape 99 avait un bandeau à part ; maintenant c'est UNE ligne de la conversation.
  await withPage(async (page) => {
    await startGeneration(page)
    assert.equal(await liveText(page), 'Réfléchit…')

    await page.evaluate(() => window.__emitLive({ kind: 'write', path: 'index.html', lines: 20 }))
    assert.equal(await liveText(page), 'Écrit index.html +20 lignes')
    await page.evaluate(() => window.__emitLive({ kind: 'write', path: 'index.html', lines: 87 }))
    assert.equal(await liveText(page), 'Écrit index.html +87 lignes')

    // Plus de numéro d'étape ni de compte de caractères, et plus de bandeau du tout.
    await page.evaluate(() =>
      window.__emitProgress({ label: "Écriture de l'application", stepIndex: 1, stepCount: 2, charsWritten: 4210, thinking: false, idleMs: 0 })
    )
    const panel = await page.textContent('.code-chat')
    assert.doesNotMatch(panel, /Étape \d|caractères écrits/)
    assert.equal(await page.locator('.code-panel__live').count(), 0, 'le bandeau est revenu')

    // Un silence prolongé est DIT, au lieu de laisser une ligne immobile sans explication.
    await page.evaluate(() =>
      window.__emitProgress({ label: "Écriture de l'application", stepIndex: 1, stepCount: 2, charsWritten: 4210, thinking: false, idleMs: 45_000 })
    )
    assert.match(await liveText(page), /rien reçu du modèle depuis 45 s/)

    // Fichier fini : retour à « il réfléchit », jamais un fichier figé qui n'est plus en cours.
    await page.evaluate(() => window.__emitLive(null))
    assert.match(await liveText(page), /^Travaille…/)

    // C'est la dernière ligne de la conversation, juste au-dessus du champ.
    assert.equal(await page.evaluate(() => document.querySelector('.code-chat__thread').lastElementChild.classList.contains('code-chat__live')), true)
  })
})

test("on arrête par le bouton du champ, comme dans le Chat — sans erreur rouge (étape 288)", options, async () => {
  // Léo : « enlève ça [Arrêter], on peut [arrêter] comme dans le chat ».
  await withPage(async (page) => {
    await startGeneration(page)
    assert.equal(await page.locator('.code-panel__live-stop').count(), 0, 'le bouton « Arrêter » à part est revenu')

    // Le nom de classe présent dans le JSX ne prouve pas que le CSS s'y applique (piège du bouton resté gris,
    // étape 97) : le bouton du champ est mesuré, il doit être visible et rond comme celui du Chat.
    const button = await page.evaluate(() => {
      const node = document.querySelector('.composer__send--stop')
      const box = node.getBoundingClientRect()
      return { label: node.getAttribute('aria-label'), radius: getComputedStyle(node).borderTopLeftRadius, visible: box.width > 20 && box.height > 20 }
    })
    assert.deepEqual(button, { label: 'Arrêter', radius: '50%', visible: true })

    await page.click('.composer__send--stop')
    assert.equal(await page.evaluate(() => window.__cancelled), true)

    // L'arrêt est une décision de l'utilisateur, pas une panne : il s'annonce à la place de la ligne en direct,
    // jamais en rouge.
    await page.waitForSelector('.code-panel__done')
    assert.match(await page.textContent('.code-panel__done'), /Génération arrêtée après \d+ s/)
    assert.equal(await page.locator('.code-panel__error').count(), 0)
    assert.equal(await page.locator('.code-chat__live').count(), 0)
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
    assert.equal(await page.locator('.code-chat__live').count(), 0)
  })
})

test("pendant une génération, UN SEUL cadre : les remarques vont dans la conversation, sans cadre (étape 286)", options, async () => {
  // Léo : "c'est bizarre il y a étape 2 etc. plus un autre rectangle" (étape 101), puis « enlève l'autre carré »
  // (étape 286) : le journal à part n'existe plus du tout.
  await withPage(async (page) => {
    await startGeneration(page)
    assert.equal(await page.locator('.code-chat__live').count(), 1)
    assert.equal(await page.locator('.code-panel__live').count(), 0, 'le bandeau à part est revenu')
    assert.equal(await page.locator('.code-panel__status').count(), 0, 'un second cadre (vide) est affiché')

    await page.evaluate(() => window.__status('2 problème(s) trouvé(s) dans le code, corrigé(s) automatiquement.'))
    assert.equal(await page.locator('.code-panel__status').count(), 0, 'le journal à part est revenu')
    assert.match(await page.textContent('.code-chat__thread .code-chat__note'), /2 problème\(s\) trouvé\(s\)/)
    // Une remarque n'a ni cadre ni fond : c'est du texte de la conversation.
    const note = await page.evaluate(() => {
      const style = getComputedStyle(document.querySelector('.code-chat__note'))
      return { border: style.borderTopWidth, background: style.backgroundColor }
    })
    assert.deepEqual(note, { border: '0px', background: 'rgba(0, 0, 0, 0)' })

    // Le téléchargement d'un modèle avance sur UNE ligne, pas une ligne par pourcentage.
    await page.evaluate(() => {
      window.__status('Téléchargement de qwen3.8:27b… 12%')
      window.__status('Téléchargement de qwen3.8:27b… 13%')
      window.__status('Téléchargement de qwen3.8:27b… 57%')
    })
    const notes = await page.locator('.code-chat__note').allTextContents()
    assert.deepEqual(notes.slice(1), ['Téléchargement de qwen3.8:27b… 57%'])
  })
})

test('« Modifié index.html +500 −3 » : chaque action est une ligne de la conversation (étape 286)', options, async () => {
  // Léo : « mets les trucs qu'il est en train de faire, par exemple ajouter plus 500 lignes de code dans index ».
  await withPage(async (page) => {
    await startGeneration(page)
    await page.evaluate(() => {
      window.__emitActivity({ kind: 'read', path: 'index.html' })
      window.__emitActivity({ kind: 'read', path: 'style.css' })
      window.__emitActivity({ kind: 'read', path: 'index.html' })
      window.__emitActivity({ kind: 'edit', path: 'index.html', added: 500, removed: 3 })
      window.__emitActivity({ kind: 'create', path: 'jeu.js', added: 80, removed: 0 })
    })
    const rows = await page.locator('.code-chat__activity:not(.code-chat__live)').evaluateAll((nodes) =>
      nodes.map((node) => ({
        // Les espaces sont faits en CSS (gap) : les morceaux sont relus un par un.
        text: [...node.querySelectorAll('span:not(.code-chat__activity-stats span)')].map((part) => part.textContent).join(' '),
        stats: node.querySelector('.code-chat__activity-stats')?.getAttribute('title') ?? null
      }))
    )
    assert.deepEqual(rows, [
      // Lectures consécutives réunies, le même fichier une seule fois.
      { text: 'Lu 2 fichiers index.html, style.css', stats: null },
      { text: 'Modifié index.html +500−3', stats: '500 lignes ajoutées, 3 retirées' },
      { text: 'Créé jeu.js +80', stats: '80 lignes ajoutées' }
    ])
    // Dans la conversation, après la demande, avant la ligne en direct.
    const order = await page.locator('.code-chat__thread > *').evaluateAll((nodes) => nodes.map((n) => n.className.split(' ')[0]))
    assert.deepEqual(order, ['code-chat__user', 'code-chat__activity', 'code-chat__activity', 'code-chat__activity', 'code-chat__live'])
    // Sans cadre, comme une ligne de texte.
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.code-chat__activity')).borderTopWidth), '0px')
  })
})

test('l’agent parle comme Claude : sa phrase s’écrit en direct, puis ses actions suivent (étape 286)', options, async () => {
  // Léo : « il peut pas parler comme toi, il dit ce qu'il fait ».
  await withPage(async (page) => {
    await startGeneration(page)
    await page.evaluate(() => window.__emitNarration({ id: 1, text: 'Je lis' }))
    assert.deepEqual(await page.locator('.code-chat__reply').allTextContents(), ['Je lis'])
    // La même phrase se complète sur place, sans nouveau message.
    await page.evaluate(() => window.__emitNarration({ id: 1, text: 'Je lis index.html pour trouver le score.' }))
    assert.deepEqual(await page.locator('.code-chat__reply').allTextContents(), ['Je lis index.html pour trouver le score.'])
    await page.evaluate(() => {
      window.__emitActivity({ kind: 'read', path: 'index.html' })
      window.__emitNarration({ id: 2, text: 'J’ajoute le meilleur score.' })
      window.__emitActivity({ kind: 'edit', path: 'index.html', added: 12, removed: 1 })
      // Le dernier tour devient le résumé : sa phrase est retirée pour ne pas s'afficher deux fois.
      window.__emitNarration({ id: 3, text: 'Fini.' })
      window.__emitNarration({ id: 3, text: '' })
    })
    const order = await page.locator('.code-chat__thread > *').evaluateAll((nodes) =>
      nodes.map((n) => {
        const parts = n.classList.contains('code-chat__activity')
          ? [...n.querySelectorAll('span:not(.code-chat__activity-stats span)')].map((part) => part.textContent).join(' ')
          : n.textContent
        return `${n.className.split(' ')[0]}:${parts}`
      })
    )
    assert.deepEqual(order.slice(0, 5), [
      'code-chat__user:une liste de courses',
      'code-chat__reply:Je lis index.html pour trouver le score.',
      'code-chat__activity:Lu index.html',
      'code-chat__reply:J’ajoute le meilleur score.',
      'code-chat__activity:Modifié index.html +12−1'
    ])
    assert.equal(order.some((item) => item.endsWith(':Fini.')), false, 'la phrase retirée est restée')
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
    assert.equal(await page.locator('.code-chat__note').count(), 0, 'les remarques de la génération précédente sont restées')
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

/** La conversation affichée, ligne par ligne (« classe:texte »), sans l'écran d'accueil d'une conversation vide. */
const threadLines = (page) =>
  page.locator('.code-chat__thread > :not(.empty-state)').evaluateAll((nodes) =>
    nodes.map((node) => {
      const text = node.classList.contains('code-chat__activity')
        ? [...node.querySelectorAll('span:not(.code-chat__activity-stats span):not(.code-chat__live-dot)')].map((part) => part.textContent).join(' ')
        : node.textContent
      return `${node.className.split(' ')[0]}:${text}`
    })
  )

/** Crée « liste de courses v2 » : le vrai main l'enregistre dans son propre dossier, donc elle rejoint la liste. */
async function generateNewApp(page) {
  await startGeneration(page)
  await page.evaluate(() => {
    window.__emitActivity({ kind: 'create', path: 'index.html', added: 20, removed: 0 })
    window.__apps.unshift({ path: 'C:/Users/leo/Jaris/generated-apps/2026-09-14-liste-de-courses', label: 'liste de courses v2', timestamp: Date.now() })
    window.__finishGen()
  })
  await page.waitForSelector('.code-panel__done')
  await page.waitForFunction(() => document.querySelectorAll('.workspace__list li').length === 3)
}

test('une application garde sa conversation : la rouvrir la retrouve, fin comprise (étape 288)', options, async () => {
  // Léo : « je suis dans le chat en train de parler et je vois aucune conversation à gauche ».
  await withPage(async (page) => {
    await generateNewApp(page)
    const expected = ['code-chat__user:une liste de courses', 'code-chat__activity:Créé index.html +20']
    assert.deepEqual((await threadLines(page)).slice(0, 2), expected)
    // L'application créée est l'élément actif de la liste.
    assert.equal(await page.textContent('.workspace__item--active .workspace__item-title'), 'liste de courses v2')

    await page.click('.workspace__new')
    await page.waitForSelector('.empty-state')
    assert.deepEqual(await threadLines(page), [])

    await page.click('.workspace__item:has-text("liste de courses v2")')
    await page.waitForFunction(() => document.querySelectorAll('.code-chat__user').length === 1)
    const restored = await threadLines(page)
    assert.deepEqual(restored.slice(0, 2), expected)
    // Le bandeau de fin fait partie de la conversation retrouvée : on sait comment le dernier travail s'est terminé.
    assert.match(restored[2], /^code-chat__reply:Terminé en \d+ s/)

    // Une autre application a SA conversation (vide ici), jamais celle de la précédente.
    await page.click('.workspace__item:has-text("jeu snake")')
    await page.waitForSelector('.empty-state')
    assert.deepEqual(await threadLines(page), [])
  })
})

test('pendant un travail, la liste ne change pas d’élément (sa conversation y écrit en direct)', options, async () => {
  await withPage(async (page) => {
    await startGeneration(page)
    await page.click('.workspace__item:has-text("jeu snake")')
    await page.click('.workspace__new')
    assert.deepEqual(await threadLines(page), ['code-chat__user:une liste de courses', 'code-chat__live:Réfléchit…'])
  })
})

test('les conversations survivent à un redémarrage de Jaris (étape 288)', options, async () => {
  // Page servie sur une vraie origine : sur about:blank, le stockage est refusé et seule la copie en mémoire tient.
  const html = buildPage()
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 860 })
    await page.route('http://jaris.test/**', (route) => route.fulfill({ contentType: 'text/html', body: html }))
    await page.goto('http://jaris.test/')
    await page.waitForSelector('.workspace__rail')
    await generateNewApp(page)

    // Au redémarrage, l'application créée est toujours sur le disque : le faux main la liste d'emblée.
    const apps = await page.evaluate(() => window.__apps)
    await page.addInitScript((saved) => {
      window.__presetApps = saved
    }, apps)
    await page.reload()
    await page.waitForSelector('.workspace__rail')
    assert.deepEqual(await threadLines(page), [], 'une conversation est affichée avant qu’on ait choisi quoi que ce soit')

    await page.click('.workspace__item:has-text("liste de courses v2")')
    await page.waitForFunction(() => document.querySelectorAll('.code-chat__user').length === 1)
    const restored = await threadLines(page)
    assert.deepEqual(restored.slice(0, 2), ['code-chat__user:une liste de courses', 'code-chat__activity:Créé index.html +20'])
    assert.match(restored[2], /^code-chat__reply:Terminé en \d+ s/)
  } finally {
    await browser.close()
  }
})

test.after(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})
