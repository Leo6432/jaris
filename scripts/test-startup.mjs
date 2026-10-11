import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 294 — démarrage de Jaris (Léo : « quand on ouvre Jaris, tout est pas ok, il y a les modèles qui se lancent…
 * je veux que ça se lance quand tout est ok »). Un écran de démarrage attend le moteur (Ollama), l'écoute, la voix et
 * le modèle préchargé, puis Jaris apparaît. Deux risques opposés, tous deux vérifiés ici : afficher Jaris trop tôt
 * (le défaut signalé), et ne JAMAIS l'afficher (une étape qui échoue ou qui traîne ne doit pas bloquer l'écran).
 */
const { StartupProgress, STARTUP_STEPS, STARTUP_DEADLINE_MS } = loadTsModule('electron/services/startupProgress.ts', { events: await import('node:events') })

function fakeTimers() {
  const pending = []
  return {
    timers: {
      setTimeout: (fn, ms) => {
        const handle = { fn, ms, cleared: false }
        pending.push(handle)
        return handle
      },
      clearTimeout: (handle) => {
        if (handle) handle.cleared = true
      }
    },
    fire: () => pending.filter((h) => !h.cleared).forEach((h) => h.fn()),
    pending
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('les quatre étapes attendues, dans l’ordre annoncé à l’écran, et un délai maximal raisonnable', () => {
  assert.deepEqual([...STARTUP_STEPS], ['engine', 'listening', 'voice', 'brain'])
  assert.ok(STARTUP_DEADLINE_MS >= 30_000 && STARTUP_DEADLINE_MS <= 180_000, `${STARTUP_DEADLINE_MS} ms`)
})

test('Jaris n’est prêt que quand TOUTES les étapes sont terminées', () => {
  const clock = fakeTimers()
  const progress = new StartupProgress(['engine', 'voice'], 90_000, clock.timers)
  let readyCount = 0
  progress.on('ready', () => readyCount++)
  assert.equal(progress.ready, false)
  progress.set('engine', 'running')
  progress.set('engine', 'done')
  assert.equal(progress.ready, false, 'une étape encore en attente retient l’écran')
  progress.set('voice', 'done')
  assert.equal(progress.ready, true)
  assert.equal(readyCount, 1)
  assert.equal(clock.pending[0].cleared, true, 'le délai maximal est annulé une fois prêt')
})

test('une étape qui ÉCHOUE ne bloque pas l’écran (les messages habituels de Jaris diront ce qui manque)', async () => {
  const progress = new StartupProgress(['engine', 'listening'], 90_000, fakeTimers().timers)
  progress.track('engine', Promise.resolve(false))
  progress.track('listening', Promise.reject(new Error('micro absent')))
  await flush()
  assert.deepEqual(progress.state().steps, [
    { id: 'engine', state: 'failed' },
    { id: 'listening', state: 'failed' }
  ])
  assert.equal(progress.state().ready, true)
  assert.equal(progress.state().timedOut, false)
})

test('une étape qui traîne : Jaris s’affiche quand même au délai maximal, le reste continue', () => {
  const clock = fakeTimers()
  const progress = new StartupProgress(['engine', 'listening'], 90_000, clock.timers)
  progress.set('engine', 'done')
  progress.set('listening', 'running')
  let ready = null
  progress.whenReady(() => (ready = progress.state()))
  assert.equal(ready, null)
  clock.fire()
  assert.equal(ready.ready, true)
  assert.equal(ready.timedOut, true)
  // Ce qui finit après le délai est encore noté, sans réannoncer « prêt ».
  let again = 0
  progress.on('ready', () => again++)
  progress.set('listening', 'done')
  assert.equal(again, 0)
  assert.equal(progress.state().timedOut, false)
})

test('une étape terminée ne revient jamais en arrière (le moteur vocal relancé plus tard ne rouvre rien)', () => {
  const progress = new StartupProgress(['listening'], 90_000, fakeTimers().timers)
  progress.set('listening', 'done')
  progress.set('listening', 'running')
  progress.set('listening', 'failed')
  assert.deepEqual(progress.state().steps, [{ id: 'listening', state: 'done' }])
})

test('whenReady après coup : appelé tout de suite', () => {
  const progress = new StartupProgress(['engine'], 90_000, fakeTimers().timers)
  progress.set('engine', 'done')
  let called = false
  progress.whenReady(() => (called = true))
  assert.equal(called, true)
})

// --- Câblage dans le processus principal (structurel : pas d'Electron ici) --------------------------------------
const main = ts.transpileModule(readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8'), {
  compilerOptions: { removeComments: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText

const body = (name) => {
  const start = main.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} introuvable`)
  return main.slice(start, main.indexOf('\n}\n', start))
}

test('rien ne s’affiche avant la fin du démarrage : widget, grande fenêtre, touche +, surveillance du widget', () => {
  assert.match(body('showWidgetWindow'), /^function showWidgetWindow\([^)]*\) \{\s*if \(!startupRevealed\)\s*return;/)
  assert.match(body('showFullWindow'), /^function showFullWindow\(\) \{\s*if \(!startupRevealed\) \{\s*if \(splashWindow && !splashWindow\.isDestroyed\(\)\) \{\s*splashWindow\.show\(\);\s*splashWindow\.focus\(\);/)
  assert.match(body('triggerVisibleWake'), /if \(!startupRevealed \|\| modeWithoutWidget\(\)\)\s*return;/)
  assert.match(body('watchWidgetPresence'), /!startupRevealed/)
})

test('l’écran de démarrage n’existe qu’après la configuration ; au tout premier lancement rien n’est retenu', () => {
  assert.match(main, /if \(onboardingDone\)\s*splashWindow = createSplashWindow\(\);\s*else\s*startupRevealed = true;/)
  // Créé AVANT les autres fenêtres : il doit apparaître le plus tôt possible.
  assert.ok(main.indexOf('splashWindow = createSplashWindow()') < main.indexOf('fullWindow = createFullWindow(!onboardingDone)'))
})

test('les quatre étapes sont vraiment suivies, et la recherche web (Docker) ne retient jamais l’écran', () => {
  assert.match(main, /startup\.track\('listening', startVoicePipeline\(\)\.then\(\(\) => lastSetupStatus\.ready\)\)/)
  assert.match(main, /startup\.track\('voice', ttsClient\.start\(\)\.then\(\(\) => true\)\)/)
  assert.match(main, /startup\.track\('engine', engineUp\)/)
  assert.match(main, /startup\.track\('brain', engineUp\.then\(\(up\) => up && warmUpConversationModel\(\)\)\)/)
  assert.doesNotMatch(main, /startup\.track\([^)]*[Ss]earxng/)
  // Seulement au premier démarrage du pipeline : un changement de micro relance le pipeline, pas l'écran.
  assert.match(main, /if \(!startupEngineTracked\) \{\s*startupEngineTracked = true;/)
})

test('affichage : seulement quand tout est prêt ET que les fenêtres ont fini leur premier rendu', () => {
  assert.match(main, /const windowsLoaded = Promise\.all\(\[windowLoaded\(fullWindow\), windowLoaded\(widgetWindow\)\]\)/)
  assert.match(main, /startup\.whenReady\(\(\) => void windowsLoaded\.then\(\(\) => revealAfterStartup\(revealAtLogin\)\)\)/)
  // Une fenêtre qui ne finirait jamais de charger ne bloque pas tout.
  assert.match(body('windowLoaded'), /setTimeout\(resolve, SPLASH_WINDOWS_LOAD_LIMIT_MS\)/)
  // La carte joue sa sortie avant que Jaris n'apparaisse.
  assert.match(body('revealAfterStartup'), /setTimeout\(\(\) => \{\s*startupRevealed = true;/)
  assert.match(body('revealAfterStartup'), /\}, SPLASH_EXIT_MS\)/)
})

test('fermer l’écran de démarrage avant la fin quitte Jaris (et pas l’inverse une fois affiché)', () => {
  const splash = body('createSplashWindow')
  assert.match(splash, /win\.on\('close', \(\) => \{\s*if \(startupRevealed \|\| quitting\)\s*return;\s*quitting = true;\s*app\.quit\(\);/)
  assert.match(splash, /loadRenderer\(win, 'splash'\)/)
  // Jaris le referme lui-même avec destroy() — qui ne passe pas par 'close' — après avoir marqué l'affichage.
  assert.match(body('revealAfterStartup'), /startupRevealed = true;[\s\S]*splash\.destroy\(\)/)
})

test('l’écran de démarrage reçoit l’avancement (diffusé aussi à sa fenêtre)', () => {
  assert.match(body('broadcast'), /\[fullWindow, widgetWindow, splashWindow\]/)
  assert.match(main, /startup\.on\('change', \(state\) => broadcast\(IPC_CHANNELS\.startupState, state\)\)/)
  assert.match(main, /ipcMain\.handle\(IPC_CHANNELS\.getStartupState, \(\) => startup\.state\(\)\)/)
})
