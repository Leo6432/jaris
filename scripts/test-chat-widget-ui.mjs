import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Le widget texte (ChatWidget.tsx) : ce que Jaris devient quand on quitte sa fenêtre depuis le mode Chat —
 * une barre de saisie au même endroit que le cercle vocal, où poser une question sans rouvrir
 * l'application (demande de Léo, voir shared/ipc.ts -> WidgetMode).
 *
 * Testé dans un VRAI navigateur avec le VRAI CSS compilé, parce que les deux choses qui peuvent casser ici
 * ne se voient pas en relisant le code :
 * - le champ de saisie est posé dans une fenêtre entièrement en zone de déplacement
 *   (`-webkit-app-region: drag`, .app--widget) : sans exception explicite, il serait impossible à remplir ;
 * - la règle générale `input, ... { border: ... !important }` redessinerait un cadre carré à l'intérieur de
 *   la pilule arrondie (même piège que le composeur du Chat et le curseur de longueur de contexte).
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-chat-widget-entry.tsx')

const ENTRY = `
import { createRoot } from 'react-dom/client'
import ChatWidget, { computeReplyDismissDelayMs } from './src/components/ChatWidget'

window.__computeReplyDismissDelayMs = computeReplyDismissDelayMs
window.__heights = []
window.__openedSettings = 0
window.__collapsed = 0
window.__keepOpen = false
const overrides = {
  sendChatMessage: async () => {
    await new Promise((resolve) => setTimeout(resolve, 60))
    return { role: 'assistant', content: "Il fait 18 degrés à Paris, ciel **couvert**." }
  },
  setChatWidgetHeight: (height) => window.__heights.push(height),
  setChatWidgetKeepOpen: (keepOpen) => { window.__keepOpen = keepOpen },
  armChatWidgetPointer: () => {},
  collapseChatWidget: () => { if (!window.__keepOpen) window.__collapsed += 1 },
  openSettings: () => { window.__openedSettings += 1 },
  getProfile: async () => ({ name: 'Léo', soundEffectsEnabled: false })
}

window.jaris = new Proxy({}, {
  get: (_target, name) => {
    if (typeof name !== 'string') return undefined
    if (name in overrides) return overrides[name]
    if (name.startsWith('on')) return () => () => {}
    return async () => null
  }
})

document.documentElement.classList.add('body--widget')
document.body.classList.add('body--widget')

const root = createRoot(document.getElementById('root'))
window.__renderChatWidget = (inactive) => root.render(
  <div className={\`app app--widget app--widget-chat\${inactive ? ' app--widget-chat-idle' : ''}\`}>
    <ChatWidget inactive={inactive} />
  </div>
)
window.__renderChatWidget(false)
window.__renderVoiceRest = () => root.render(
  <div className="app app--widget app--widget-collapsed">
    <div className="widget-rest">
      <div className="widget-pill"><span style={{ display: 'block', width: 32, height: 32 }} /></div>
    </div>
  </div>
)
`

let pageHtml = null

function buildPage() {
  if (pageHtml) return pageHtml
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-chat-widget-'))
  const bundlePath = join(outDir, 'bundle.js')

  writeFileSync(entryPath, ENTRY)
  try {
    buildSync({ entryPoints: [entryPath], bundle: true, format: 'iife', jsx: 'automatic', alias: { '@': join(projectRoot, 'src') }, outfile: bundlePath })
  } finally {
    rmSync(entryPath, { force: true })
  }

  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  pageHtml = `<!doctype html><html><head><style>html,body{margin:0;}${css}</style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  return pageHtml
}

async function withWidget(run) {
  const html = buildPage()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage()
    // Les dimensions réelles de la fenêtre active (WIDGET_CHAT_WIDTH x WIDGET_CHAT_COLLAPSED_HEIGHT,
    // main.ts) : tester à une taille inventée ne dirait rien de ce que Léo verra.
    await page.setViewportSize({ width: 460, height: 68 })
    await page.setContent(html)
    await page.waitForSelector('.chat-widget__input')
    await run(page)
  } finally {
    await browser.close()
  }
}

const options = { skip: chromium ? false : 'playwright introuvable (absent du runner CI)' }

test('le widget affiche une barre de saisie, jamais le cercle du widget vocal', options, async () => {
  await withWidget(async (page) => {
    assert.ok(await page.$('.chat-widget__input'), 'la barre de saisie est absente')
    assert.equal(await page.$('.jaris-orb'), null, 'le cercle vocal ne doit pas être dessiné dans le widget texte')
    assert.equal(await page.$('.chat-widget__answer'), null, 'au repos, rien ne doit être déplié')
  })
})

test('le Chat inactif reste un petit widget puis + peut afficher une barre déjà prête à écrire', options, async () => {
  await withWidget(async (page) => {
    await page.evaluate(() => window.__renderChatWidget(true))
    await page.waitForSelector('.chat-widget__idle')
    assert.equal(await page.$('.chat-widget__input'), null, 'la barre est visible avant la pression sur +')
    const idle = await page.$eval('.chat-widget__idle', (el) => {
      const rect = el.getBoundingClientRect()
      return { width: rect.width, height: rect.height }
    })
    assert.deepEqual(idle, { width: 76, height: 40 })

    // Simule le changement de forme envoyé par main.ts quand le raccourci + est pressé.
    await page.evaluate(() => window.__renderChatWidget(false))
    await page.waitForSelector('.chat-widget__input')
    assert.equal(await page.$eval('.chat-widget__input', (el) => document.activeElement === el), true)
  })
})

test('sortir réellement la souris de la barre demande son retour à l’état inactif', options, async () => {
  await withWidget(async (page) => {
    await page.hover('.chat-widget__bar')
    await page.mouse.move(459, 67)
    await page.waitForFunction(() => window.__collapsed === 1)
    assert.equal(await page.evaluate(() => window.__collapsed), 1)
  })
})

test('un seul caractère protège le brouillon quand la souris quitte la barre', options, async () => {
  await withWidget(async (page) => {
    await page.fill('.chat-widget__input', 'a')
    await page.waitForFunction(() => window.__keepOpen === true)
    await page.hover('.chat-widget__bar')
    await page.mouse.move(459, 67)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(await page.evaluate(() => window.__collapsed), 0)
  })
})

test('envoyer garde le widget ouvert pendant la réflexion puis pour lire la réponse', options, async () => {
  await withWidget(async (page) => {
    await page.setViewportSize({ width: 460, height: 400 })
    await page.fill('.chat-widget__input', 'salut')
    await page.click('.chat-widget__send')
    await page.waitForSelector('.chat-widget__answer')
    assert.equal(await page.evaluate(() => window.__keepOpen), true, 'la question en cours n’est pas protégée')
    await page.waitForFunction(() => document.querySelector('.chat-widget__reply')?.textContent?.includes('18 degrés'))
    await page.hover('.chat-widget__answer')
    await page.mouse.move(459, 399)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(await page.evaluate(() => window.__collapsed), 0, 'la réponse affichée a été repliée avant lecture')
    assert.equal(await page.evaluate(() => window.__keepOpen), true)
  })
})

test('après un repli souris, le prochain + rouvre une simple barre sans ancienne réponse', options, async () => {
  await withWidget(async (page) => {
    await page.fill('.chat-widget__input', 'bonjour')
    await page.click('.chat-widget__send')
    await page.waitForSelector('.chat-widget__answer')
    await page.evaluate(() => window.__renderChatWidget(true))
    await page.waitForSelector('.chat-widget__idle')
    await page.evaluate(() => window.__renderChatWidget(false))
    await page.waitForSelector('.chat-widget__input')
    assert.equal(await page.$('.chat-widget__answer'), null)
  })
})

test('le halo possède assez de marge transparente pour ne pas être coupé', options, async () => {
  await withWidget(async (page) => {
    const geometry = await page.$eval('.chat-widget__bar', (el) => {
      const rect = el.getBoundingClientRect()
      return { top: rect.top, left: rect.left, right: innerWidth - rect.right, bottom: innerHeight - rect.bottom }
    })
    // --hud-glow utilise 12px de flou : 14px laisse deux pixels d'antialiasing en plus à chaque bord.
    assert.deepEqual(geometry, { top: 14, left: 14, right: 14, bottom: 14 })
  })
})

test('le halo du widget vocal inactif possède lui aussi sa marge complète', options, async () => {
  await withWidget(async (page) => {
    await page.setViewportSize({ width: 320, height: 68 })
    await page.evaluate(() => window.__renderVoiceRest())
    await page.waitForSelector('.widget-pill')
    const geometry = await page.$eval('.widget-pill', (el) => {
      const rect = el.getBoundingClientRect()
      return { top: rect.top, bottom: innerHeight - rect.bottom }
    })
    assert.deepEqual(geometry, { top: 14, bottom: 14 })
  })
})

test('on peut vraiment TAPER dans la barre malgré la zone de déplacement de la fenêtre', options, async () => {
  await withWidget(async (page) => {
    // Un vrai clic aux coordonnées du champ (pas un fill() qui écrit dedans sans passer par la souris) :
    // c'est précisément ce que `-webkit-app-region: drag` casserait.
    await page.click('.chat-widget__input')
    await page.keyboard.type('quel temps fait-il ?')
    assert.equal(await page.inputValue('.chat-widget__input'), 'quel temps fait-il ?')
    const dragRegion = await page.$eval('.chat-widget__bar', (el) => getComputedStyle(el).webkitAppRegion)
    assert.equal(dragRegion, 'no-drag', 'la barre reste en zone de déplacement : impossible d’y écrire')
  })
})

test('le champ n’a pas de second cadre carré à l’intérieur de la pilule arrondie', options, async () => {
  await withWidget(async (page) => {
    const style = await page.$eval('.chat-widget__input', (el) => {
      const computed = getComputedStyle(el)
      return { border: computed.borderTopWidth, background: computed.backgroundColor }
    })
    assert.equal(style.border, '0px', 'la règle générale des champs redessine un cadre dans la pilule')
    assert.equal(style.background, 'rgba(0, 0, 0, 0)', 'le champ doit être transparent : la pilule porte déjà le fond')
  })
})

test('le focus du champ ne dessine pas un rectangle lumineux dans la pilule', options, async () => {
  await withWidget(async (page) => {
    await page.click('.chat-widget__input')
    const style = await page.$eval('.chat-widget__input', (el) => {
      const computed = getComputedStyle(el)
      return { boxShadow: computed.boxShadow, borderColor: computed.borderTopColor }
    })
    assert.equal(style.boxShadow, 'none', 'la lueur rectangulaire du focus doit être désactivée dans le widget')
    assert.match(style.borderColor, /rgba?\(0, 0, 0, 0\)|transparent/, 'le champ ne doit pas ajouter son propre contour')
  })
})

test('envoyer une question déplie la réponse et donne au main la hauteur RÉELLE', options, async () => {
  await withWidget(async (page) => {
    await page.setViewportSize({ width: 460, height: 400 })
    await page.fill('.chat-widget__input', 'quel temps fait-il à Paris ?')
    await page.click('.chat-widget__send')
    await page.waitForSelector('.chat-widget__answer')
    await page.waitForFunction(() => document.querySelector('.chat-widget__reply')?.textContent?.includes('18 degrés'))

    const content = await page.textContent('.chat-widget__answer')
    assert.match(content, /quel temps fait-il à Paris/, 'la question posée doit rester visible')
    assert.match(content, /18 degrés/, 'la réponse doit s’afficher dans le widget, sans rouvrir l’application')
    assert.ok(await page.$('.chat-widget__reply strong'), 'le **gras** du modèle doit être rendu, pas affiché tel quel')

    const heights = await page.evaluate(() => window.__heights)
    assert.equal(heights[0], null, 'au repos, le widget doit demander sa simple barre')
    const last = heights[heights.length - 1]
    assert.ok(typeof last === 'number', `la hauteur dépliée doit être un nombre, reçu ${last}`)
    // Le point du correctif : une hauteur MESURÉE, pas la hauteur de la fenêtre (400 ici). Une valeur égale
    // à la fenêtre signifierait que la mesure retombe sur `scrollHeight`, qui renvoie le maximum entre le
    // contenu et la fenêtre — piège attrapé en mesurant, jamais visible en relisant le code.
    assert.ok(last < 400, `la hauteur doit suivre le contenu, pas la fenêtre (reçu ${last})`)
    assert.ok(last > 100, `la hauteur doit couvrir barre + réponse (reçu ${last})`)
  })
})

test('à la hauteur demandée, aucun bout du widget n’est coupé', options, async () => {
  await withWidget(async (page) => {
    await page.setViewportSize({ width: 460, height: 400 })
    await page.fill('.chat-widget__input', 'quel temps fait-il à Paris ?')
    await page.click('.chat-widget__send')
    await page.waitForFunction(() => document.querySelector('.chat-widget__reply')?.textContent?.includes('18 degrés'))

    const wanted = await page.evaluate(() => window.__heights[window.__heights.length - 1])
    await page.setViewportSize({ width: 460, height: wanted })
    await page.waitForTimeout(120)
    const fits = await page.evaluate(() => {
      const actions = document.querySelector('.chat-widget__actions').getBoundingClientRect()
      const answer = document.querySelector('.chat-widget__answer').getBoundingClientRect()
      return { windowHeight: window.innerHeight, actionsBottom: actions.bottom, answerBottom: answer.bottom }
    })
    assert.ok(
      fits.answerBottom <= fits.windowHeight,
      `la réponse dépasse la fenêtre (${fits.answerBottom} > ${fits.windowHeight})`
    )
    assert.ok(
      fits.actionsBottom <= fits.windowHeight,
      `les boutons sont coupés (${fits.actionsBottom} > ${fits.windowHeight})`
    )
  })
})

test('"Fermer" ramène la simple barre, "Ouvrir le Chat" rouvre l’application', options, async () => {
  await withWidget(async (page) => {
    await page.setViewportSize({ width: 460, height: 400 })
    await page.fill('.chat-widget__input', 'bonjour')
    await page.click('.chat-widget__send')
    await page.waitForFunction(() => document.querySelector('.chat-widget__reply')?.textContent?.includes('18 degrés'))

    await page.click('.chat-widget__action:has-text("Ouvrir le Chat")')
    assert.equal(await page.evaluate(() => window.__openedSettings), 1, 'le bouton ne rouvre pas Jaris')

    await page.click('.chat-widget__action:has-text("Fermer")')
    assert.equal(await page.$('.chat-widget__answer'), null, 'la réponse doit disparaître')
    assert.equal(
      await page.evaluate(() => window.__heights[window.__heights.length - 1]),
      null,
      'le main doit être prévenu de replier la fenêtre à sa simple barre'
    )
  })
})

test('les boutons du widget sont habillés par le CSS de Jaris, pas laissés au style du navigateur', options, async () => {
  await withWidget(async (page) => {
    await page.setViewportSize({ width: 460, height: 400 })
    await page.fill('.chat-widget__input', 'bonjour')
    await page.click('.chat-widget__send')
    await page.waitForSelector('.chat-widget__actions')
    // Sélection par la BALISE et vérification une par une : un sélecteur bâti sur la classe qu'on veut
    // justement vérifier ne peut pas voir cette classe manquer (piège attrapé en vérifiant qu'un test mord).
    const styles = await page.$$eval('.chat-widget__actions button', (els) =>
      els.map((el) => {
        const computed = getComputedStyle(el)
        return { font: computed.fontFamily, background: computed.backgroundImage, clip: computed.clipPath }
      })
    )
    assert.equal(styles.length, 2, 'les deux boutons doivent être présents')
    for (const style of styles) {
      assert.match(style.font, /Rajdhani/, 'bouton laissé à la police par défaut du navigateur')
      assert.match(style.background, /gradient/, 'bouton sans le fond de la famille HUD')
      assert.match(style.clip, /polygon/, 'bouton sans les coins coupés de la famille HUD')
    }
  })
})

/**
 * Léo : "quand on envoie un message dans le widget chat, ça réponse doit disparaitre après, ça doit varier
 * selon la longueur de la réponse" — computeReplyDismissDelayMs (ChatWidget.tsx) calcule le délai avant
 * disparition automatique, calé sur une vitesse de lecture (~300ms/mot), borné aux deux extrémités.
 */
test('le délai avant disparition varie avec la longueur de la réponse, borné aux deux extrémités', options, async () => {
  await withWidget(async (page) => {
    const delays = await page.evaluate(() => ({
      unMot: window.__computeReplyDismissDelayMs('Paris'),
      // 20 mots à 300ms/mot = 6000ms : au-dessus du plancher (4s), en dessous du plafond (25s).
      moyenne: window.__computeReplyDismissDelayMs(Array(20).fill('mot').join(' ')),
      longue: window.__computeReplyDismissDelayMs(
        Array(120).fill('mot').join(' ') // bien au-delà du plafond à 300ms/mot
      )
    }))
    assert.equal(delays.unMot, 4000, 'un seul mot doit rester au plancher (4s)')
    assert.equal(delays.moyenne, 6000, 'une réponse de 20 mots doit suivre la formule (300ms/mot)')
    assert.ok(delays.moyenne > delays.unMot, 'une réponse plus longue doit rester affichée plus longtemps')
    assert.equal(delays.longue, 25000, 'une réponse très longue doit être plafonnée (25s), pas illimitée')
  })
})

/**
 * De vraies attentes (Playwright `clock` s'est révélée instable dans ce sandbox : les deux tests qu'elle
 * portait ont fini par geler tout le fichier jusqu'au SIGKILL externe, malgré `polling: 100`). Le faux
 * `sendChatMessage` répond "Il fait 18 degrés à Paris, ciel couvert." — 8 mots, donc `computeReplyDismissDelayMs`
 * PLAFONNE au plancher (4000ms, pas la formule 300ms/mot) : une vraie attente de quelques secondes suffit.
 */

test('la réponse disparaît toute seule après le délai calculé, sans survol', options, async () => {
  await withWidget(async (page) => {
    await page.setViewportSize({ width: 460, height: 400 })
    await page.fill('.chat-widget__input', 'quel temps fait-il à Paris ?')
    await page.click('.chat-widget__send')
    await page.waitForFunction(() => document.querySelector('.chat-widget__reply')?.textContent?.includes('18 degrés'))

    // Le clic sur "Envoyer" a déplacé la souris DANS le widget : la déplacer hors de la fenêtre déclenche un
    // vrai mouseleave, sans quoi `hovering` resterait vrai et suspendrait indéfiniment la disparition.
    await page.mouse.move(459, 399)

    const wanted = await page.evaluate(() => window.__computeReplyDismissDelayMs('Il fait 18 degrés à Paris, ciel couvert.'))
    assert.equal(wanted, 4000, 'ce test suppose le délai plancher (8 mots) pour rester rapide')
    assert.ok(await page.$('.chat-widget__answer'), 'la réponse doit encore être là juste avant le délai')

    await page.waitForTimeout(wanted - 500)
    assert.ok(await page.$('.chat-widget__answer'), `la réponse a disparu trop tôt (avant ${wanted}ms)`)

    await page.waitForTimeout(700)
    // Comparer un ElementHandle Playwright directement à `null` via assert.equal/deepEqual GÈLE tout le
    // processus si l'assertion échoue : node:assert tente de formater l'objet dans le message d'erreur, et
    // un ElementHandle référence toute la connexion CDP (objets circulaires, promesses en attente) — sa
    // sérialisation par `util.inspect` ne rend jamais la main. Repéré en isolant le blocage avec un script de
    // diagnostic minimal (`assert.equal(handle, null)` sur un VRAI ElementHandle ne rend jamais la main, ni
    // ne lève d'erreur, même après 20s). Toujours comparer un BOOLÉEN (`=== null`), jamais le handle lui-même.
    assert.equal((await page.$('.chat-widget__answer')) === null, true, 'la réponse aurait dû disparaître toute seule')
    // La barre de saisie, elle, reste affichée : `dismiss()` ne fait que replier la RÉPONSE (expanded=false),
    // pas revenir à la pilule minuscule — ça, c'est le rôle du prop `inactive`, piloté par main.ts quand la
    // souris quitte VRAIMENT le widget, pas par ce délai de lecture.
    assert.equal((await page.$('.chat-widget__input')) === null, false, 'la barre de saisie doit rester prête pour la question suivante')
  })
})

test('survoler le widget suspend la disparition automatique tant que la souris reste dessus', options, async () => {
  await withWidget(async (page) => {
    await page.setViewportSize({ width: 460, height: 400 })
    await page.fill('.chat-widget__input', 'quel temps fait-il à Paris ?')
    await page.click('.chat-widget__send')
    await page.waitForFunction(() => document.querySelector('.chat-widget__reply')?.textContent?.includes('18 degrés'))

    // Reste survolé (la souris du clic précédent est déjà dans le widget) au-delà du délai calculé : la
    // réponse ne doit jamais disparaître tant que Léo est en train de la lire.
    const wanted = await page.evaluate(() => window.__computeReplyDismissDelayMs('Il fait 18 degrés à Paris, ciel couvert.'))
    await page.waitForTimeout(wanted + 700)
    assert.ok(await page.$('.chat-widget__answer'), 'le survol continu n’a pas empêché la disparition automatique')
  })
})
