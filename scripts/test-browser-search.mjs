import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { modelChoiceModule } from './load-model-choice.mjs'
import { systemPromptModule } from './load-system-prompt.mjs'

/**
 * Étape 248 (journal de Léo, « ouvre Firefox et cherche une recette de tiramisu » à la voix) : 2 minutes de réflexion
 * du modèle avant d'ouvrir Firefox, puis un pilotage d'écran qui cliquait dans la barre des tâches et fermait Firefox.
 * Cette demande explicite ouvre désormais la page de résultats DIRECTEMENT dans le navigateur.
 */
const nodeRequire = createRequire(import.meta.url)
const transpile = (path) =>
  ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText

function load(path, modules = {}) {
  const module = { exports: {} }
  vm.runInThisContext(`(function (exports, require, module) {\n${transpile(path)}\n})`)(module.exports, (name) => modules[name] ?? nodeRequire(name), module)
  return module.exports
}

const opened = []
const browser = load('electron/services/browserSearch.ts', { electron: { shell: { openExternal: async (url) => opened.push(url) } } })
const { directBrowserSearch, searchUrl, parseRegDefault, openBrowserSearch } = browser

test('les phrases de Léo sont reconnues, avec le bon navigateur et la bonne recherche', () => {
  const firefox = { name: 'Firefox', exe: 'firefox.exe' }
  assert.deepEqual(directBrowserSearch('Ouvre-moi Firefox et cherche-moi une recette de tiramisu.'), { query: 'recette de tiramisu', site: 'web', browser: firefox })
  assert.deepEqual(directBrowserSearch('Ouvre Firefox et cherche une recette de tiramisu.'), { query: 'recette de tiramisu', site: 'web', browser: firefox })
  assert.deepEqual(directBrowserSearch('ouvre google chrome puis recherche la météo à Rennes'), { query: 'météo à Rennes', site: 'web', browser: { name: 'Chrome', exe: 'chrome.exe' } })
  assert.deepEqual(directBrowserSearch('Va sur YouTube et cherche un tuto de guitare pour débutant.'), { query: 'tuto de guitare pour débutant', site: 'youtube', browser: undefined })
  assert.deepEqual(directBrowserSearch('Ouvre le navigateur et cherche des chaussures de running'), { query: 'chaussures de running', site: 'web', browser: undefined })
  assert.deepEqual(directBrowserSearch('Ouvre Google et fais une recherche sur les volcans'), { query: 'volcans', site: 'web', browser: undefined })
  assert.equal(directBrowserSearch('Ouvre Firefox et cherche une recette pas chère').query, 'recette pas chère', 'un « pas » dans la recherche reste permis')
})

test('tout le reste est laissé au modèle : questions, négations, suites d’actions, simple ouverture', () => {
  for (const phrase of [
    'Cherche sur internet qui est le président des États-Unis',
    "Qu'est-ce que Firefox ?",
    'Ne lance pas Firefox et cherche rien',
    'Ouvre Firefox',
    'Ouvre Discord puis écris salut tout le monde.',
    'Va sur YouTube et cherche un tuto de guitare puis lance la première vidéo',
    'Ouvre Firefox et cherche une recette et clique sur le premier résultat',
    'Ouvre Spotify et cherche du jazz'
  ]) {
    assert.equal(directBrowserSearch(phrase), undefined, phrase)
  }
})

test('l’adresse encode la recherche : aucun caractère ne peut casser l’URL ni devenir une commande', () => {
  assert.equal(searchUrl({ query: 'recette de tiramisu', site: 'web' }), 'https://www.google.com/search?q=recette%20de%20tiramisu')
  assert.equal(searchUrl({ query: 'tuto guitare', site: 'youtube' }), 'https://www.youtube.com/results?search_query=tuto%20guitare')
  const tricky = searchUrl({ query: 'pain & beurre" | del C:\\ ?x=1#y', site: 'web' })
  assert.ok(!/[\s&"|#\\]/.test(tricky.split('?q=')[1]), tricky)
  // La source ne passe jamais par un interpréteur de commandes.
  const source = readFileSync(new URL('../electron/services/browserSearch.ts', import.meta.url), 'utf8')
  assert.ok(!/shell:\s*true|\bexec\(/.test(source), 'aucun shell ni exec')
})

test('lecture du registre Windows, quelle que soit la langue', () => {
  assert.equal(parseRegDefault('\r\nHKEY_LOCAL_MACHINE\\...\\firefox.exe\r\n    (Default)    REG_SZ    C:\\Program Files\\Mozilla Firefox\\firefox.exe\r\n'), 'C:\\Program Files\\Mozilla Firefox\\firefox.exe')
  assert.equal(parseRegDefault('    (par défaut)    REG_SZ    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"\r\n'), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  assert.equal(parseRegDefault('    (par défaut)    REG_SZ    \r\n'), null)
  assert.equal(parseRegDefault(''), null)
})

test('le navigateur demandé reçoit l’adresse en argument ; sinon le navigateur par défaut, en le disant', async () => {
  const request = { query: 'recette de tiramisu', site: 'web', browser: { name: 'Firefox', exe: 'firefox.exe' } }
  const launches = []
  const deps = (exe, launchError = null) => ({
    findExe: async () => exe,
    launch: async (path, args) => (launches.push([path, args]), launchError),
    openExternal: async (url) => opened.push(url)
  })
  opened.length = 0
  assert.equal(await openBrowserSearch(request, deps('C:\\Firefox\\firefox.exe')), 'Recherche « recette de tiramisu » envoyée à Firefox.')
  assert.equal(JSON.stringify(launches), JSON.stringify([['C:\\Firefox\\firefox.exe', ['https://www.google.com/search?q=recette%20de%20tiramisu']]]))
  assert.equal(opened.length, 0)

  assert.equal(await openBrowserSearch(request, deps(null)), 'Firefox introuvable sur ce PC : recherche « recette de tiramisu » envoyée à ton navigateur par défaut.')
  assert.equal(await openBrowserSearch(request, deps('C:\\Firefox\\firefox.exe', 'EACCES')), "Firefox n'a pas pu être lancé (EACCES) : recherche « recette de tiramisu » envoyée à ton navigateur par défaut.")
  assert.equal(await openBrowserSearch({ query: 'tuto guitare', site: 'youtube' }, deps(null)), 'Recherche YouTube « tuto guitare » envoyée à ton navigateur par défaut.')
  assert.equal(opened.at(-1), 'https://www.youtube.com/results?search_query=tuto%20guitare')
  const failing = { ...deps(null), openExternal: async () => { throw new Error('aucun navigateur') } }
  assert.equal(await openBrowserSearch({ query: 'x', site: 'web' }, failing), "Échec de l'ouverture du navigateur : aucun navigateur")
})

function converseWith({ chat, restrictions, openSearch }) {
  const config = { ollama: { model: 'granite4.2:8b', visionModel: 'vision', numCtx: 8192 } }
  return load('electron/services/assistant.ts', {
    '../config': { config },
    './ollama': { chatWithOllama: chat, listInstalledModels: async () => ['granite4.2:8b'], getModelThinking: async () => null },
    './systemPrompt': systemPromptModule,
    '../../shared/effort': load('shared/effort.ts'),
    './memoryStore': { listMemoryTitles: async () => [] },
    './profileStore': { getProfile: async () => null },
    './notepad': { requestedNotepadText: () => undefined, openNotepadText: async () => '' },
    './appLauncher': { didAppLaunch: (result) => result.endsWith('a été lancé.') },
    './hardwareScan': { GPU_TEMP_LIMIT_C: 85, isScreenQuestion: () => false, pickSafeModel: (_f, _i, m) => m },
    './modelChoice': modelChoiceModule,
    './resourceMonitor': { checkOverloadWarning: async () => null },
    './requestJournal': { startJournalEntry: () => ({ line() {}, timed() {}, end: async () => {} }), describeModelCall: () => '' },
    './browserSearch': { directBrowserSearch, openBrowserSearch: openSearch },
    './tools': { TOOLS: [], createToolExecutor: () => async () => assert.fail('aucun outil du modèle') }
  }).converse
}

for (const channel of ['voice', 'chat']) {
  test(`${channel} : « ouvre Firefox et cherche… » n’attend jamais le modèle`, async () => {
    const asked = []
    const logs = []
    const converse = converseWith({
      chat: async () => assert.fail('le modèle ne doit pas être appelé'),
      openSearch: async (request) => (asked.push(request), 'Recherche « recette de tiramisu » envoyée à Firefox.')
    })
    const reply = await converse('Ouvre-moi Firefox et cherche-moi une recette de tiramisu.', null, () => {}, (m) => logs.push(m), [], undefined, undefined, channel)
    assert.equal(reply, 'Recherche « recette de tiramisu » envoyée à Firefox.')
    assert.equal(asked.length, 1)
    assert.equal(asked[0].query, 'recette de tiramisu')
    assert.ok(logs.some((m) => m.includes('Recherche ouverte directement dans le navigateur')))
  })
}

test('depuis le téléphone sans droit d’ouvrir une application : refus, rien n’est ouvert', async () => {
  const converse = converseWith({ chat: async () => assert.fail('modèle'), openSearch: async () => assert.fail('navigateur ouvert') })
  const restrictions = { allowedTools: new Set(['search_web']), refusal: 'Pas depuis le téléphone.', note: '' }
  assert.equal(await converse('Ouvre Firefox et cherche une recette', null, () => {}, undefined, [], undefined, undefined, 'chat', undefined, undefined, undefined, restrictions), 'Pas depuis le téléphone.')
})

test('une autre demande passe toujours par le modèle', async () => {
  let calls = 0
  const converse = converseWith({ chat: async () => (calls++, { role: 'assistant', content: 'Il est dix heures.' }), openSearch: async () => assert.fail('navigateur ouvert') })
  assert.equal(await converse('Quelle heure est-il ?', null, () => {}), 'Il est dix heures.')
  assert.equal(calls, 1)
})
