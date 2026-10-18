import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { modelChoiceModule } from './load-model-choice.mjs'
import { systemPromptModule } from './load-system-prompt.mjs'
import { withI18n } from './i18n-test-module.mjs'

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
  './systemPrompt': systemPromptModule,
  './memoryStore': {},
  './profileStore': {},
  './tools': { TOOLS: [{ function: { name: 'open_app' } }], createToolExecutor: () => {} },
  './hardwareScan': {},
  './modelChoice': modelChoiceModule,
  './resourceMonitor': {}
}
const exports = {}
vm.runInNewContext(source, { exports, require: withI18n((name) => modules[name]), module: { exports } })
const { looksLikeKnowledgeQuestion, isPureCalculation } = exports

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

// Bêta de l'étape 324 : « Combien font 12 fois 7 ? » passait pour une question de connaissance. Le modèle répondait 84,
// puis la relance le forçait à chercher sur internet, et une recherche en échec (SearXNG absent) remplaçait la bonne
// réponse par « Échec de l'outil ». Un calcul seul ne demande aucune donnée du monde : jamais de relance.
for (const prompt of [
  'Combien font 12 fois 7 ?',
  'combien fait 12 fois 7 ?',
  '12 fois 7 ?',
  'C’est quoi 12 fois 7 ?',
  "Qu'est-ce que 12 multiplié par 7 ?",
  'Combien font douze fois sept ?',
  'Combien font dix-sept plus vingt-cinq ?',
  'Calcule 12,5 fois 3 ?',
  'Combien font 144 divisé par 12 ?',
  '144 sur 12 ?',
  'Combien font 100 moins 37 ?',
  'Combien font 15 % de 80 ?',
  'Combien font 15 pour cent de 80 ?',
  'Combien fait la racine carrée de 144 ?',
  'Quel est le carré de 12 ?',
  '7 au carré ?',
  '2 puissance 10 ?',
  'Combien font 3 et 4 ?',
  'Jaris, combien font 12 fois 7, s’il te plaît ?',
  'Dis-moi combien font 12 fois 7',
  '12*7 ?',
  '12x7=?',
  '12 × 7 ?',
  '(12 + 3) × 2 ?',
  '84 ÷ 7 ?',
  '2^10 ?',
  '12 − 7 ?',
  '1 000 + 2,5 ?'
]) {
  test(`un simple calcul n'est jamais une question de connaissance : ${JSON.stringify(prompt)}`, () => {
    assert.ok(isPureCalculation(prompt), 'reconnu comme un calcul')
    assert.ok(!looksLikeKnowledgeQuestion(prompt), 'aucune relance vers internet')
  })
}

// Dès qu'une donnée du monde est en jeu (prix, population, taux, monnaie, unité, lieu), la recherche reste exigée.
for (const prompt of [
  'Combien coûtent 2 kg de pommes ?',
  "Combien d'habitants à Paris ?",
  'Combien y a-t-il d’habitants en France en 2026 ?',
  '15 % de TVA sur 80 € en France ?',
  'Combien font 100 dollars en euros ?',
  'Combien vaut un bitcoin ?',
  'Combien coûte un iPhone 15 ?',
  'Combien de secondes dans une heure ?',
  'Combien font 2 + 2 dans la série Lost ?',
  'Qui a gagné 3 à 1 hier soir ?',
  '1789 et 1815 ?',
  'Cherche combien font 12 fois 7',
  'Combien pèse la tour Eiffel ?'
]) {
  test(`une donnée du monde reste une question de connaissance : ${JSON.stringify(prompt)}`, () => {
    assert.ok(!isPureCalculation(prompt), 'pas un simple calcul')
    assert.ok(looksLikeKnowledgeQuestion(prompt), 'la recherche reste exigée')
  })
}

test('un nombre seul, ou une opération sans nombre, n’est pas un calcul', () => {
  for (const prompt of ['12 ?', '12,5', 'Combien ?', 'Combien vaut x ?', 'plus ou moins ?', '']) {
    assert.ok(!isPureCalculation(prompt), JSON.stringify(prompt))
  }
})
