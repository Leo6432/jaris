// Charge les modules TypeScript du téléphone (étape 214) pour les tests, sans Electron : transpilés à la
// volée et exécutés dans le realm courant (comparaisons d'objets fiables, voir CLAUDE.md sur vm.runInNewContext).
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { I18N_MODULES } from './i18n-test-module.mjs'

const nodeRequire = createRequire(import.meta.url)
const SERVICES = new URL('../electron/services/', import.meta.url)
const SHARED = new URL('../shared/', import.meta.url)

export function loadPhoneModules(overrides = {}) {
  const cache = {}
  // Les services (electron/services) ET les modules partagés qu'ils importent (shared/, étape 293 : le refus du
  // téléphone lit désormais shared/imageGallery), chacun résolu depuis son propre dossier.
  const loadFrom = (dir, name) => {
    const id = `${dir.href}${name}`
    if (cache[id]) return cache[id]
    const source = ts.transpileModule(readFileSync(new URL(`${name}.ts`, dir), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText
    const module = { exports: {} }
    cache[id] = module.exports
    const localRequire = (spec) => {
      if (overrides[spec]) return overrides[spec]
      if (spec in I18N_MODULES) return I18N_MODULES[spec]
      if (spec.startsWith('./')) return loadFrom(dir, spec.slice(2))
      if (dir === SERVICES && spec.startsWith('../../shared/')) return loadFrom(SHARED, spec.slice('../../shared/'.length))
      return nodeRequire(spec)
    }
    vm.runInThisContext(`(function (exports, require, module) {${source}\n})`)(module.exports, localRequire, module)
    cache[id] = module.exports
    return module.exports
  }
  return { load: (name) => loadFrom(SERVICES, name) }
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
