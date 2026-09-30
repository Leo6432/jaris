import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Correcteur de ce que Léo a dit (étape 207). Le modèle est simulé ici : ce qui est vérifié, ce sont les VERROUS
 * qui empêchent un petit modèle local de remplacer la phrase par une réponse, une reformulation ou un ajout —
 * le texte d'origine doit toujours revenir dès qu'un verrou cède. La qualité réelle des corrections a été
 * mesurée à part, avec de vrais modèles du palier Rapide dans Ollama (voir CLAUDE.md, étape 207).
 */
const projectRoot = fileURLToPath(new URL('..', import.meta.url))

function load(relativePath) {
  const source = ts.transpileModule(readFileSync(join(projectRoot, relativePath), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  vm.runInThisContext(`(function (exports, module) { ${source} })`)(module.exports, module)
  return module.exports
}

const c = load('electron/services/transcriptCorrector.ts')
const reply = (texte) => async () => JSON.stringify({ texte })

test('une vraie correction passe : mot déformé, nom de l’assistant, ponctuation', () => {
  assert.equal(c.acceptCorrection('ouvre stime', 'Ouvre Steam.'), true)
  assert.equal(c.acceptCorrection('Charisse mets un minuteur de dis minutes', 'Jaris, mets un minuteur de dix minutes.'), true)
  assert.equal(c.acceptCorrection('quel temps fait il à paris demain', 'Quel temps fait-il à Paris demain ?'), true)
})

test('une réponse, une reformulation ou un ajout sont refusés', () => {
  assert.equal(c.acceptCorrection('quelle est la capitale de la france', 'La capitale de la France est Paris.'), false)
  assert.equal(c.acceptCorrection('bonjour', 'Bonjour, comment puis-je t’aider ?'), false)
  assert.equal(c.acceptCorrection('ouvre steam', "Bien sûr, j'ouvre Steam pour toi."), false)
  assert.equal(c.acceptCorrection('raconte moi une blague', 'Voici une blague : pourquoi les plongeurs...'), false)
  assert.equal(c.acceptCorrection('ouvre steam', ''), false)
})

test('correctTranscript : correction acceptée → phrase corrigée, marquée comme changée', async () => {
  const out = await c.correctTranscript('ouvre stime', reply('Ouvre Steam.'))
  assert.deepEqual({ ...out }, { text: 'Ouvre Steam.', changed: true })
})

test('correctTranscript : le modèle répond à la question → la phrase entendue est gardée telle quelle', async () => {
  const out = await c.correctTranscript('quelle est la capitale de la france', reply('La capitale de la France est Paris.'))
  assert.deepEqual({ ...out }, { text: 'quelle est la capitale de la france', changed: false })
})

test('correctTranscript : réponse illisible, modèle en panne ou trop lent → la phrase entendue, sans bloquer', async () => {
  assert.equal((await c.correctTranscript('ouvre stime', async () => 'pas du JSON')).changed, false)
  assert.equal((await c.correctTranscript('ouvre stime', async () => JSON.stringify({ autre: 'x' }))).changed, false)
  assert.equal((await c.correctTranscript('ouvre stime', async () => { throw new Error('Ollama injoignable') })).text, 'ouvre stime')
  const slow = (_s, _u, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
  const started = Date.now()
  const out = await c.correctTranscript('ouvre stime', slow, null, undefined, 50)
  assert.equal(out.text, 'ouvre stime')
  assert.ok(Date.now() - started < 2000, 'le délai coupe l’attente')
})

test('correctTranscript : une annulation demandée par Jaris (nouvelle phrase captée) remonte au lieu d’être avalée', async () => {
  const controller = new AbortController()
  const slow = (_s, _u, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('annulé'))))
  const running = c.correctTranscript('ouvre stime', slow, null, controller.signal, 60_000)
  controller.abort()
  await assert.rejects(running)
})

test('le prénom de Léo et le nom de Jaris sont donnés au modèle ; une phrase vide n’appelle pas le modèle', async () => {
  let system = ''
  await c.correctTranscript('ouvre stime', async (s) => ((system = s), JSON.stringify({ texte: 'Ouvre Steam.' })), 'Léo')
  assert.match(system, /« Jaris »/)
  assert.match(system, /« Léo »/)
  let called = false
  await c.correctTranscript('  ', async () => ((called = true), '{}'))
  assert.equal(called, false)
})

test('le pipeline vocal répond à la phrase CORRIGÉE, et le réglage d’Options peut couper le correcteur', () => {
  const source = readFileSync(join(projectRoot, 'electron/services/voicePipeline.ts'), 'utf8')
  assert.match(source, /voiceCorrectionEnabled !== false/)
  assert.match(source, /converse\(\s*question,/)
  assert.match(source, /pushSessionExchange\(question, reply\)/)
  assert.match(source, /correctTranscript\([\s\S]{0,400}controller\.signal/, 'la correction est annulable comme la réflexion')
})
