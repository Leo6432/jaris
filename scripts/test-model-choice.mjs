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

test('un rôle choisi utilise le modèle actuel de ce rôle, pour CE mode seulement', () => {
  const profile = { models: { flash: 'qwen3.5:4b', medium: 'gemma4:12b', large: 'qwen3.5:4b' }, modelChoices: { chat: 'role:medium' } }
  assert.equal(resolveChosenModel(profile, 'chat', installed), 'gemma4:12b')
  assert.equal(resolveChosenModel(profile, 'voice', installed), null)
  assert.equal(resolveChosenModel(profile, 'code', installed), null)
})

test('un nom sans tag et son écriture `:latest` désignent le même modèle installé', () => {
  const profile = { modelChoices: { code: 'hf.co/bartowski/ai9stars_G9v3-3B-GGUF' } }
  assert.equal(resolveChosenModel(profile, 'code', installed), 'hf.co/bartowski/ai9stars_G9v3-3B-GGUF')
})

test('un modèle choisi puis supprimé retombe sur Auto', () => {
  assert.equal(resolveChosenModel({ models: { flash: 'llama3:8b' }, modelChoices: { chat: 'role:flash' } }, 'chat', installed), null)
})

test("un modèle d'embedding n'est jamais proposé ni accepté (il ne sait pas discuter)", () => {
  assert.ok(!selectableModels(installed).includes('nomic-embed-text:latest'))
  assert.equal(resolveChosenModel({ modelChoices: { chat: 'nomic-embed-text:latest' } }, 'chat', installed), null)
  assert.throws(() => applyModelChoice({ models: { flash: 'nomic-embed-text:latest' } }, 'chat', 'role:flash', installed), /pas installé/)
})

test("enregistrer : un rôle non installé est refusé, null remet Auto, les autres modes sont conservés", () => {
  assert.throws(() => applyModelChoice({}, 'chat', 'role:medium', installed), /pas installé/)
  const set = applyModelChoice({ name: 'Léo', models: { medium: 'gemma4:12b' }, modelChoices: { voice: 'role:flash' } }, 'chat', 'role:medium', installed)
  assert.equal(JSON.stringify(set.modelChoices), JSON.stringify({ voice: 'role:flash', chat: 'role:medium' }))
  assert.equal(set.name, 'Léo', 'le reste du profil est intact')
  const reset = applyModelChoice(set, 'chat', null, [])
  assert.equal(JSON.stringify(reset.modelChoices), JSON.stringify({ voice: 'role:flash' }))
})

test('un mode inconnu venant du renderer est refusé', () => {
  assert.throws(() => applyModelChoice({}, 'admin', 'role:medium', installed), /Mode inconnu/)
})

test('le sélecteur expose les cinq rôles sans utiliser les noms comme choix', () => {
  const profile = { models: { flash: 'qwen3.5:4b', medium: 'gemma4:12b', large: 'qwen3.5:4b' }, visionModel: 'gemma4:12b', codeModel: 'qwen3.5:4b', modelChoices: { voice: 'role:medium' } }
  const code = buildModelChoiceInfo(profile, 'code', installed)
  assert.equal(code.autoModel, 'qwen3.5:4b')
  assert.equal(code.selected, null)
  const voice = buildModelChoiceInfo(profile, 'voice', installed)
  assert.equal(voice.autoModel, null)
  assert.equal(voice.selected, 'role:medium')
  assert.deepEqual(Array.from(voice.roles, (role) => role.label), ['Rapide', 'Médium', 'Puissant', 'Vision', 'Code'])
  assert.ok(!voice.installed.includes('nomic-embed-text:latest'))
})

test('un rôle suit le nouveau modèle du profil après un retest de configuration', () => {
  const profile = { models: { flash: 'qwen3.5:4b' }, modelChoices: { chat: 'role:flash' } }
  assert.equal(resolveChosenModel(profile, 'chat', installed), 'qwen3.5:4b')
  profile.models.flash = 'gemma4:12b'
  assert.equal(resolveChosenModel(profile, 'chat', installed), 'gemma4:12b')
})

test("Ollama injoignable : le choix enregistré reste affiché, jamais présenté comme perdu", () => {
  const info = buildModelChoiceInfo({ modelChoices: { chat: 'gemma4:12b' } }, 'chat', null)
  assert.equal(info.selected, 'gemma4:12b')
  assert.equal(info.installed, null)
})
