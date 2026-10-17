import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

/**
 * Fin de la configuration (bouton « Continuer » de « Configuration terminée ») : la fenêtre de Jaris DISPARAISSAIT
 * et il ne restait que la petite pastille du widget en haut de l'écran — un nouvel utilisateur croyait que
 * l'application s'était fermée, au moment précis où il voulait commencer. Même règle qu'au démarrage normal
 * (étape 295) : la fenêtre reste ouverte, le widget est seulement préparé, caché, pour prendre le relais quand on
 * la réduit ou qu'on passe sur une autre application.
 *
 * Pas de Windows ni de vraie fenêtre Electron ici : on exécute le VRAI code de main.ts (le gestionnaire de fin de
 * configuration, les handlers 'blur'/'minimize' de la fenêtre, showFullWindow, showWidgetWindow…) avec de fausses
 * fenêtres qui retiennent ce qu'on leur a demandé.
 */
const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** Une fonction de premier niveau de main.ts, jusqu'à son accolade fermante en colonne 0. */
function topLevelFunction(name) {
  const start = main.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} introuvable dans main.ts`)
  return main.slice(start, main.indexOf('\n}\n', start) + 2)
}

/** Un handler posé sur la fenêtre principale dans createFullWindow (`win.on('blur', ...)`). */
function fullWindowHandler(event) {
  const create = main.indexOf('function createFullWindow(')
  const start = main.indexOf(`  win.on('${event}', () => {`, create)
  assert.ok(create >= 0 && start >= 0, `handler '${event}' de la fenêtre principale introuvable`)
  return main.slice(start, main.indexOf('\n  })\n', start) + 5)
}

function onboardingHandler() {
  const start = main.indexOf('  ipcMain.on(IPC_CHANNELS.onboardingFinished,')
  assert.ok(start >= 0, 'gestionnaire de fin de configuration introuvable')
  return main.slice(start, main.indexOf('\n  })\n', start) + 5)
}

const GRACE_MS = Number(/const STARTUP_REVEAL_GRACE_MS = ([\d_]+)/.exec(main)?.[1].replace(/_/g, ''))

function fakeWindow(name, { visible = false, focused = false } = {}) {
  const win = {
    name,
    visible,
    focused,
    calls: [],
    handlers: {},
    isDestroyed: () => false,
    isVisible: () => win.visible,
    isMinimized: () => false,
    show() { win.calls.push('show'); win.visible = true; win.focused = true },
    showInactive() { win.calls.push('showInactive'); win.visible = true },
    hide() { win.calls.push('hide'); win.visible = false; win.focused = false },
    focus() { win.calls.push('focus'); win.focused = true },
    restore() { win.calls.push('restore') },
    moveTop() { win.calls.push('moveTop') },
    setAlwaysOnTop() {},
    on(event, handler) { win.handlers[event] = handler },
    webContents: { send() {}, invalidate() {} }
  }
  return win
}

/**
 * Premier lancement, juste avant le clic sur « Continuer » : la fenêtre de configuration est affichée et a le focus,
 * le widget n'existe pas encore (il n'est créé au démarrage que si la configuration était déjà faite), et aucun écran
 * de démarrage ne retient l'affichage (`startupRevealed` vaut vrai au premier lancement).
 */
function firstLaunch() {
  let clock = 1_000_000
  const timers = []
  const createdWidgets = []
  const ipcHandlers = {}
  const fullWindow = fakeWindow('principale', { visible: true, focused: true })
  const context = {
    Date: { now: () => clock },
    setTimeout: (fn) => { timers.push(fn); return timers.length },
    clearTimeout: () => {},
    ipcMain: { on: (channel, handler) => { ipcHandlers[channel] = handler } },
    IPC_CHANNELS: { onboardingFinished: 'onboarding-finished', widgetMode: 'widget-mode' },
    STARTUP_REVEAL_GRACE_MS: GRACE_MS,
    WIDGET_AFTER_BLUR_DELAY_MS: 80,
    onboardingDone: false,
    startupRevealed: true,
    quitting: false,
    dialogOpen: false,
    optionsOpen: false,
    activeMode: 'voice',
    revealGraceUntil: 0,
    lastEmotion: 'idle',
    displayedWidgetMode: 'voice',
    pilotTasks: 0,
    pilotBorrowing: false,
    fullWindow,
    widgetWindow: null,
    splashWindow: null,
    createWidgetWindow: () => {
      const widget = fakeWindow('widget')
      createdWidgets.push(widget)
      return widget
    },
    createFullWindow: () => { throw new Error('la fenêtre principale ne doit jamais être recréée') },
    positionWidgetWindow: () => {},
    stopChatPointerWatch: () => {},
    startChatPointerWatch: () => {},
    applyPilotWidgetGuard: () => {},
    applyListeningForActiveMode: () => {}
  }
  const source = [
    ...['showFullWindow', 'hasWidgetToShow', 'modeWithoutWidget', 'currentWidgetMode', 'revealWidgetAfterLeaving', 'showWidgetWindow'].map(topLevelFunction),
    // Les handlers de la fenêtre sont posés sur la fausse fenêtre principale, comme createFullWindow le fait.
    'const win = fullWindow',
    fullWindowHandler('minimize'),
    fullWindowHandler('blur'),
    onboardingHandler()
  ].join('\n')
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return {
    context,
    fullWindow,
    createdWidgets,
    finishOnboarding: () => ipcHandlers['onboarding-finished'](),
    advance: (ms) => { clock += ms },
    /** Les minuteurs en attente, y compris ceux qu'ils programment eux-mêmes (vérification 400 ms plus tard). */
    flushTimers: () => { while (timers.length) timers.shift()() }
  }
}

test('« Continuer » ne cache plus la fenêtre : elle reste ouverte et au premier plan', () => {
  assert.ok(GRACE_MS > 0, 'STARTUP_REVEAL_GRACE_MS introuvable dans main.ts')
  const s = firstLaunch()
  s.finishOnboarding()
  assert.equal(s.context.onboardingDone, true)
  assert.equal(s.fullWindow.visible, true, 'la fenêtre de Jaris a disparu à la fin de la configuration')
  assert.ok(!s.fullWindow.calls.includes('hide'), `la fenêtre a été cachée (${s.fullWindow.calls.join(', ')})`)
  assert.equal(s.fullWindow.focused, true, 'la fenêtre doit rester au premier plan')
  s.flushTimers()
  assert.equal(s.fullWindow.visible, true, 'la fenêtre ne doit pas se cacher un peu plus tard non plus')
})

// Le widget doit exister même caché : c'est lui qui porte le lecteur audio des réponses parlées (App.tsx), y compris
// quand on parle à Jaris depuis la grande fenêtre — sans lui, les premières réponses vocales seraient muettes.
test('le widget est préparé, caché, et une seule fois', () => {
  const s = firstLaunch()
  s.finishOnboarding()
  assert.equal(s.createdWidgets.length, 1, 'le widget doit exister après la configuration')
  assert.equal(s.context.widgetWindow, s.createdWidgets[0])
  const widget = s.createdWidgets[0]
  assert.equal(widget.visible, false, `le widget ne doit pas s'afficher par-dessus la fenêtre (${widget.calls.join(', ')})`)
  // Un second signal (double clic sur « Continuer ») ne fabrique pas un deuxième widget.
  s.finishOnboarding()
  assert.equal(s.createdWidgets.length, 1)
})

test('dès la fin de la configuration, passer sur une autre application replie Jaris dans le widget préparé', () => {
  const s = firstLaunch()
  s.finishOnboarding()
  s.advance(GRACE_MS + 1)
  s.fullWindow.handlers.blur()
  assert.equal(s.fullWindow.visible, false, 'changer d’application doit replier Jaris')
  s.flushTimers()
  const widget = s.createdWidgets[0]
  assert.equal(widget.visible, true, 'le widget doit prendre le relais')
  assert.ok(widget.calls.includes('showInactive'), 'le widget ne doit pas reprendre le focus à l’autre application')
  assert.equal(s.createdWidgets.length, 1, 'c’est le widget préparé qui sert, pas un nouveau')
})

test('dès la fin de la configuration, réduire la fenêtre montre aussi le widget', () => {
  const s = firstLaunch()
  s.finishOnboarding()
  s.fullWindow.handlers.minimize()
  assert.equal(s.fullWindow.visible, false)
  assert.equal(s.createdWidgets[0].visible, true)
})

test('une perte de focus passagère juste au clic sur « Continuer » ne replie pas la fenêtre', () => {
  const s = firstLaunch()
  s.finishOnboarding()
  s.advance(200)
  s.fullWindow.handlers.blur()
  s.flushTimers()
  assert.equal(s.fullWindow.visible, true)
  assert.equal(s.createdWidgets[0].visible, false)
})
