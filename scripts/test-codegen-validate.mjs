import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * validateGeneratedHtml() est une fonction pure (aucun appel réseau/disque à l'exécution) mais son module
 * importe electron/ollama/hardwareScan/profileStore au chargement — mockés ici en no-op puisque cette
 * fonction précise ne les appelle jamais, exactement comme scripts/test-computer-use.mjs le fait déjà pour
 * computerUse.ts.
 */
const source = ts.transpileModule(readFileSync(new URL('../electron/services/codeGenerator.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

const modules = {
  electron: { app: { getPath: () => '/tmp' } },
  'fs/promises': { mkdir: async () => {}, writeFile: async () => {} },
  path: { join: (...parts) => parts.join('/') },
  './ollama': {
    chatWithOllama: async () => ({ content: '' }),
    listInstalledModels: async () => [],
    pullModelIfMissing: async () => {},
    ModelTooLargeError: class extends Error {},
    DiskFullError: class extends Error {}
  },
  './hardwareScan': { pickBestCodeModel: async () => 'test-model' },
  './profileStore': { getProfile: async () => null }
}
const exports = {}
vm.runInNewContext(source, { exports, require: (name) => modules[name], module: { exports } })

const { validateGeneratedHtml } = exports

const withStyle = (bodyRule) => `<!DOCTYPE html><html><head><style>${bodyRule}</style></head><body></body></html>`

test("body { height: 100vh; overflow: hidden } est détecté (piège réel du jeu Snake de Léo)", () => {
  const issues = validateGeneratedHtml(withStyle('body { height: 100vh; overflow: hidden; }'))
  assert.ok(issues.some((issue) => /overflow: hidden/.test(issue)))
})

test('html, body { height: 100%; overflow: hidden } (sélecteur combiné) est détecté', () => {
  const issues = validateGeneratedHtml(withStyle('html, body { height: 100%; overflow: hidden; }'))
  assert.ok(issues.some((issue) => /overflow: hidden/.test(issue)))
})

test("overflow-y: hidden (variante) est détecté", () => {
  const issues = validateGeneratedHtml(withStyle('body { height: 100vh; overflow-y: hidden; }'))
  assert.ok(issues.some((issue) => /overflow: hidden/.test(issue)))
})

test('overflow-x: hidden seul (page normale scrollable verticalement) ne déclenche PAS le piège', () => {
  const issues = validateGeneratedHtml(withStyle('body { min-height: 100vh; overflow-x: hidden; }'))
  assert.ok(!issues.some((issue) => /overflow: hidden/.test(issue)))
})

test("overflow: hidden sur un sélecteur qui n'est ni html ni body ne déclenche PAS le piège", () => {
  const issues = validateGeneratedHtml(withStyle('.card { overflow: hidden; } body { height: 100vh; }'))
  assert.ok(!issues.some((issue) => /overflow: hidden/.test(issue)))
})

test('height: 100vh sans overflow: hidden (page normale) ne déclenche PAS le piège', () => {
  const issues = validateGeneratedHtml(withStyle('body { min-height: 100vh; }'))
  assert.ok(!issues.some((issue) => /overflow: hidden/.test(issue)))
})
