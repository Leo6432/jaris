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
 * - le champ de saisie doit rester cliquable : une zone de déplacement (`-webkit-app-region: drag`) le rendrait
 *   impossible à remplir — il n'y en a plus du tout depuis l'étape 275 (le widget ne se déplace plus) ;
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
import VoiceWidget from './src/components/VoiceWidget'

window.__computeReplyDismissDelayMs = computeReplyDismissDelayMs
window.__heights = []
window.__openedSettings = 0
window.__openedChatBar = 0
window.__collapsed = 0
window.__keepOpen = false
window.__sendDelay = 60
window.__logListeners = []
window.__emitLog = (message) => window.__logListeners.forEach((listener) => listener(message))
const overrides = {
  sendChatMessage: async (prompt, image) => {
    ;(window.__sent = window.__sent || []).push([prompt, image ?? null])
    await new Promise((resolve) => setTimeout(resolve, window.__sendDelay))
    return { role: 'assistant', content: "Il fait 18 degrés à Paris, ciel **couvert**." }
  },
  onLog: (listener) => {
    window.__logListeners.push(listener)
    return () => { window.__logListeners = window.__logListeners.filter((entry) => entry !== listener) }
  },
  setChatWidgetHeight: (height) => window.__heights.push(height),
  // Étape 434 : le niveau de la voix pendant l'écoute, envoyé par le main au widget.
  onCaptureLevel: (listener) => { window.__captureLevel = listener; return () => { window.__captureLevel = null } },
  setChatWidgetKeepOpen: (keepOpen) => { window.__keepOpen = keepOpen },
  armChatWidgetPointer: () => {},
  // Étape 435 : comme main.ts, une image glissée sur l'indicateur ouvre la barre.
  openChatWidgetForDrop: () => {
    window.__openedForDrop = (window.__openedForDrop || 0) + 1
    window.__renderChatWidget(false)
  },
  collapseChatWidget: () => { if (!window.__keepOpen) window.__collapsed += 1 },
  openSettings: () => { window.__openedSettings += 1 },
  // Étape 325 : comme main.ts, la demande d'ouverture remplace aussitôt l'indicateur par la barre.
  openChatWidget: () => {
    window.__openedChatBar += 1
    window.__renderChatWidget(false)
  },
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
// Étape 432 : le VRAI widget vocal (VoiceWidget.tsx), comme App.tsx le monte.
const audio = { current: null }
window.__renderVoiceLong = (reply) => root.render(
  <div className="app app--widget">
    <VoiceWidget emotion="happy" transcript="Raconte-moi l'histoire de Rome" reply={reply} activity={null} audioElRef={audio} onOpen={() => {}} />
  </div>
)
window.__renderVoice = (emotion, transcript, reply, activity) => root.render(
  <div className={\`app app--widget\${emotion === 'idle' ? ' app--widget-collapsed' : ''}\`}>
    <VoiceWidget emotion={emotion} transcript={transcript} reply={reply} activity={activity} audioElRef={audio} onOpen={() => { window.__openedSettings += 1 }} />
  </div>
)
window.__renderVoiceRest = () => root.render(
  <div className="app app--widget app--widget-collapsed">
    <VoiceWidget emotion="idle" transcript="" reply="" activity={null} audioElRef={audio} onOpen={() => {}} />
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
    buildSync({ entryPoints: [entryPath], bundle: true, format: 'iife', jsx: 'automatic', alias: { '@': join(projectRoot, 'src') }, loader: { '.png': 'dataurl' }, outfile: bundlePath })
  } finally {
    rmSync(entryPath, { force: true })
  }

  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  pageHtml = `<!doctype html><html><head><style>html,body{margin:0;}${css}</style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  return pageHtml
}

/** `colorScheme` : le thème de Windows, que la fenêtre du widget suit (clair par défaut, comme chez Léo). */
async function withWidget(run, colorScheme = 'light') {
  const html = buildPage()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage({ colorScheme })
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

test('le widget affiche une barre de saisie (avec le petit orbe, étape 432), jamais la capsule vocale', options, async () => {
  await withWidget(async (page) => {
    assert.ok(await page.$('.chat-widget__input'), 'la barre de saisie est absente')
    assert.equal(await page.locator('.voice-island').count(), 0, 'la capsule vocale ne doit pas être dessinée dans le widget texte')
    assert.equal(await page.locator('.chat-widget__bar .jaris-orb').count(), 1, 'l’orbe de Jaris à gauche de la barre')
    assert.equal(await page.locator('.chat-widget__answer').count(), 0, 'au repos, rien ne doit être déplié')
  })
})

test('le Chat inactif reste un petit widget puis + peut afficher une barre déjà prête à écrire', options, async () => {
  await withWidget(async (page) => {
    await page.evaluate(() => window.__renderChatWidget(true))
    await page.waitForSelector('.chat-widget__idle')
    assert.equal(await page.locator('.chat-widget__input').count(), 0, 'la barre est visible avant la pression sur +')
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

// Étape 338 : depuis l'étape 325, le clic sur l'indicateur ouvrait la barre de saisie — Léo ne pouvait plus revenir à
// l'application. Comme le petit orbe du mode vocal, le clic ramène Jaris ; seule la touche « + » ouvre la barre.
test('un clic sur l’indicateur inactif ramène l’application, sans ouvrir la barre', options, async () => {
  await withWidget(async (page) => {
    await page.evaluate(() => window.__renderChatWidget(true))
    await page.waitForSelector('.chat-widget__idle')
    assert.match(await page.getAttribute('.chat-widget__idle', 'title'), /clique pour revenir à Jaris/, 'l’infobulle doit dire que le clic ramène Jaris')
    assert.match(await page.getAttribute('.chat-widget__idle', 'title'), /\+/, 'l’infobulle doit encore dire comment écrire (touche +)')
    await page.click('.chat-widget__idle')
    await page.waitForFunction(() => window.__openedSettings === 1)
    assert.equal(await page.evaluate(() => window.__openedChatBar), 0, 'le clic ouvre encore la barre au lieu de l’application')
    assert.equal(await page.locator('.chat-widget__input').count(), 0, 'la barre ne doit pas apparaître au clic')
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

test('envoyer masque la barre mais laisse le temps de lire la réponse', options, async () => {
  await withWidget(async (page) => {
    await page.setViewportSize({ width: 460, height: 400 })
    await page.fill('.chat-widget__input', 'salut')
    await page.click('.chat-widget__send')
    await page.waitForSelector('.chat-widget__answer')
    assert.equal(await page.evaluate(() => window.__keepOpen), true, 'la question en cours n’est pas protégée')
    assert.equal((await page.$('.chat-widget__bar')) === null, true, 'la barre doit disparaître pendant la réponse')
    await page.waitForFunction(() => document.querySelector('.chat-widget__reply')?.textContent?.includes('18 degrés'))
    await page.waitForTimeout(1000)
    assert.equal(await page.evaluate(() => window.__collapsed), 0, 'la réponse a disparu environ 1 seconde après sa génération')
    assert.ok(await page.$('.chat-widget__answer'), 'la réponse doit rester lisible pendant son délai calculé')
  })
})

test('une recherche affiche un état simple, jamais les journaux techniques des outils', options, async () => {
  await withWidget(async (page) => {
    await page.setViewportSize({ width: 460, height: 400 })
    await page.evaluate(() => { window.__sendDelay = 500 })
    await page.fill('.chat-widget__input', 'qui est Dario Amodei ?')
    await page.click('.chat-widget__send')
    await page.evaluate(() => window.__emitLog('Outil appelé : search_web({"query":"Dario Amodei"})'))
    await page.waitForFunction(() => document.querySelector('.chat-widget__reply')?.textContent?.includes('Recherche sur internet'))
    let visible = await page.textContent('.chat-widget__reply')
    assert.doesNotMatch(visible, /Outil appelé|search_web/, 'le nom technique de l’outil est affiché')

    await page.evaluate(() => window.__emitLog("Résultat de l'outil : Dario Amodei est le CEO d’Anthropic."))
    await page.waitForTimeout(50)
    visible = await page.textContent('.chat-widget__reply')
    assert.match(visible, /Recherche sur internet/, 'le résultat brut a remplacé l’état simple')
    assert.doesNotMatch(visible, /Résultat de l'outil|CEO d’Anthropic/, 'le résultat technique brut est affiché')

    await page.waitForFunction(() => document.querySelector('.chat-widget__reply')?.textContent?.includes('18 degrés'))
  })
})

// Étape 325 : même défaut que le Chat — « Jaris réfléchit… » restait figé pendant une longue attente du modèle. Vraies
// attentes bornées (pas de page.clock, étape 126) : la réponse simulée arrive au bout de 16 s.
test('pendant une longue attente, le widget donne aussi le temps écoulé, à côté de l’étape en cours (étape 325)', options, async () => {
  const seconds = (text) => Number(text.match(/(\d+) s$/)?.[1])
  await withWidget(async (page) => {
    await page.setViewportSize({ width: 460, height: 400 })
    await page.evaluate(() => { window.__sendDelay = 16_000 })
    await page.fill('.chat-widget__input', 'raconte-moi une longue histoire')
    await page.click('.chat-widget__send')
    await page.evaluate(() => window.__emitLog('Outil appelé : search_web({"query":"histoire"})'))
    await page.waitForFunction(() => document.querySelector('.chat-widget__reply')?.textContent?.includes('Recherche sur internet'))
    await page.waitForTimeout(1_500)
    assert.equal(await page.locator('.chat-widget__elapsed').count(), 0, 'une durée s’affiche dès les premières secondes')

    await page.waitForSelector('.chat-widget__elapsed', { timeout: 15_000 })
    const first = await page.textContent('.chat-widget__elapsed')
    assert.match(await page.textContent('.chat-widget__reply'), /^Recherche sur internet… · 1[0-4] s$/)
    await page.waitForTimeout(2_200)
    const second = await page.textContent('.chat-widget__elapsed')
    assert.ok(seconds(second) > seconds(first), `la durée n’avance pas : « ${first} » puis « ${second} »`)

    // La réponse arrive : la durée disparaît avec l'attente.
    await page.waitForFunction(() => document.querySelector('.chat-widget__reply')?.textContent?.includes('18 degrés'), null, { timeout: 10_000 })
    assert.equal(await page.locator('.chat-widget__elapsed').count(), 0, 'la durée reste après la réponse')
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
    assert.equal(await page.locator('.chat-widget__answer').count(), 0)
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
    // La fenêtre repliée (104x68, main.ts) : la capsule de repos (76x40) garde 14px tout autour.
    await page.setViewportSize({ width: 104, height: 68 })
    await page.evaluate(() => window.__renderVoiceRest())
    await page.waitForSelector('.voice-island')
    await page.waitForTimeout(400)
    const geometry = await page.$eval('.voice-island', (el) => {
      const rect = el.getBoundingClientRect()
      return { top: rect.top, left: rect.left, right: innerWidth - rect.right, bottom: innerHeight - rect.bottom }
    })
    assert.deepEqual(geometry, { top: 14, left: 14, right: 14, bottom: 14 })
  })
})

test('on peut vraiment TAPER dans la barre, et rien dans le widget ne permet de le déplacer', options, async () => {
  await withWidget(async (page) => {
    // Un vrai clic aux coordonnées du champ (pas un fill() qui écrit dedans sans passer par la souris) :
    // c'est précisément ce que `-webkit-app-region: drag` casserait.
    await page.click('.chat-widget__input')
    await page.keyboard.type('quel temps fait-il ?')
    assert.equal(await page.inputValue('.chat-widget__input'), 'quel temps fait-il ?')
    // Étape 275 (Léo : « si on prend le bout du widget on peut le déplacer » — « il ne doit pas bouger ») :
    // aucune zone de déplacement, ni sur la barre, ni sur son bord.
    const dragging = await page.evaluate(() =>
      [document.documentElement, ...document.querySelectorAll('*')].filter((el) => getComputedStyle(el).webkitAppRegion === 'drag').map((el) => el.className || el.tagName)
    )
    assert.deepEqual(dragging, [], 'une partie du widget permet encore de le déplacer')
  })
})

test('le widget ne se déplace pas : seule la barre de titre de la fenêtre principale en est une, et Windows le refuse aussi', () => {
  const css = readFileSync(join(projectRoot, 'src/index.css'), 'utf8')
  // Chaque règle qui déclare une zone de déplacement : seulement `.titlebar` (fenêtre principale).
  const dragRules = [...css.matchAll(/([^{}]+)\{[^{}]*-webkit-app-region:\s*drag/g)].map((m) => m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim())
  assert.deepEqual(dragRules, ['.titlebar'], `zone de déplacement hors de la barre de titre : ${dragRules.join(', ')}`)
  const main = readFileSync(join(projectRoot, 'electron/main.ts'), 'utf8')
  const widgetWindow = main.slice(main.indexOf('function createWidgetWindow'), main.indexOf('webPreferences', main.indexOf('function createWidgetWindow')))
  assert.match(widgetWindow, /movable: false/, 'la fenêtre du widget reste déplaçable par Windows')
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
    const answerBackground = await page.$eval('.chat-widget__answer', (el) => getComputedStyle(el).backgroundColor)
    // « rgb(255, 255, 255) » ou « rgb(0, 0, 0) » (fonds opaques des deux thèmes) n'a pas d'alpha : seul « rgba(…, a) » en porte un.
    const alpha = answerBackground.startsWith('rgba') ? Number(answerBackground.match(/[\d.]+(?=\)$)/)?.[0] ?? 1) : 1
    assert.ok(alpha >= 0.9, `le fond de la réponse reste trop transparent (${answerBackground})`)

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

test('le widget garde seulement "Ouvrir le Chat", qui rouvre l’application', options, async () => {
  await withWidget(async (page) => {
    await page.setViewportSize({ width: 460, height: 400 })
    await page.fill('.chat-widget__input', 'bonjour')
    await page.click('.chat-widget__send')
    await page.waitForFunction(() => document.querySelector('.chat-widget__reply')?.textContent?.includes('18 degrés'))

    await page.click('.chat-widget__action:has-text("Ouvrir le Chat")')
    assert.equal(await page.evaluate(() => window.__openedSettings), 1, 'le bouton ne rouvre pas Jaris')
    assert.equal(await page.locator('.chat-widget__action:has-text("Fermer")').count(), 0, 'le bouton Fermer doit être absent')
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
        return { font: computed.fontFamily, radius: computed.borderTopLeftRadius, border: computed.borderTopStyle }
      })
    )
    assert.equal(styles.length, 1, 'seul le bouton Ouvrir le Chat doit être présent')
    for (const style of styles) {
      // Refonte « design sobre » : pilule à liseré fin en Geist (plus de coins coupés ni de Rajdhani).
      assert.match(style.font, /Geist/, 'bouton laissé à la police par défaut du navigateur')
      assert.equal(style.radius, '9999px', 'bouton sans la pilule de la famille de Jaris (style ChatGPT, étape 266)')
      assert.equal(style.border, 'solid', 'bouton sans le liseré de la famille de Jaris')
    }
  })
})

/**
 * Léo : "quand on envoie un message dans le widget chat, ça réponse doit disparaitre après, ça doit varier
 * selon la longueur de la réponse" — computeReplyDismissDelayMs (ChatWidget.tsx) calcule le délai avant
 * disparition automatique, calé sur 300ms par mot, avec un plancher de 5 secondes et aucun plafond.
 */
test('le délai vaut 0,3 seconde par mot, avec 5 secondes minimum et aucun maximum', options, async () => {
  await withWidget(async (page) => {
    const delays = await page.evaluate(() => ({
      unMot: window.__computeReplyDismissDelayMs('Paris'),
      // 20 mots à 300ms/mot = 6000ms : au-dessus du plancher de 5 secondes.
      moyenne: window.__computeReplyDismissDelayMs(Array(20).fill('mot').join(' ')),
      longue: window.__computeReplyDismissDelayMs(
        Array(120).fill('mot').join(' ')
      )
    }))
    assert.equal(delays.unMot, 5000, 'un seul mot doit rester au plancher (5s)')
    assert.equal(delays.moyenne, 6000, 'une réponse de 20 mots doit rester 6 secondes')
    assert.ok(delays.moyenne > delays.unMot, 'une réponse plus longue doit rester affichée plus longtemps')
    assert.equal(delays.longue, 36000, 'une réponse longue ne doit subir aucun plafond')
  })
})

/**
 * De vraies attentes (Playwright `clock` s'est révélée instable dans ce sandbox : les deux tests qu'elle
 * portait ont fini par geler tout le fichier jusqu'au SIGKILL externe, malgré `polling: 100`). Le faux
 * `sendChatMessage` répond "Il fait 18 degrés à Paris, ciel couvert." — 8 mots, donc `computeReplyDismissDelayMs`
 * tombe sur le minimum de 5000ms : une vraie attente de quelques secondes suffit.
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
    assert.equal(wanted, 5000, '8 mots doivent rester visibles au minimum 5 secondes')
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
    assert.equal(await page.evaluate(() => window.__collapsed), 1, 'le widget doit revenir en inactif après lecture')
    assert.equal(await page.evaluate(() => window.__keepOpen), false, 'la protection doit être libérée avant le repli')
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

// Étape 346 : une fois la réponse affichée, le champ (et son écoute d'Échap) n'existe plus — Échap ne fermait plus
// rien, et une erreur restait affichée sans aucun moyen de la fermer au clavier.
test('Échap ferme la réponse affichée, et rend la fenêtre au petit indicateur', options, async () => {
  await withWidget(async (page) => {
    await page.setViewportSize({ width: 460, height: 400 })
    await page.fill('.chat-widget__input', 'bonjour')
    await page.click('.chat-widget__send')
    await page.waitForFunction(() => document.querySelector('.chat-widget__reply')?.textContent?.includes('18 degrés'))
    assert.equal(await page.evaluate(() => window.__collapsed), 0)
    await page.keyboard.press('Escape')
    await page.waitForSelector('.chat-widget__answer', { state: 'detached' })
    assert.equal(await page.evaluate(() => window.__keepOpen), false, 'la protection n’est pas relâchée')
    assert.equal(await page.evaluate(() => window.__collapsed), 1, 'la fenêtre ne revient pas au petit indicateur')
  })
})

// Étape 346 : dans la fenêtre du widget vocal (320 x 460, main.ts), la fin d'une très longue réponse tombait sous le
// bas de la fenêtre — coupée, et impossible à faire défiler puisque la boîte croyait avoir 380 px de place.
test('widget vocal : une très longue réponse reste dans la fenêtre et défile jusqu’à sa fin', options, async () => {
  await withWidget(async (page) => {
    // La fenêtre dépliée du widget vocal (500x460, main.ts).
    await page.setViewportSize({ width: 500, height: 460 })
    await page.evaluate(() => window.__renderVoiceLong('Rome fut fondée, dit la légende, par Romulus. '.repeat(60)))
    await page.waitForSelector('.voice-island__reply')
    await page.waitForTimeout(400)
    const card = await page.$eval('.voice-island', (el) => {
      const rect = el.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: innerWidth - rect.right }
    })
    assert.equal(card.top, 14)
    assert.ok(card.bottom <= 460 - 14, `la carte sort de la fenêtre ou touche son bord (bas à ${Math.round(card.bottom)} px)`)
    assert.equal(card.left, card.right, 'carte centrée')
    assert.ok(card.left >= 14, 'la carte garde sa marge sur les côtés')
    const box = await page.$eval('.voice-island__body', (el) => ({ scroll: el.scrollHeight, client: el.clientHeight }))
    assert.ok(box.scroll > box.client, 'la réponse ne défile pas : sa fin est inaccessible')
    const end = await page.$eval('.voice-island__body', (el) => {
      el.scrollTop = el.scrollHeight
      return el.getBoundingClientRect().bottom
    })
    assert.ok(end <= 460 - 14)
    // Thème clair (Léo : « les widgets en clair, pas en noir, quand le thème est clair ») : texte foncé sur une carte
    // blanche opaque — lisible sur n'importe quel fond d'écran. Le thème sombre (noir, texte blanc) : test plus bas.
    const colors = await page.$eval('.voice-island__reply', (el) => [getComputedStyle(el).color, getComputedStyle(el.closest('.voice-island')).backgroundColor])
    assert.deepEqual(colors, ['rgb(13, 13, 13)', 'rgb(255, 255, 255)'])
  })
})

// Étape 432 (Léo : « on ne voit pas le texte ») : une seule capsule qui change de forme selon ce que fait Jaris.
test('widget vocal : capsule de repos, écoute, réflexion puis carte de réponse (thème clair : texte foncé sur blanc)', options, async () => {
  await withWidget(async (page) => {
    await page.setViewportSize({ width: 500, height: 460 })
    const state = async () => {
      await page.waitForTimeout(400)
      return page.$eval('.voice-island', (el) => {
        const rect = el.getBoundingClientRect()
        const headline = el.querySelector('.voice-island__headline')
        const body = el.querySelector('.voice-island__body')
        return {
          width: Math.round(rect.width),
          headline: headline.textContent,
          headlineShown: getComputedStyle(headline).opacity === '1',
          bodyShown: getComputedStyle(body).display !== 'none',
          body: body.textContent,
          headlineColor: getComputedStyle(headline).color
        }
      })
    }
    await page.evaluate(() => window.__renderVoice('idle', '', '', null))
    let s = await state()
    assert.equal(s.width, 76, 'au repos : la petite capsule')
    assert.equal(s.headlineShown, false, 'au repos : l’orbe seul')
    assert.equal(s.bodyShown, false)

    await page.evaluate(() => window.__renderVoice('listening', 'Quel temps fera-t-il demain', '', null))
    s = await state()
    assert.equal(s.width, 380)
    assert.equal(s.headline, 'Quel temps fera-t-il demain', 'les mots entendus s’écrivent dans la capsule')
    assert.equal(s.headlineShown, true)
    assert.equal(s.headlineColor, 'rgb(13, 13, 13)')
    assert.equal(s.bodyShown, false)

    await page.evaluate(() => window.__renderVoice('thinking', 'Quel temps fera-t-il demain ?', '', 'Recherche sur internet…'))
    s = await state()
    assert.equal(s.headline, 'Recherche sur internet…', 'ce que Jaris fait en ce moment')
    assert.equal(s.bodyShown, true, 'la question reste lisible sous la capsule')
    assert.match(s.body, /Quel temps fera-t-il demain/)

    await page.evaluate(() => window.__renderVoice('happy', 'Quel temps fera-t-il demain ?', 'Demain : 14 °C, nuageux.', null))
    s = await state()
    assert.equal(s.width, 470, 'la réponse ouvre la carte')
    assert.match(s.body, /Quel temps fera-t-il demain[\s\S]*Demain : 14 °C, nuageux\./)

    // Un clic sur l'orbe rouvre Jaris.
    const before = await page.evaluate(() => window.__openedSettings)
    await page.click('.voice-island .jaris-orb')
    assert.equal(await page.evaluate(() => window.__openedSettings), before + 1)
  })
})

// Léo, Windows passé en clair : « mets aussi les widgets en clair, pas en noir, quand le thème est clair » (la capsule
// restait noire dans les deux thèmes depuis l'étape 432). En clair : capsule blanche au texte foncé, détachée du fond
// d'écran par un trait et une ombre que la fenêtre transparente ne coupe pas ; en sombre : inchangée, noire au texte
// blanc. Dans les deux : chaque texte (≥ 4,5:1) et chaque couleur d'émotion (barres, points : ≥ 3:1 ; texte de la
// réflexion : ≥ 4,5:1) se lit sur la capsule — le cyan et l'ambre du sombre tombaient à 1,5-1,8:1 sur du blanc.
for (const scheme of ['light', 'dark']) {
  test(`widgets en thème ${scheme === 'light' ? 'clair : capsule claire' : 'sombre : capsule noire'}, textes et couleurs d’émotion lisibles`, options, async () => {
    await withWidget(async (page) => {
      await page.setViewportSize({ width: 500, height: 460 })
      await page.evaluate(() => {
        const parse = (c) => { const p = String(c).match(/rgba?\(([^)]+)\)/)[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 } }
        const lum = ({ r, g, b }) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
        const blend = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 })
        window.__lum = (color) => lum(parse(color))
        window.__ratio = (color, background) => { const bg = parse(background); const [x, y] = [lum(blend(parse(color), bg)), lum(bg)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) }
      })
      const look = (selector, prop = 'color') =>
        page.$eval(selector, (el, p) => {
          const capsule = el.closest('.voice-island, .chat-widget__bar, .chat-widget__answer, .chat-widget__idle')
          const bg = getComputedStyle(capsule).backgroundColor
          return { bg, ratio: window.__ratio(getComputedStyle(el)[p], bg), color: getComputedStyle(el)[p] }
        }, prop)
      const states = [
        ['listening', 'Quel temps fera-t-il demain', '', null, ['.voice-island__headline'], '.voice-island__bars i'],
        ['thinking', 'Quel temps fera-t-il demain ?', '', 'Recherche sur internet…', ['.voice-island__headline', '.voice-island__question'], '.voice-island__dots i'],
        ['happy', 'Quel temps fera-t-il demain ?', 'Demain : 14 °C, nuageux.', null, ['.voice-island__headline', '.voice-island__question', '.voice-island__reply'], '.voice-island__bars i'],
        ['surprised', 'Combien de temps pour Mars ?', 'Sept mois.', null, ['.voice-island__headline', '.voice-island__reply'], '.voice-island__bars i']
      ]
      for (const [emotion, transcript, reply, activity, texts, signal] of states) {
        await page.evaluate(([e, tr, r, a]) => window.__renderVoice(e, tr, r, a), [emotion, transcript, reply, activity])
        await page.waitForTimeout(350)
        for (const selector of texts) {
          const text = await look(selector)
          assert.ok(text.ratio >= 4.5, `${scheme}/${emotion} : ${selector} à ${text.ratio.toFixed(2)}:1 (${text.color} sur ${text.bg})`)
        }
        const accent = await look(signal, 'backgroundColor')
        assert.ok(accent.ratio >= 3, `${scheme}/${emotion} : couleur d'émotion (${signal}) à ${accent.ratio.toFixed(2)}:1 sur la capsule`)
      }
      const capsule = await page.$eval('.voice-island', (el) => {
        const s = getComputedStyle(el)
        return { bg: s.backgroundColor, text: s.color, border: s.borderTopColor, shadow: s.boxShadow, bgLum: window.__lum(s.backgroundColor), textLum: window.__lum(s.color) }
      })
      if (scheme === 'light') {
        assert.ok(capsule.bgLum > 0.9 && capsule.textLum < 0.05, `thème clair : capsule claire au texte foncé attendue, reçu ${capsule.text} sur ${capsule.bg}`)
        // Le trait : de l'encre sombre (rgba(0, 0, 0, a)), pas le liseré blanc de la capsule noire, invisible sur un fond clair.
        assert.match(capsule.border, /^rgba\(0, 0, 0, 0\.\d+\)$/, `trait de la capsule claire : ${capsule.border}`)
        assert.notEqual(capsule.shadow, 'none', 'la capsule claire garde une ombre qui la détache d’un fond d’écran blanc')
        // L'ombre reste dans les 14 px de marge transparente de la fenêtre (décalage + flou), sinon elle serait coupée.
        for (const [, y, blur] of capsule.shadow.matchAll(/rgba?\([^)]*\)\s+-?[\d.]+px\s+(-?[\d.]+)px\s+([\d.]+)px/g)) {
          assert.ok(Number(y) + Number(blur) <= 14, `ombre ${capsule.shadow} : ${Number(y) + Number(blur)} px sous la capsule, plus que la marge de 14 px`)
        }
      } else {
        assert.deepEqual([capsule.bg, capsule.text], ['rgb(0, 0, 0)', 'rgb(255, 255, 255)'], 'thème sombre : la capsule reste noire, texte blanc')
      }

      // Widget Chat : la barre (texte d'aide, bouton d'envoi) et la carte de réponse (texte, « Ouvrir le Chat »).
      await page.evaluate(() => window.__renderChatWidget(false))
      await page.waitForSelector('.chat-widget__input')
      const hint = await page.$eval('.chat-widget__input', (el) => window.__ratio(getComputedStyle(el, '::placeholder').color, getComputedStyle(el.closest('.chat-widget__bar')).backgroundColor))
      assert.ok(hint >= 4.5, `${scheme} : texte d'aide de la barre à ${hint.toFixed(2)}:1`)
      await page.fill('.chat-widget__input', 'quel temps ?')
      const send = await page.$eval('.chat-widget__send', (el) => {
        const s = getComputedStyle(el)
        return { arrow: window.__ratio(s.color, s.backgroundColor), button: window.__ratio(s.backgroundColor, getComputedStyle(el.closest('.chat-widget__bar')).backgroundColor) }
      })
      assert.ok(send.arrow >= 4.5 && send.button >= 3, `${scheme} : envoi (flèche ${send.arrow.toFixed(2)}:1, bouton ${send.button.toFixed(2)}:1 sur la barre)`)
      const bar = await page.$eval('.chat-widget__bar', (el) => getComputedStyle(el).backgroundColor)
      assert.equal(bar, capsule.bg, 'la barre du Chat a la même couleur que la capsule vocale')
      await page.click('.chat-widget__send')
      await page.waitForFunction(() => document.querySelector('.chat-widget__reply')?.textContent?.includes('18 degrés'))
      for (const selector of ['.chat-widget__reply', '.chat-widget__question', '.chat-widget__name', '.chat-widget__action']) {
        const text = await look(selector)
        assert.ok(text.ratio >= 4.5, `${scheme} : ${selector} à ${text.ratio.toFixed(2)}:1 (${text.color} sur ${text.bg})`)
      }
    }, scheme)
  })
}

// Étape 434 (Léo : « ça bouge aléatoirement, mais ça doit bouger s'il parle ») : les barres suivent le vrai son.
test('widget vocal : les barres restent immobiles dans le silence et suivent la voix pendant l’écoute', options, async () => {
  await withWidget(async (page) => {
    await page.setViewportSize({ width: 500, height: 460 })
    await page.evaluate(() => window.__renderVoice('listening', '', '', null))
    await page.waitForSelector('.voice-island__bars i')
    const scales = () => page.$$eval('.voice-island__bars i', (bars) => bars.map((bar) => Number(/scaleY\(([\d.]+)\)/.exec(bar.style.transform)?.[1] ?? NaN)))
    await page.waitForTimeout(500)
    const silent = await scales()
    assert.ok(silent.every((v) => Math.abs(v - 0.18) < 0.01), `silence : barres au repos, reçu ${silent}`)
    await page.waitForTimeout(400)
    assert.deepEqual(await scales(), silent, 'silence : rien ne bouge tout seul')

    // Il parle : un niveau toutes les 80 ms, comme le programme d'écoute.
    await page.evaluate(() => { window.__talk = setInterval(() => window.__captureLevel?.(0.6), 80) })
    await page.waitForTimeout(500)
    const talking = await scales()
    assert.ok(Math.max(...talking) > 0.6, `il parle : les barres montent, reçu ${talking}`)

    // Il se tait : les barres retombent.
    await page.evaluate(() => clearInterval(window.__talk))
    await page.waitForTimeout(800)
    assert.ok((await scales()).every((v) => Math.abs(v - 0.18) < 0.01), 'silence revenu : barres au repos')
  })
})

test('widget vocal : cliquer sur l’orbe ne laisse ni contour ni sélection', options, async () => {
  await withWidget(async (page) => {
    await page.setViewportSize({ width: 500, height: 460 })
    await page.evaluate(() => window.__renderVoice('happy', 'Quelle heure est-il ?', 'Il est 15 h.', null))
    await page.waitForSelector('.voice-island .jaris-orb')
    await page.click('.voice-island .jaris-orb')
    // Le contour « clavier » de l'écran vocal réapparaissait au retour sur la fenêtre : forcé ici par le clavier.
    await page.focus('.voice-island .jaris-orb')
    await page.keyboard.press('Shift')
    const style = await page.$eval('.voice-island .jaris-orb', (el) => ({ outline: getComputedStyle(el).outlineStyle, select: getComputedStyle(el.closest('.voice-island')).userSelect }))
    assert.deepEqual(style, { outline: 'none', select: 'none' })
  })
})

// Étape 435 (Léo : « dans le widget message, pour ajouter une image, dans le message ») : glisser une image sur le
// widget Chat la joint au message.
test('widget Chat : glisser une image ouvre la barre, la joint, et elle part avec le message', options, async () => {
  await withWidget(async (page) => {
    await page.evaluate(() => window.__renderChatWidget(true))
    await page.waitForSelector('.chat-widget__idle')
    // Un vrai glisser de fichier : une petite image PNG, puis un fichier texte.
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 4
      canvas.height = 4
      canvas.getContext('2d').fillRect(0, 0, 4, 4)
      const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
      window.__drag = (selector, type, file) => {
        const data = new DataTransfer()
        data.items.add(file)
        document.querySelector(selector).dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }))
      }
      window.__png = new File([png], 'capture.png', { type: 'image/png' })
      window.__txt = new File(['bonjour'], 'notes.txt', { type: 'text/plain' })
    })
    await page.evaluate(() => window.__drag('.chat-widget__idle', 'dragenter', window.__png))
    assert.equal(await page.evaluate(() => window.__openedForDrop), 1, 'l’indicateur doit ouvrir la barre')
    await page.waitForSelector('.chat-widget__bar')

    await page.evaluate(() => window.__drag('.chat-widget__bar', 'dragenter', window.__png))
    assert.match(await page.textContent('.chat-widget__bar--drop .chat-widget__drop'), /Dépose l'image ici/)

    await page.evaluate(() => window.__drag('.chat-widget__bar', 'drop', window.__txt))
    await page.waitForSelector('.chat-widget__drop--error')
    assert.match(await page.textContent('.chat-widget__drop--error'), /Seules les images/)

    await page.evaluate(() => window.__drag('.chat-widget__bar', 'drop', window.__png))
    await page.waitForSelector('.chat-widget__thumb img')
    assert.equal(await page.locator('.chat-widget__bar--drop').count(), 0, 'la zone de dépôt disparaît après le dépôt')
    assert.equal(await page.evaluate(() => window.__keepOpen), true, 'une image jointe est protégée comme un brouillon')
    assert.equal(await page.getAttribute('.chat-widget__input', 'placeholder'), 'Ajoute un message (facultatif)…')

    // Envoyée seule (sans texte) : l'image part avec le message, et reste visible au-dessus de la réponse.
    await page.click('.chat-widget__send')
    await page.waitForSelector('.chat-widget__question-image')
    const sent = await page.evaluate(() => window.__sent.at(-1))
    assert.equal(sent[0], '')
    assert.ok(typeof sent[1] === 'string' && sent[1].length > 20 && !sent[1].startsWith('data:'), 'l’image part en base64, sans préfixe')
  })
})
