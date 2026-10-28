import { withI18n } from './i18n-test-module.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * shared/effort.ts (étapes 191-192) : la réflexion (« think ») ne propose QUE ce que le modèle annonce dans
 * `/api/show`. Léo : « on peut choisir un modèle qui a rien et choisir max » — plus jamais.
 */
const source = ts.transpileModule(readFileSync(new URL('../shared/effort.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const exports = {}
vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(exports, { exports }, withI18n(() => ({})))
const { thinkingKind, thinkOptions, isAcceptedThink, chosenThink, thinkLabel, parseModelThinking, equivalentThink } = exports

// Réponses /api/show réduites à ce qui compte, d'après les fiches officielles vérifiées à l'étape 191.
const QWEN38 = parseModelThinking({ capabilities: ['completion', 'tools', 'thinking'], thinking: { values: [false, 'low', 'medium', 'xhigh'], default: 'xhigh' } })
const GPT_OSS = parseModelThinking({ capabilities: ['completion', 'tools', 'thinking'], thinking: { values: ['low', 'medium', 'high'] } })
const QWEN35 = parseModelThinking({ capabilities: ['completion', 'tools', 'thinking'] })
const CODER = parseModelThinking({ capabilities: ['completion', 'tools'] })
const labels = (meta) => thinkOptions(meta).map((o) => o.label)

test('qwen3.8 : ses VRAIS niveaux, rien d’autre (pas de « high », pas de « max »)', () => {
  assert.equal(thinkingKind(QWEN38), 'levels')
  assert.deepEqual(labels(QWEN38), ['Désactivée', 'Faible', 'Moyen', 'Extra'], 'étape 210 : les mots de Claude')
  assert.equal(isAcceptedThink('medium', QWEN38), true)
  assert.equal(isAcceptedThink('high', QWEN38), false)
  assert.equal(isAcceptedThink('max', QWEN38), false)
})

test('gpt-oss ne sait pas couper : pas de « off » proposé', () => {
  assert.deepEqual(labels(GPT_OSS), ['Faible', 'Moyen', 'Élevé'])
  assert.equal(isAcceptedThink(false, GPT_OSS), false)
})

test('modèle avec ou sans (qwen3.5) : off / on, jamais un niveau nommé', () => {
  assert.equal(thinkingKind(QWEN35), 'toggle')
  assert.deepEqual(labels(QWEN35), ['Désactivée', 'Activée'])
  assert.equal(isAcceptedThink(true, QWEN35), true)
  assert.equal(isAcceptedThink('medium', QWEN35), false)
})

test('un modèle qui ne réfléchit pas : AUCUN choix — le défaut signalé par Léo', () => {
  assert.equal(thinkingKind(CODER), 'none')
  assert.deepEqual(thinkOptions(CODER), [])
  assert.equal(isAcceptedThink('max', CODER), false)
  assert.equal(isAcceptedThink(true, CODER), false)
})

test('Ollama muet : inconnu, aucun choix inventé', () => {
  assert.equal(thinkingKind(null), 'unknown')
  assert.equal(thinkingKind(parseModelThinking({})), 'unknown')
  assert.deepEqual(thinkOptions(null), [])
})

test('le réglage enregistré ne s’applique qu’au modèle pour lequel il a été choisi', () => {
  const stored = { model: 'qwen3.8:27b', think: 'medium' }
  assert.equal(chosenThink(stored, 'qwen3.8:27b', QWEN38), 'medium')
  assert.equal(chosenThink(stored, 'qwen3-coder:30b', CODER), undefined, 'autre modèle : comportement habituel')
  assert.equal(chosenThink({ model: 'x', think: 'medium' }, 'x', CODER), undefined, 'valeur refusée par le modèle : ignorée')
  assert.equal(chosenThink(undefined, 'qwen3.8:27b', QWEN38), undefined)
  assert.equal(chosenThink({ model: 'qwen3.5:9b', think: false }, 'qwen3.5:9b', QWEN35), false, 'off est une vraie valeur, pas « rien »')
})

test('libellés et lecture tolérante de /api/show', () => {
  assert.equal(thinkLabel(true), 'Activée')
  assert.equal(thinkLabel(false), 'Désactivée')
  assert.equal(thinkLabel('xhigh'), 'Extra')
  assert.equal(thinkLabel('niveau-inconnu'), 'niveau-inconnu', 'un niveau inconnu garde son nom, jamais deviné')
  const meta = parseModelThinking({ capabilities: 'thinking', thinking: { values: [1, 'low', null], default: 3 } })
  assert.equal(meta.canThink, null)
  assert.deepEqual([...meta.values], ['low'])
  assert.doesNotThrow(() => parseModelThinking(null))
})

// Étape 365 : réglages réels relus dans Ollama (server/model_thinking.go) — gemma4 « avec ou sans », défaut ramené à
// « activée » par Ollama ; un modèle sans « off » ni niveau le plus bas.
const GEMMA4 = parseModelThinking({ capabilities: ['completion', 'thinking'], thinking: { values: [false, true], default: true } })
const LEVELS_NO_OFF = parseModelThinking({ capabilities: ['thinking'], thinking: { values: ['medium', 'xhigh'], default: 'xhigh' } })

test('étape 365 : en duel, l’équivalent de « moyen » pour chaque modèle (Léo : « pas un low, un max et un sans »)', () => {
  assert.equal(equivalentThink('medium', QWEN38), 'medium')
  assert.equal(equivalentThink('medium', GPT_OSS), 'medium')
  assert.equal(equivalentThink('medium', GEMMA4), true, 'gemma4 réfléchit aussi')
  assert.equal(equivalentThink('medium', QWEN35), true)
  assert.equal(equivalentThink('medium', CODER), false, 'sans réflexion : false, accepté par Ollama')
  assert.equal(equivalentThink('medium', null), 'medium', 'Ollama muet : tel quel')
  assert.equal(equivalentThink('medium', parseModelThinking({ capabilities: ['thinking'], thinking: { values: ['low', 'high'], default: 'high' } })), 'low')
  assert.equal(equivalentThink('medium', LEVELS_NO_OFF), 'medium')
  assert.equal(equivalentThink('low', LEVELS_NO_OFF), 'medium', 'rien en dessous : le plus petit niveau')
})
