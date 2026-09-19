import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * looksLikeKnowledgeQuestion (assistant.ts) — Léo : "fait en sorte qu'il regarde tout le temps sur le web
 * ... il ne doit pas répondre depuis sa base de données car les modèles sont trop vieux". Sert à forcer une
 * relance corrective vers search_web (comme wantsEmailSent le fait déjà pour computer_use_task) quand le
 * modèle répond à une question de connaissance SANS avoir cherché — exactement le bug qui a produit "ChatGPT
 * a été développé par... dirigée par Elon Musk" (faux, de mémoire, sans recherche).
 *
 * Exportée au niveau module précisément pour être testée ici sans avoir à mocker tout converse().
 */
const source = ts.transpileModule(readFileSync(new URL('../electron/services/assistant.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

const modules = {
  './notepad': { requestedNotepadText: () => undefined },
  '../config': { config: { ollama: {} } },
  './ollama': {},
  './memoryStore': {},
  './profileStore': {},
  './tools': { TOOLS: [{ function: { name: 'open_app' } }], createToolExecutor: () => {} },
  './hardwareScan': {},
  './resourceMonitor': {}
}
const exports = {}
vm.runInNewContext(source, { exports, require: (name) => modules[name], module: { exports } })
const { looksLikeKnowledgeQuestion } = exports

test('reproduit le cas réel rapporté par Léo : "Qui a créé ChatGPT ?"', () => {
  assert.ok(looksLikeKnowledgeQuestion('Qui a créé ChatGPT ?'))
})

for (const prompt of [
  'Qui a créé ChatGPT ?',
  "Quelle est la capitale de l'Australie ?",
  'Combien pèse la tour Eiffel ?',
  "Qu'est-ce que le protocole HTTP ?",
  "C'est quoi une éclipse solaire",
  'Pourquoi le ciel est bleu ?',
  'Quand a eu lieu la révolution française ?',
  'Où se trouve le mont Everest ?',
  'Comment fonctionne un moteur à explosion ?',
  'Trouve-moi une boulangerie ouverte près de chez moi'
]) {
  test(`détecté comme question de connaissance : ${JSON.stringify(prompt)}`, () => {
    assert.ok(looksLikeKnowledgeQuestion(prompt))
  })
}

for (const prompt of [
  'Ouvre le bloc-notes',
  'Retiens que mon adresse est 12 rue des Lilas',
  "N'oublie pas que je déteste le café",
  'Quelle heure est-il ?',
  'Quel jour on est ?',
  "Comment tu t'appelles ?",
  'Tu vas bien ?',
  'Est-ce que tu vas bien ?',
  'Comment vas-tu ?',
  'Ça va ?',
  'Écris bonjour',
  'Éteins l’ordinateur',
  'Merci beaucoup',
  ''
]) {
  test(`jamais une relance search_web inutile : ${JSON.stringify(prompt)}`, () => {
    assert.ok(!looksLikeKnowledgeQuestion(prompt))
  })
}

test('une vraie question factuelle contenant « ça va » reste recherchée', () => {
  assert.ok(looksLikeKnowledgeQuestion("Pourquoi ça va mal dans l'économie ?"))
})
