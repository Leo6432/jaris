import assert from 'node:assert/strict'
import test from 'node:test'
import { loadModelChoice } from './load-model-choice.mjs'

/**
 * electron/services/modelChoice.ts — étape 141, Léo : « ajoute dans chat code vocal, la possibilité de
 * choisir le model ou faire auto ». Le module est pur : ce qui est testé ici est exactement ce qu'utilisent
 * main.ts (enregistrement du choix), assistant.ts (Chat/Vocal) et codeGenerator.ts (Code).
 */
const { resolveChosenModel, selectableModels, buildModelChoiceInfo, applyModelChoice } = loadModelChoice()

const installed = ['qwen3.5:4b', 'hf.co/bartowski/ai9stars_G9v3-3B-GGUF:latest', 'nomic-embed-text:latest', 'gemma4:12b']

test('Auto par défaut : aucun choix enregistré, aucun profil', () => {
  assert.equal(resolveChosenModel(null, 'chat', installed), null)
  assert.equal(resolveChosenModel({ modelChoices: {} }, 'voice', installed), null)
})

test('un modèle choisi et installé est utilisé, pour CE mode seulement', () => {
  const profile = { modelChoices: { chat: 'gemma4:12b' } }
  assert.equal(resolveChosenModel(profile, 'chat', installed), 'gemma4:12b')
  assert.equal(resolveChosenModel(profile, 'voice', installed), null)
  assert.equal(resolveChosenModel(profile, 'code', installed), null)
})

test('un nom sans tag et son écriture `:latest` désignent le même modèle installé', () => {
  const profile = { modelChoices: { code: 'hf.co/bartowski/ai9stars_G9v3-3B-GGUF' } }
  assert.equal(resolveChosenModel(profile, 'code', installed), 'hf.co/bartowski/ai9stars_G9v3-3B-GGUF')
})

test('un modèle choisi puis supprimé retombe sur Auto', () => {
  assert.equal(resolveChosenModel({ modelChoices: { chat: 'llama3:8b' } }, 'chat', installed), null)
})

test("un modèle d'embedding n'est jamais proposé ni accepté (il ne sait pas discuter)", () => {
  assert.ok(!selectableModels(installed).includes('nomic-embed-text:latest'))
  assert.equal(resolveChosenModel({ modelChoices: { chat: 'nomic-embed-text:latest' } }, 'chat', installed), null)
  assert.throws(() => applyModelChoice({}, 'chat', 'nomic-embed-text:latest', installed), /pas installé/)
})

test("enregistrer : un modèle non installé est refusé, null remet Auto, les autres modes sont conservés", () => {
  assert.throws(() => applyModelChoice({}, 'chat', 'inventé:1b', installed), /pas installé/)
  const set = applyModelChoice({ name: 'Léo', modelChoices: { voice: 'qwen3.5:4b' } }, 'chat', 'gemma4:12b', installed)
  assert.equal(JSON.stringify(set.modelChoices), JSON.stringify({ voice: 'qwen3.5:4b', chat: 'gemma4:12b' }))
  assert.equal(set.name, 'Léo', 'le reste du profil est intact')
  const reset = applyModelChoice(set, 'chat', null, [])
  assert.equal(JSON.stringify(reset.modelChoices), JSON.stringify({ voice: 'qwen3.5:4b' }))
})

test('un mode inconnu venant du renderer est refusé', () => {
  assert.throws(() => applyModelChoice({}, 'admin', 'gemma4:12b', installed), /Mode inconnu/)
})

test('ce que montre le sélecteur : Auto du mode Code nomme son modèle, Chat/Vocal non', () => {
  const profile = { codeModel: 'qwen3.5:4b', modelChoices: { voice: 'gemma4:12b' } }
  const code = buildModelChoiceInfo(profile, 'code', installed)
  assert.equal(code.autoModel, 'qwen3.5:4b')
  assert.equal(code.selected, null)
  const voice = buildModelChoiceInfo(profile, 'voice', installed)
  assert.equal(voice.autoModel, null)
  assert.equal(voice.selected, 'gemma4:12b')
  assert.ok(!voice.installed.includes('nomic-embed-text:latest'))
})

test("Ollama injoignable : le choix enregistré reste affiché, jamais présenté comme perdu", () => {
  const info = buildModelChoiceInfo({ modelChoices: { chat: 'gemma4:12b' } }, 'chat', null)
  assert.equal(info.selected, 'gemma4:12b')
  assert.equal(info.installed, null)
})
