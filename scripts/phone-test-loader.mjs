// Charge les modules TypeScript du téléphone (étape 214) pour les tests, sans Electron : transpilés à la
// volée et exécutés dans le realm courant (comparaisons d'objets fiables, voir CLAUDE.md sur vm.runInNewContext).
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const nodeRequire = createRequire(import.meta.url)
const SERVICES = new URL('../electron/services/', import.meta.url)

export function loadPhoneModules(overrides = {}) {
  const cache = {}
  const load = (name) => {
    if (cache[name]) return cache[name]
    const source = ts.transpileModule(readFileSync(new URL(`${name}.ts`, SERVICES), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText
    const module = { exports: {} }
    cache[name] = module.exports
    const localRequire = (spec) => {
      if (overrides[spec]) return overrides[spec]
      if (spec.startsWith('./')) return load(spec.slice(2))
      return nodeRequire(spec)
    }
    vm.runInThisContext(`(function (exports, require, module) {${source}\n})`)(module.exports, localRequire, module)
    cache[name] = module.exports
    return module.exports
  }
  return { load }
}

/** WAV PCM 16 bits mono 16 kHz de `ms` millisecondes (silence), le format envoyé par la page. */
export function makeWav(ms = 500, rate = 16000, channels = 1) {
  const samples = Math.round((rate * ms) / 1000)
  const buffer = Buffer.alloc(44 + samples * 2 * channels)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + samples * 2 * channels, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(rate, 24)
  buffer.writeUInt32LE(rate * 2 * channels, 28)
  buffer.writeUInt16LE(2 * channels, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(samples * 2 * channels, 40)
  return buffer
}
