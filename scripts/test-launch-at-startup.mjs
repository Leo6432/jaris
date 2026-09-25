import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

/**
 * Lancer Jaris au démarrage de Windows (étape 165, Léo : « dès que le PC démarre on voit la fenêtre Jaris et
 * pas le fond d'écran, et pour l'activer/désactiver »).
 *
 * Deux parties : la logique de launchAtStartup.ts (testée pour de vrai avec un faux `app` qui imite
 * l'entrée de démarrage de Windows), et le branchement dans main.ts (test STRUCTUREL : pas de vraie
 * ouverture de session Windows dans cet environnement).
 */
const projectRoot = fileURLToPath(new URL('..', import.meta.url))

function loadService() {
  const source = ts.transpileModule(readFileSync(join(projectRoot, 'electron/services/launchAtStartup.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  vm.runInThisContext(`(function (exports, require, module) {${source}\n})`)(module.exports, () => ({}), module)
  return module.exports
}

const service = loadService()

/** Imite l'entrée Run du registre : `getLoginItemSettings` ne la retrouve qu'avec les MÊMES arguments. */
function fakeApp({ isPackaged = true, disabledInTaskManager = false } = {}) {
  let entry = null
  return {
    isPackaged,
    calls: [],
    getLoginItemSettings(options) {
      const found = entry !== null && JSON.stringify(entry.args ?? []) === JSON.stringify(options?.args ?? [])
      return { openAtLogin: found, executableWillLaunchAtLogin: found && !disabledInTaskManager }
    },
    setLoginItemSettings(settings) {
      this.calls.push(settings)
      entry = settings.openAtLogin ? { args: settings.args } : null
    }
  }
}

test('activer puis désactiver : l’état affiché est celui réellement enregistré', () => {
  const app = fakeApp()
  assert.deepEqual(service.getLaunchAtStartup(app, 'win32'), { supported: true, enabled: false, blockedByWindows: false })
  assert.deepEqual(service.setLaunchAtStartup(app, 'win32', true), { supported: true, enabled: true, blockedByWindows: false })
  assert.deepEqual(service.setLaunchAtStartup(app, 'win32', false), { supported: true, enabled: false, blockedByWindows: false })
})

test('la commande enregistrée porte l’argument qui fait afficher la fenêtre au démarrage', () => {
  const app = fakeApp()
  service.setLaunchAtStartup(app, 'win32', true)
  assert.deepEqual(app.calls[0].args, [service.LOGIN_LAUNCH_ARG])
  assert.equal(service.wasLaunchedAtLogin(['Jaris.exe', service.LOGIN_LAUNCH_ARG]), true)
  assert.equal(service.wasLaunchedAtLogin(['Jaris.exe']), false)
})

test('désactivé dans les applications de démarrage de Windows : signalé, jamais affiché comme « ça marche »', () => {
  const app = fakeApp({ disabledInTaskManager: true })
  assert.deepEqual(service.setLaunchAtStartup(app, 'win32', true), { supported: true, enabled: true, blockedByWindows: true })
})

test('version de développement ou autre système : rien n’est enregistré', () => {
  for (const [app, platform] of [[fakeApp({ isPackaged: false }), 'win32'], [fakeApp(), 'linux']]) {
    assert.deepEqual(service.setLaunchAtStartup(app, platform, true), { supported: false, enabled: false, blockedByWindows: false })
    assert.equal(app.calls.length, 0, 'aucune entrée de démarrage ne doit être posée')
  }
})

const mainSource = ts.transpileModule(readFileSync(join(projectRoot, 'electron/main.ts'), 'utf8'), {
  compilerOptions: { removeComments: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText

test('main.ts : lancé au démarrage, la fenêtre principale s’affiche en grand et le widget ne s’impose pas', () => {
  assert.match(mainSource, /revealAtLogin = onboardingDone && wasLaunchedAtLogin\(process\.argv\)/)
  const reveal = /if \(revealAtLogin\) \{[\s\S]*?setAlwaysOnTop\(false\)/.exec(mainSource)
  assert.ok(reveal, 'bloc d’affichage au démarrage introuvable')
  assert.match(reveal[0], /maximize\(\)/, 'la fenêtre doit couvrir le bureau')
  assert.match(reveal[0], /showFullWindow\(\)/, 'la fenêtre doit être affichée ET recevoir le focus')
  assert.match(mainSource, /once\('ready-to-show', \(\) => \{\s*if \(!revealAtLogin\)\s*showWidgetWindow\(\)/)
})

test('main.ts : la perte de focus pendant l’ouverture de session ne replie pas la fenêtre en widget', () => {
  const blurHandler = /win\.on\(['"]blur['"],[\s\S]{0,400}?\}\);/.exec(mainSource)
  assert.ok(blurHandler, "handler 'blur' introuvable")
  assert.match(blurHandler[0], /Date\.now\(\) < loginRevealUntil/)
})

test('main.ts : l’interrupteur passe par l’état réel de Windows (canaux get/set branchés)', () => {
  assert.match(mainSource, /IPC_CHANNELS\.getLaunchAtStartup, \(\) => getLaunchAtStartup\(app, process\.platform\)/)
  assert.match(mainSource, /IPC_CHANNELS\.setLaunchAtStartup,[\s\S]{0,80}setLaunchAtStartup\(app, process\.platform, enabled\)/)
})
