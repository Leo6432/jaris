import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { modelChoiceModule } from './load-model-choice.mjs'
import { systemPromptModule } from './load-system-prompt.mjs'
import { withI18n } from './i18n-test-module.mjs'

/**
 * Étape 531 (relecture « les duels font-ils comme Jaris ? ») : l'alerte « PC surchargé » de converse() (délai de 2 min
 * entre deux alertes) tombait sur UN seul côté d'un duel — une phrase de Jaris lue comme si le modèle l'avait écrite.
 * Jamais en duel (restrictions.modelOnly) ; toujours à Léo en usage normal. La VRAIE boucle de conversation.
 */
const transpile = (path) =>
  ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText

function setup() {
  let checks = 0
  const modules = {
    '../config': { config: { ollama: { model: 'test', visionModel: 'vision', numCtx: 8192 } } },
    './ollama': { chatWithOllama: async () => ({ role: 'assistant', content: 'Bonjour !' }), listInstalledModels: async () => ['test'] },
    './systemPrompt': systemPromptModule,
    './memoryStore': { listMemoryTitles: async () => [] },
    './profileStore': { getProfile: async () => null },
    './notepad': { notepadRequest: () => null, requestedNotepadText: () => null, openNotepadText: async () => {} },
    './appLauncher': { didAppLaunch: () => false, launchedAppName: () => undefined },
    './hardwareScan': { GPU_TEMP_LIMIT_C: 85 },
    './modelChoice': modelChoiceModule,
    './browserSearch': { directBrowserSearch: () => undefined, openBrowserSearch: async () => {} },
    './requestJournal': { startJournalEntry: () => ({ line() {}, timed() {}, end: async () => {} }), describeModelCall: () => '' },
    './resourceMonitor': {
      checkOverloadWarning: async () => {
        checks++
        return 'Ton PC est très chargé.'
      }
    },
    './tools': { TOOLS: [], createToolExecutor: () => async () => '' }
  }
  const exports = {}
  vm.runInNewContext(transpile('../electron/services/assistant.ts'), { exports, Error, require: withI18n((name) => modules[name]) })
  const converse = (restrictions) => exports.converse('Raconte une blague', null, () => {}, undefined, [], undefined, undefined, 'chat', undefined, undefined, undefined, restrictions)
  return { converse, checks: () => checks }
}

test('étape 531 : l’alerte « PC surchargé » n’apparaît jamais dans un duel, toujours en usage normal', async () => {
  const env = setup()
  assert.match(await env.converse(), /^Ton PC est très chargé\.\n\nBonjour !$/, 'usage normal : Léo est prévenu')
  const duel = { modelOnly: true, model: 'test', note: '', refusal: 'non', allowedTools: new Set() }
  assert.equal(await env.converse(duel), 'Bonjour !', 'duel : la réponse du modèle seule')
  assert.equal(env.checks(), 1, 'en duel, l’état du PC n’est même pas lu (son délai n’est pas consommé)')
})
