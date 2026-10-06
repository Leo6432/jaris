import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { modelChoiceModule } from './load-model-choice.mjs'
import { systemPromptModule } from './load-system-prompt.mjs'
import { loadPhoneModules } from './phone-test-loader.mjs'

/**
 * Étape 214 (Léo : « tout sauf le risqué » depuis le téléphone) : la VRAIE boucle de conversation, avec les
 * VRAIES restrictions du téléphone. Si quelqu'un vole le téléphone, il ne doit jamais pouvoir taper, cliquer,
 * regarder l'écran ni éteindre le PC — même si le modèle invente un appel à ces outils.
 */

const transpile = (path) =>
  ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText

const TOOL_NAMES = [...readFileSync(new URL('../electron/services/tools.ts', import.meta.url), 'utf8').matchAll(/^\s+name: '([a-z_]+)',/gm)].map((m) => m[1])
const TOOLS = TOOL_NAMES.map((name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } }))
const { PHONE_ALLOWED_TOOLS, PHONE_RESTRICTIONS, PHONE_REFUSAL, phoneStatusFromLog } = loadPhoneModules().load('phoneAccess')

const noteExports = {}
vm.runInNewContext(transpile('../electron/services/notepad.ts'), { exports: noteExports, require: (name) => (name === 'util' ? { promisify: () => {} } : {}) })

function setup(chat, execute, writeNote = async () => assert.fail('aucun document ne doit être écrit')) {
  const modules = {
    '../config': { config: { ollama: { model: 'test', visionModel: 'vision', numCtx: 8192 } } },
    './ollama': { chatWithOllama: chat, listInstalledModels: async () => ['test'] },
    './systemPrompt': systemPromptModule,
    './memoryStore': { listMemoryTitles: async () => [] },
    './profileStore': { getProfile: async () => null },
    './notepad': { requestedNotepadText: noteExports.requestedNotepadText, openNotepadText: writeNote },
    './appLauncher': { didAppLaunch: (result) => result.endsWith('a été lancé.') },
    './hardwareScan': { GPU_TEMP_LIMIT_C: 85 },
    './modelChoice': modelChoiceModule,
    // Journal des demandes (étape 245) : rien n'est écrit sur le disque pendant les tests.
    './requestJournal': { startJournalEntry: () => ({ line() {}, timed() {}, end: async () => {} }), describeModelCall: () => '' },
    './resourceMonitor': { checkOverloadWarning: async () => null },
    './tools': { TOOLS, createToolExecutor: () => execute }
  }
  const exports = {}
  vm.runInNewContext(transpile('../electron/services/assistant.ts'), { exports, Error, require: (name) => modules[name] })
  return (prompt, restrictions) => exports.converse(prompt, null, () => {}, undefined, [], undefined, undefined, 'chat', undefined, undefined, undefined, restrictions)
}

test('liste blanche : uniquement des outils qui existent, et aucun outil qui agit sur le PC à ta place', () => {
  assert.ok(TOOL_NAMES.length >= 10, 'lecture de tools.ts')
  for (const name of PHONE_ALLOWED_TOOLS) assert.ok(TOOL_NAMES.includes(name), `${name} n'existe plus dans tools.ts`)
  for (const risky of ['type_text', 'press_key', 'click_mouse', 'computer_use_task', 'shutdown_pc', 'look_at_screen', 'media_control']) {
    assert.ok(TOOL_NAMES.includes(risky), `${risky} : nom à revérifier dans tools.ts`)
    assert.equal(PHONE_ALLOWED_TOOLS.has(risky), false, `${risky} ne doit jamais être disponible depuis le téléphone`)
  }
})

test('depuis le téléphone, le modèle ne reçoit que les outils autorisés, et sait pourquoi', async () => {
  let seen = null
  let system = ''
  const converse = setup(async (messages, tools) => {
    seen = tools.map((t) => t.function.name)
    system = messages[0].content
    return { role: 'assistant', content: 'Bonjour !' }
  }, async () => assert.fail('aucun outil'))
  assert.equal(await converse('Raconte une blague', PHONE_RESTRICTIONS), 'Bonjour !')
  assert.deepEqual(new Set(seen), PHONE_ALLOWED_TOOLS)
  assert.match(system, /téléphone/)
})

test('sans restriction (PC), tous les outils restent disponibles comme avant', async () => {
  let seen = null
  const converse = setup(async (_messages, tools) => {
    seen = tools.map((t) => t.function.name)
    return { role: 'assistant', content: 'ok' }
  }, async () => assert.fail('aucun outil'))
  await converse('Raconte une blague')
  assert.deepEqual(seen, TOOL_NAMES)
})

for (const forbidden of ['type_text', 'click_mouse', 'shutdown_pc', 'look_at_screen', 'computer_use_task']) {
  test(`outil interdit inventé par le modèle (${forbidden}) : jamais exécuté, refus clair`, async () => {
    let executed = 0
    const converse = setup(
      async () => ({ role: 'assistant', content: '', tool_calls: [{ function: { name: forbidden, arguments: {} } }] }),
      async () => {
        executed++
        return 'fait'
      }
    )
    assert.equal(await converse('Fais-le', PHONE_RESTRICTIONS), PHONE_REFUSAL)
    assert.equal(executed, 0)
  })
}

test('« ouvre le bloc-notes et écris… » depuis le téléphone : rien n’est écrit sur le PC', async () => {
  const converse = setup(async () => assert.fail('pas de modèle'), async () => assert.fail('pas d’outil'))
  assert.equal(await converse('Ouvre le bloc-notes et écris bonjour', PHONE_RESTRICTIONS), PHONE_REFUSAL)
})

test('ouvrir une application reste possible depuis le téléphone (choix de Léo)', async () => {
  const calls = []
  const converse = setup(async () => assert.fail('pas de modèle'), async (name, args) => {
    calls.push([name, args.app_name])
    return 'Spotify a été lancé.'
  })
  assert.match(await converse('Ouvre Spotify', PHONE_RESTRICTIONS), /Spotify/)
  assert.deepEqual(calls, [['open_app', 'Spotify']])
})

test('progression montrée au téléphone : des phrases, jamais le nom technique ni les arguments', () => {
  assert.equal(phoneStatusFromLog('Outil appelé : search_web({"query":"météo Lyon"})'), 'Recherche sur le web…')
  assert.equal(phoneStatusFromLog("Outil appelé : generate_image({\"prompt\":\"chat\"})"), "Dessin de l'image…")
  assert.equal(phoneStatusFromLog('Modèle choisi : qwen3.5:4b (réflexion : low)'), 'Jaris réfléchit…')
  assert.equal(phoneStatusFromLog('Résultat de l\'outil : ...'), null)
  assert.equal(phoneStatusFromLog('Outil appelé : nouvel_outil({})'), 'Jaris travaille…')
})
