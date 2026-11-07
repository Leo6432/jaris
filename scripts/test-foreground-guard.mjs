import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 346 (« ouvre un bloc-notes et écris bonjour ») : après une ouverture d'application, le texte n'est tapé que si
 * cette application est au premier plan — jamais dans la fenêtre au hasard qui a le focus (Jaris lui-même…).
 */
const { foregroundMatchesApp, waitForForegroundApp } = loadTsModule('electron/services/inputControl.ts', {
  child_process: { spawn: () => assert.fail('aucun programme lancé'), execFile: () => assert.fail('aucun programme lancé') }
})

test('le titre ou le programme de la fenêtre au premier plan désigne bien l’application ouverte', () => {
  assert.equal(foregroundMatchesApp('Sans titre - Bloc-notes\tnotepad', 'Bloc-notes'), true)
  assert.equal(foregroundMatchesApp('Nouvel onglet - Google Chrome\tchrome', 'Google Chrome'), true)
  assert.equal(foregroundMatchesApp('Artiste - Chanson\tSpotify', 'Spotify'), true)
  assert.equal(foregroundMatchesApp('Jaris\tJaris', 'Bloc-notes'), false)
  assert.equal(foregroundMatchesApp('Paramètres\tSystemSettings', 'Paramètres'), true)
})

test('attend que l’application passe au premier plan, sans dépasser le délai', async () => {
  const seen = ['Jaris\tJaris', 'Jaris\tJaris', 'Sans titre - Bloc-notes\tnotepad']
  let reads = 0
  const ok = await waitForForegroundApp('Bloc-notes', 6000, async () => seen[Math.min(reads++, seen.length - 1)], async () => {})
  assert.equal(ok, true)
  assert.equal(reads, 3)
  let clock = 0
  const realNow = Date.now
  Date.now = () => clock
  try {
    const never = await waitForForegroundApp('Bloc-notes', 1000, async () => 'Jaris\tJaris', async (ms) => void (clock += ms))
    assert.equal(never, false)
  } finally {
    Date.now = realNow
  }
})

test('tools.ts : un texte tapé juste après une ouverture attend l’application, et sinon n’est pas tapé', () => {
  const tools = readFileSync(new URL('../electron/services/tools.ts', import.meta.url), 'utf8')
  const typeCase = tools.slice(tools.indexOf("case 'type_text':"), tools.indexOf("case 'press_key':"))
  assert.match(typeCase, /if \(openedApp\)[\s\S]*waitForForegroundApp\(app\)[\s\S]*throw new Error\(t\('tool\.typeText\.notForeground'/)
  assert.ok(typeCase.indexOf('waitForForegroundApp') < typeCase.indexOf('typeText('), 'vérifié AVANT de taper')
  assert.match(tools, /openedApp = launchedAppName\(result\) \?\? openedApp/)
})

/**
 * Relecture croisée : taper, appuyer sur une touche ou cliquer lançait PowerShell SANS limite. Un PowerShell figé
 * (Windows qui ne répond plus, compilation bloquée par un antivirus) laissait toute la réponse de Jaris attendre pour
 * toujours. Au-delà du délai, PowerShell est arrêté et l'action échoue avec un vrai message.
 */
function frozenPowerShell() {
  const spawned = []
  const child_process = {
    spawn: () => {
      const proc = new EventEmitter()
      proc.stderr = new EventEmitter()
      proc.pid = 4321 + spawned.length
      proc.killed = false
      proc.kill = () => {
        proc.killed = true
      }
      spawned.push(proc)
      return proc
    },
    // Sous Windows (la CI), tout l'arbre est arrêté par taskkill ; ailleurs, par kill().
    execFile: (file, args, _options, callback) => {
      assert.equal(file, 'taskkill', 'aucun autre programme lancé')
      const proc = spawned.find((p) => String(p.pid) === args[1])
      proc.killed = true
      callback?.(null)
    }
  }
  return { spawned, input: loadTsModule('electron/services/inputControl.ts', { child_process }) }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('PowerShell figé : arrêté au bout du délai, avec un vrai message ; un long texte a droit à plus de temps', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { spawned, input } = frozenPowerShell()
  let result = null
  void input.pressKey('entrée').then((text) => (result = text))
  t.mock.timers.tick(30_000 - 1)
  await flush()
  assert.equal(result, null, 'abandonné trop tôt')
  t.mock.timers.tick(1)
  await flush()
  assert.equal(result, "Échec de l'appui sur la touche : pas de réponse de Windows en 30 s, action arrêtée")
  assert.equal(spawned[0].killed, true, 'PowerShell figé laissé en vie')

  // 5 000 caractères tapés à 5 ms chacun : 25 s de frappe, jamais coupés au bout de 30 s pile.
  let typed = null
  void input.typeText('x'.repeat(5000)).then((text) => (typed = text))
  t.mock.timers.tick(30_000 + 1000)
  await flush()
  assert.equal(typed, null, 'un long texte coupé alors qu’il se tape encore')
  t.mock.timers.tick(5000 * 10)
  await flush()
  assert.match(typed, /^Échec de la saisie du texte : pas de réponse de Windows en 80 s/)
  assert.equal(spawned[1].killed, true)
  assert.equal(input.POWERSHELL_TIMEOUT_MS, 30_000)
  assert.equal(input.TYPE_TIMEOUT_PER_CHAR_MS, 10)
})
