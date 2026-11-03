import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { modelChoiceModule } from './load-model-choice.mjs'
import { loadTsModule } from './load-ts-module.mjs'
import { withI18n } from './i18n-test-module.mjs'

/**
 * Étape 416 (Léo : « un bouton : arrête ta réflexion et écris le code ») : pendant que le modèle réfléchit, « Écrire le
 * code maintenant » coupe la réflexion et relance la MÊME étape sans réflexion, avec la fin de ce qu'il avait pensé.
 * Sans effet une fois qu'il écrit ; les étapes suivantes partent aussi sans réflexion ; « Arrêter » reste un arrêt.
 */
const source = ts.transpileModule(readFileSync(new URL('../electron/services/codeGenerator.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' })

/** `script(call)` : ce que fait le faux Ollama à chaque appel (réfléchir, attendre, écrire). */
function setup(script, { thinking = { canThink: true, values: [true, false], default: null } } = {}) {
  const calls = []
  const modules = {
    electron: { app: { getPath: () => '/tmp' } },
    './dataLocation': { getDataRoot: () => '/tmp' },
    'fs/promises': { mkdir: async () => {}, writeFile: async () => {} },
    path: { join: (...parts) => parts.join('/') },
    './ollama': {
      isModelLoaded: async () => true,
      getModelThinking: async () => thinking,
      chatWithOllama: async (messages, _tools, _model, think, signal, _numCtx, onToken, onThinking) => {
        const call = { messages, think, signal, onToken, onThinking }
        calls.push(call)
        return script(call, calls.length)
      },
      listInstalledModels: async () => ['test-model'],
      pullModelIfMissing: async () => {},
      ModelTooLargeError: class extends Error {},
      DiskFullError: class extends Error {}
    },
    '../../shared/lineDiff': loadTsModule('shared/lineDiff.ts'),
    // Le VRAI module : c'est lui qui dit ce que « sans réflexion » veut dire pour chaque modèle.
    '../../shared/effort': loadTsModule('shared/effort.ts'),
    './scriptSyntax': loadTsModule('electron/services/scriptSyntax.ts', { vm }),
    './hardwareScan': { pickBestCodeModel: async () => 'test-model' },
    './modelChoice': modelChoiceModule,
    './profileStore': { getProfile: async () => ({ codeModel: 'test-model' }) },
    '../config': { config: { ollama: { visionModel: 'v' } } },
    './vision': { IMAGE_FOR_CODE_SYSTEM_PROMPT: 'p', describeImage: async () => '' }
  }
  const exports = {}
  vm.runInNewContext(source, { exports, require: withI18n((name) => modules[name]), module: { exports }, console, setInterval, clearInterval, AbortController })
  const writeNow = new AbortController()
  const outer = new AbortController()
  const runner = exports.createModelStepRunner({
    model: 'test-model',
    think: 'high',
    modelMaxContext: 32768,
    steps: { index: 0, count: 2 },
    onStatus: () => {},
    signal: outer.signal,
    writeNow: writeNow.signal
  })
  const step = () => runner('Écriture', [{ role: 'system', content: 'règles' }, { role: 'user', content: 'Un compteur' }], 2000)
  return { calls, writeNow, outer, step, exports }
}

/** Réfléchit, puis attend d'être coupé (comme un modèle qui tourne en rond). */
const thinkForever = (call) =>
  new Promise((_resolve, reject) => {
    call.onThinking('Je pense au bouton. Il faut un compteur qui monte.')
    if (call.signal.aborted) return reject(aborted())
    call.signal.addEventListener('abort', () => reject(aborted()))
  })

test('pendant la réflexion : coupée, même étape relancée SANS réflexion avec ses notes, puis la suite aussi sans réflexion', async () => {
  const env = setup((call, n) => (n === 1 ? thinkForever(call) : Promise.resolve({ role: 'assistant', content: `code ${n}` })))
  const done = env.step()
  await new Promise((r) => setTimeout(r, 20))
  env.writeNow.abort()
  const message = await done
  assert.equal(message.content, 'code 2')
  assert.equal(env.calls.length, 2)
  assert.equal(env.calls[0].think, 'high')
  assert.equal(env.calls[1].think, false, 'le modèle peut couper sa réflexion : false')
  const ask = env.calls[1].messages.at(-1).content
  assert.match(ask, /^Un compteur/, 'la demande est intacte')
  assert.match(ask, /Il faut un compteur qui monte/, 'avec la fin de ce qu’il avait pensé')
  assert.match(ask, /écris MAINTENANT/)
  assert.equal(env.calls[0].messages.at(-1).content, 'Un compteur', 'le premier envoi n’a pas été modifié')
  // L'étape suivante (relecture) part directement sans réflexion, sans notes.
  await env.step()
  assert.equal(env.calls[2].think, false)
  assert.equal(env.calls[2].messages.at(-1).content, 'Un compteur')
})

test('un modèle à niveaux sans « off » descend à son plus petit niveau', async () => {
  const env = setup((call, n) => (n === 1 ? thinkForever(call) : Promise.resolve({ role: 'assistant', content: 'ok' })), {
    thinking: { canThink: true, values: ['low', 'medium', 'high'], default: 'medium' }
  })
  const done = env.step()
  await new Promise((r) => setTimeout(r, 20))
  env.writeNow.abort()
  await done
  assert.equal(env.calls[1].think, 'low')
})

test('une fois qu’il ÉCRIT, le bouton ne coupe rien (on ne jette pas du code déjà écrit)', async () => {
  let finish
  const env = setup((call) => {
    call.onToken('<!DOCTYPE html>')
    return new Promise((resolve, reject) => {
      finish = () => resolve({ role: 'assistant', content: '<!DOCTYPE html>…' })
      call.signal.addEventListener('abort', () => reject(aborted()))
    })
  })
  const done = env.step()
  await new Promise((r) => setTimeout(r, 20))
  env.writeNow.abort()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(env.calls[0].signal.aborted, false, 'l’écriture continue')
  finish()
  assert.equal((await done).content, '<!DOCTYPE html>…')
  assert.equal(env.calls.length, 1)
})

test('« Arrêter » reste un arrêt : rien n’est relancé', async () => {
  const env = setup((call) => thinkForever(call))
  const done = env.step()
  await new Promise((r) => setTimeout(r, 20))
  env.outer.abort()
  await assert.rejects(done, (err) => err instanceof env.exports.GenerationStoppedError)
  assert.equal(env.calls.length, 1)
})

test('les notes gardées sont la FIN de la réflexion, et rien n’est ajouté sans demande à modifier', () => {
  const { exports } = setup(() => Promise.resolve({ role: 'assistant', content: '' }))
  const msgs = exports.withWriteNowNote([{ role: 'user', content: 'A' }, { role: 'assistant', content: 'B' }, { role: 'user', content: 'C' }], '  notes  ')
  assert.equal(msgs[0].content, 'A')
  assert.match(msgs[2].content, /^C\n\n---\n.*<<<\nnotes\n>>>/s)
  assert.doesNotMatch(exports.withWriteNowNote([{ role: 'user', content: 'X' }], '').at(-1).content, /<<</)
  assert.equal(exports.withWriteNowNote([{ role: 'system', content: 'S' }], 'n')[0].content, 'S')
})
