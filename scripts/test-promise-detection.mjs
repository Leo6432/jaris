import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { modelChoiceModule } from './load-model-choice.mjs'
import { systemPromptModule } from './load-system-prompt.mjs'

/**
 * PROMISE_WITHOUT_ACTION (assistant.ts) détecte une promesse d'action du modèle ("je vais faire X") sans
 * appel d'outil qui l'accompagne. Exportée au niveau module précisément pour être testée ici sans avoir à
 * mocker tout converse() (Ollama, les outils, le profil...).
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
  // TOOLS doit être un vrai tableau (pas {}) : assistant.ts calcule `TOOL_NAMES = TOOLS.map(...)` au niveau
  // module (findLeakedToolName, voir test-false-completion.mjs) — un mock vide ferait planter le chargement
  // du module ici aussi, avant même d'atteindre PROMISE_WITHOUT_ACTION.
  './tools': { TOOLS: [{ function: { name: 'open_app' } }], createToolExecutor: () => {} },
  './hardwareScan': {},
  './modelChoice': modelChoiceModule,
  './resourceMonitor': {}
}
const exports = {}
vm.runInNewContext(source, { exports, require: (name) => modules[name], module: { exports } })
const { PROMISE_WITHOUT_ACTION } = exports

test('reproduit le vrai cas rapporté par Léo (étape 32) : un adverbe entre "je vais" et le verbe', () => {
  const text =
    "Je m'excuse pour la confusion. Comme demandé, je vais simplement taper \"Bonjour\" dans le premier " +
    'champ texte ouvert (par exemple Notepad ou le bloc-notes actuellement en usage). Je vais maintenant ' +
    'utiliser type_text pour écrire cela.'
  assert.ok(PROMISE_WITHOUT_ACTION(text))
})

for (const text of [
  'je vais le faire',
  'je vais chercher',
  'je vais envoyer le mail',
  'je vais vérifier ça',
  'je vais regarder',
  'je vais maintenant utiliser type_text',
  'je vais simplement taper le texte',
  'je vais tout de suite envoyer le mail',
  'un instant, je regarde',
  'attends une minute',
  'attends-moi',
  'patiente un peu',
  "je m'en occupe",
  "je m'y mets",
  'je le fais tout de suite',
  'laisse-moi faire'
]) {
  test(`détecté comme promesse : ${JSON.stringify(text)}`, () => {
    assert.ok(PROMISE_WITHOUT_ACTION(text))
  })
}

for (const text of [
  'je vais bien',
  'je vais très bien merci',
  "je vais bien. je dois partir chercher quelque chose",
  "Il est 14h32.",
  "Voici ce que j'ai trouvé.",
  ''
]) {
  test(`jamais un faux positif : ${JSON.stringify(text)}`, () => {
    assert.ok(!PROMISE_WITHOUT_ACTION(text))
  })
}

/**
 * Faux positif réel signalé par Léo (« Qui a créé ChatGPT ? ») : un préambule poli avant une réponse déjà
 * complète et correcte ne doit JAMAIS déclencher la relance corrective — celle-ci n'a de sens que pour une
 * vraie promesse sèche, sans suite. Vérifié AVANT de corriger que l'ancien regex matchait ces textes.
 */
for (const text of [
  'Je vais vous répondre : ChatGPT a été créé par OpenAI.',
  "Je vais vous expliquer : ChatGPT a été créé par OpenAI, une entreprise fondée en 2015.",
  'Je vais vous dire ceci : la capitale de la France est Paris, une ville de plusieurs millions d\'habitants.'
]) {
  test(`un préambule suivi d'une vraie réponse n'est jamais une promesse sèche : ${JSON.stringify(text)}`, () => {
    assert.ok(!PROMISE_WITHOUT_ACTION(text))
  })
}

// Une promesse sèche reste détectée même précédée d'un tour de phrase poli : seul ce qui suit compte.
test('un préambule qui ne débouche sur AUCUNE réponse reste une promesse sèche', () => {
  assert.ok(PROMISE_WITHOUT_ACTION('Je vais vous répondre : je vais vérifier ça.'))
})
