import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * shared/effort.ts (étape 191) : le curseur d'effort commun (Aucune → Maximale) traduit vers les niveaux
 * RÉELS de chaque modèle, tels qu'Ollama les annonce dans `/api/show`. Le défaut corrigé : Jaris envoyait
 * « high » à tous ; qwen3.8 ne connaît pas ce mot et retombait sur SON défaut, xhigh (le maximum).
 */
const source = ts.transpileModule(readFileSync(new URL('../shared/effort.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const exports = {}
vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(exports, { exports }, () => ({}))
const { resolveEffort, describeModelThinking, parseModelThinking, effortLabel, isEffortChoice } = exports

// Réponses /api/show réduites à ce qui compte, d'après les fiches officielles vérifiées à l'étape 191.
const QWEN38 = parseModelThinking({ capabilities: ['completion', 'tools', 'thinking'], thinking: { values: [false, 'low', 'medium', 'xhigh'], default: 'xhigh' } })
const GPT_OSS = parseModelThinking({ capabilities: ['completion', 'tools', 'thinking'], thinking: { values: ['low', 'medium', 'high'] } })
const GRANITE42 = parseModelThinking({ capabilities: ['completion', 'thinking'], thinking: { values: [false, 'low', 'high'] } })
const QWEN35 = parseModelThinking({ capabilities: ['completion', 'tools', 'thinking'] })
const CODER = parseModelThinking({ capabilities: ['completion', 'tools'] })

test('qwen3.8 : « Moyenne » envoie medium, plus jamais son défaut xhigh', () => {
  assert.deepEqual(resolveEffort('medium', QWEN38), { think: 'medium', applied: 'medium' })
  assert.equal(resolveEffort('max', QWEN38).think, 'xhigh')
  assert.equal(resolveEffort('low', QWEN38).think, 'low')
  assert.equal(resolveEffort('none', QWEN38).think, false)
})

test('à égalité de distance, le niveau le plus haut gagne (« Élevée » sur qwen3.8 = xhigh, pas medium)', () => {
  assert.equal(resolveEffort('high', QWEN38).think, 'xhigh')
})

test('gpt-oss ne sait pas couper : « Aucune » donne son plus bas niveau', () => {
  assert.deepEqual(resolveEffort('none', GPT_OSS), { think: 'low', applied: 'low' })
  assert.equal(resolveEffort('high', GPT_OSS).think, 'high')
  assert.equal(resolveEffort('max', GPT_OSS).think, 'high')
})

test('granite4.2 : off/low/high, « Moyenne » arrondit vers le haut', () => {
  assert.equal(resolveEffort('medium', GRANITE42).think, 'high')
  assert.equal(resolveEffort('none', GRANITE42).think, false)
})

test('modèle « avec ou sans » (qwen3.5) : true/false seulement, jamais un nom de niveau', () => {
  assert.equal(resolveEffort('high', QWEN35).think, true)
  assert.equal(resolveEffort('none', QWEN35).think, false)
  assert.equal(describeModelThinking(QWEN35), 'avec ou sans réflexion')
})

test('un modèle qui ne réfléchit pas ne reçoit rien : on ne change pas son comportement', () => {
  assert.equal(resolveEffort('max', CODER).think, undefined)
  assert.equal(resolveEffort('max', CODER).applied, 'ne réfléchit pas')
  assert.equal(describeModelThinking(CODER), 'ne réfléchit pas')
})

test('Auto (null) ou Ollama muet : rien n’est imposé, sauf couper la réflexion, toujours sûr', () => {
  assert.equal(resolveEffort(null, QWEN38).think, undefined)
  assert.equal(resolveEffort('high', null).think, undefined)
  assert.equal(resolveEffort('none', null).think, false)
  assert.equal(describeModelThinking(null), 'inconnu')
  assert.equal(describeModelThinking(parseModelThinking({})), 'inconnu')
})

test('l’écran affiche les niveaux réels du modèle', () => {
  assert.equal(describeModelThinking(QWEN38), 'off · low · medium · xhigh')
  assert.equal(describeModelThinking(GPT_OSS), 'low · medium · high')
})

test('lecture tolérante de /api/show : types inattendus = inconnu, jamais une exception', () => {
  const meta = parseModelThinking({ capabilities: 'thinking', thinking: { values: [1, 'low', null], default: 3 } })
  assert.equal(meta.canThink, null)
  assert.deepEqual([...meta.values], ['low'])
  assert.equal(meta.default, null)
  assert.doesNotThrow(() => parseModelThinking(null))
})

test('libellés et validation du choix', () => {
  assert.equal(effortLabel(null), 'Auto')
  assert.equal(effortLabel('high'), 'Élevée')
  assert.equal(isEffortChoice('max'), true)
  assert.equal(isEffortChoice('xhigh'), false)
})
