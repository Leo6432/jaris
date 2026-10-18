import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

/**
 * Étape 325 (bêta de l'étape 324) : « Parler à Jaris », le clic sur l'orbe et la touche « + » ne faisaient RIEN de
 * visible quand l'écoute n'était pas prête (pipeline pas encore créé, programme d'écoute qui charge, en échec ou
 * arrêté) — et « + » dépliait même le widget vocal pour rien. Et sans pavé numérique, la barre du widget Chat
 * n'était pas joignable du tout : son indicateur rouvrait toute l'application.
 *
 * Ce test EXÉCUTE le vrai code de main.ts (openChatWidgetBar, reportWakeUnavailable, triggerVisibleWake), extrait du
 * fichier et lancé avec des doublures pour les fenêtres, le pipeline et les notifications — pas seulement une
 * recherche de motifs dans le source (test-widget-mode.mjs s'en charge).
 */
const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')

function fixture({ mode = 'voice', fullVisible = false, pipelineState = 'ready', now = 1_000_000 } = {}) {
  const start = main.indexOf('function openChatWidgetBar()')
  const end = main.indexOf('/** Dès que la souris quitte la barre Chat')
  assert.ok(start > 0 && end > start, 'openChatWidgetBar … triggerVisibleWake introuvables dans main.ts')
  const source = `${main.slice(start, end)}
exports.triggerVisibleWake = triggerVisibleWake
exports.openChatWidgetBar = openChatWidgetBar`

  const calls = { shown: [], broadcasts: [], notifications: [], triggers: 0 }
  const reasons = { loading: 'voice.starting', failed: 'voice.startFailed', off: 'voice.notRunning', ready: null }
  const state = { current: pipelineState }
  const pipeline =
    pipelineState === null
      ? null
      : { listeningUnavailable: () => reasons[state.current], triggerWake: () => { calls.triggers += 1 } }
  class Notification {
    constructor(options) { this.options = options }
    static isSupported() { return true }
    show() { calls.notifications.push(JSON.stringify(this.options)) }
  }
  const context = {
    exports: {},
    startupRevealed: true,
    activeMode: mode,
    modeWithoutWidget: () => mode === 'code' || mode === 'image' || mode === 'video',
    fullWindow: { isDestroyed: () => false, isVisible: () => fullVisible, isMinimized: () => false },
    showWidgetWindow: (forceExpanded = false) => calls.shown.push(forceExpanded),
    pipeline,
    t: (key) => key,
    broadcast: (channel, payload) => calls.broadcasts.push(`${channel} ${JSON.stringify(payload)}`),
    IPC_CHANNELS: { wakeAvailability: 'jaris:wake-availability' },
    Notification,
    Date: { now: () => context.__now },
    __now: now
  }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return { ...context.exports, calls, context, state }
}

test('écoute prête : « + » déplie le widget vocal et réveille Jaris, et l’écran efface une raison affichée', () => {
  const f = fixture()
  f.triggerVisibleWake()
  assert.equal(JSON.stringify(f.calls.shown), '[true]')
  assert.equal(f.calls.triggers, 1)
  assert.equal(JSON.stringify(f.calls.broadcasts), JSON.stringify(['jaris:wake-availability {"reason":null,"attempt":true}']))
  assert.equal(f.calls.notifications.length, 0)
})

for (const pipelineState of ['loading', 'failed', 'off', null]) {
  test(`écoute pas prête (${pipelineState ?? 'pipeline pas encore créé'}) : rien n’est déplié ni envoyé, la raison est donnée`, () => {
    const f = fixture({ pipelineState })
    f.triggerVisibleWake()
    assert.equal(f.calls.shown.length, 0, 'le widget vocal se déplie pour rien (zone invisible qui capte les clics)')
    assert.equal(f.calls.triggers, 0, '« trigger » envoyé à un programme d’écoute qui ne peut pas y répondre')
    const expected = { loading: 'voice.starting', failed: 'voice.startFailed', off: 'voice.notRunning' }[pipelineState] ?? 'main.voiceNotReady'
    assert.equal(JSON.stringify(f.calls.broadcasts), JSON.stringify([`jaris:wake-availability {"reason":"${expected}","attempt":true}`]))
    // Jaris réduit (grande fenêtre cachée) : l'écran vocal n'est pas visible, c'est Windows qui le dit.
    assert.equal(f.calls.notifications.length, 1, 'Jaris réduit : la raison doit être dite par une notification')
    assert.match(f.calls.notifications[0], new RegExp(`"body":"${expected}"`))
  })
}

test('fenêtre de Jaris affichée : la raison va à l’écran vocal, sans notification en plus', () => {
  const f = fixture({ pipelineState: 'loading', fullVisible: true })
  f.triggerVisibleWake()
  assert.equal(f.calls.broadcasts.length, 1)
  assert.equal(f.calls.notifications.length, 0)
})

test('la même raison n’est pas renotifiée à chaque pression de « + » ; une nouvelle raison, ou 30 s plus tard, si', () => {
  const f = fixture({ pipelineState: 'loading' })
  f.triggerVisibleWake()
  f.context.__now += 5_000
  f.triggerVisibleWake()
  assert.equal(f.calls.notifications.length, 1, 'une notification par pression de +')
  assert.equal(f.calls.broadcasts.length, 2, 'l’écran vocal doit toujours recevoir chaque essai')
  // Le chargement échoue : c'est une autre raison, dite tout de suite.
  f.state.current = 'failed'
  f.context.__now += 1_000
  f.triggerVisibleWake()
  assert.equal(f.calls.notifications.length, 2, 'une nouvelle raison doit être dite tout de suite')
  f.context.__now += 60_000
  f.triggerVisibleWake()
  assert.equal(f.calls.notifications.length, 3, 'passé 30 s, la même raison doit être redonnée')
})

test('mode Chat : « + » et le clic sur l’indicateur ouvrent la barre, sans dépendre de l’écoute', () => {
  for (const open of ['triggerVisibleWake', 'openChatWidgetBar']) {
    const f = fixture({ mode: 'chat', pipelineState: 'loading' })
    f[open]()
    assert.equal(JSON.stringify(f.calls.shown), '[true]', `${open} n’ouvre pas la barre de saisie`)
    assert.equal(f.calls.broadcasts.length, 0, 'la barre du Chat n’a rien à voir avec l’écoute vocale')
    assert.equal(f.calls.notifications.length, 0)
  }
})

test('clic sur un indicateur périmé : jamais de barre hors du mode Chat ni par-dessus la grande fenêtre', () => {
  for (const options of [{ mode: 'voice' }, { mode: 'code' }, { mode: 'chat', fullVisible: true }]) {
    const f = fixture(options)
    f.openChatWidgetBar()
    assert.equal(f.calls.shown.length, 0, JSON.stringify(options))
  }
})
