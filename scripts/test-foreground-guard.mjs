import assert from 'node:assert/strict'
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
