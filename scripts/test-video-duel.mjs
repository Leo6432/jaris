import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

// Étape 257 : la partie pure du duel vidéo (shared/videoDuel.ts), chargée telle quelle dans le realm du test.
const source = ts.transpileModule(readFileSync(new URL('../shared/videoDuel.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const mod = { exports: {} }
vm.runInThisContext(`(function (exports, require, module) {\n${source}\n})`)(mod.exports, () => ({}), mod)
const {
  DUEL_PROMPTS, DUEL_SECONDS, drawDuelOrder, duelPair, duelVideoFile, formatDuelDuration, isDuelChoice, isDuelPromptId,
  isDuelVideoFile, parseDuelLine, summarizeDuel
} = mod.exports

/**
 * Lignes RÉELLES produites par python/video_duel.py, recopiées d'un vrai lancement ici (Kandinsky 6 Lite sur le
 * processeur, mini-vidéos 224x128) : si le script ou leur lecture changent de forme, ce test le voit.
 */
const REAL_LINES = [
  '{"event": "progress", "message": "Kandinsky lit la description « humain »…"}',
  '{"event": "done", "encode_seconds": 17.2, "load_seconds": null}',
  '{"event": "result", "name": "humain", "file": "kandinsky-humain.mp4", "seconds": 24.1, "denoise_seconds": 18.5, "peak_vram_gb": null, "offload": "cpu", "device": "cpu"}',
  '{"event": "done", "encode_seconds": null, "load_seconds": 2.4}'
]

test('trois descriptions (humain, paysage, chat), en français comme Léo les écrirait, durée par défaut du mode Vidéo', () => {
  assert.deepEqual(DUEL_PROMPTS.map((p) => p.id), ['humain', 'paysage', 'chat'])
  for (const p of DUEL_PROMPTS) assert.match(p.prompt, /vidéo réaliste$/)
  const videoModel = readFileSync(new URL('../shared/videoModel.ts', import.meta.url), 'utf8')
  assert.equal(DUEL_SECONDS, Number(videoModel.match(/DEFAULT_VIDEO_SECONDS: VideoSeconds = (\d+)/)[1]))
})

test('noms de vidéos : seuls les 6 du duel passent, jamais un chemin', () => {
  const ok = DUEL_PROMPTS.flatMap((p) => [duelVideoFile('fastwan', p.id), duelVideoFile('kandinsky', p.id)])
  assert.deepEqual(ok, ['fastwan-humain.webm', 'kandinsky-humain.mp4', 'fastwan-paysage.webm', 'kandinsky-paysage.mp4', 'fastwan-chat.webm', 'kandinsky-chat.mp4'])
  for (const name of ok) assert.ok(isDuelVideoFile(name), name)
  for (const bad of ['../resultats.json', 'fastwan-humain.mp4', 'kandinsky-chat.webm', 'fastwan-chien.webm', 'C:\\x\\fastwan-chat.webm', 'fastwan-chat.webm/..', 42, null]) {
    assert.equal(isDuelVideoFile(bad), false, String(bad))
  }
  assert.ok(isDuelChoice('egalite') && isDuelChoice('kandinsky') && !isDuelChoice('A'))
  assert.ok(isDuelPromptId('chat') && !isDuelPromptId('chien'))
})

test('aveugle : l’ordre A/B est tiré au hasard par description, et la paire suit cet ordre', () => {
  const draws = [0.1, 0.9, 0.4]
  const order = drawDuelOrder(() => draws.shift())
  assert.deepEqual({ ...order }, { humain: 'fastwan', paysage: 'kandinsky', chat: 'fastwan' })
  assert.deepEqual([...duelPair(order, 'humain')], ['fastwan', 'kandinsky'])
  assert.deepEqual([...duelPair(order, 'paysage')], ['kandinsky', 'fastwan'])
  // Sur beaucoup de tirages, les deux modèles passent en « A » : jamais toujours le même à gauche.
  const firsts = new Set(Array.from({ length: 50 }, () => drawDuelOrder().humain))
  assert.equal(firsts.size, 2)
})

test('durées lisibles', () => {
  assert.equal(formatDuelDuration(45.4), '45 s')
  assert.equal(formatDuelDuration(185), '3 min 05')
  assert.equal(formatDuelDuration(3725), '1 h 02')
})

test('résumé : choix comptés, temps totaux par modèle, complet seulement quand les 3 sont jugées', () => {
  const results = {
    videos: [
      { prompt: 'humain', model: 'fastwan', seconds: 60 },
      { prompt: 'paysage', model: 'fastwan', seconds: 70 },
      { prompt: 'humain', model: 'kandinsky', seconds: 400 }
    ],
    choices: { humain: 'kandinsky', paysage: 'egalite' }
  }
  const partial = summarizeDuel(results)
  assert.deepEqual({ ...partial.wins }, { fastwan: 0, kandinsky: 1, egalite: 1 })
  assert.deepEqual({ ...partial.totals }, { fastwan: 130, kandinsky: 400 })
  assert.equal(partial.complete, false)
  assert.equal(summarizeDuel({ ...results, choices: { ...results.choices, chat: 'fastwan' } }).complete, true)
  assert.equal(summarizeDuel({ videos: [], choices: {} }).totals.kandinsky, null)
})

test('lignes réelles du script Python : lues sans perte ; une ligne de bruit (barre de progression) est ignorée', () => {
  const events = REAL_LINES.map(parseDuelLine)
  assert.deepEqual({ ...events[0] }, { event: 'progress', message: 'Kandinsky lit la description « humain »…' })
  assert.deepEqual({ ...events[1] }, { event: 'done', encode_seconds: 17.2, load_seconds: null })
  assert.deepEqual({ ...events[2] }, { event: 'result', name: 'humain', file: 'kandinsky-humain.mp4', seconds: 24.1, peak_vram_gb: null, offload: 'cpu' })
  assert.deepEqual({ ...events[3] }, { event: 'done', encode_seconds: null, load_seconds: 2.4 })
  for (const noise of ['Loading weights: 100%|██████████| 729/729', '', '{"event":"result","name":"chien","file":"x","seconds":1}', '{"event":"result","name":"chat"}', 'null']) {
    assert.equal(parseDuelLine(noise), null, noise)
  }
})

test('le script Python émet exactement les évènements que Jaris lit, et écrit les noms de vidéos attendus', () => {
  const py = readFileSync(new URL('../python/video_duel.py', import.meta.url), 'utf8')
  for (const event of ['progress', 'result', 'error', 'done']) assert.match(py, new RegExp(`emit\\(\\s*"${event}"`))
  assert.match(py, /f"kandinsky-\{name\}\.mp4"/)
  // UTF-8 imposé (étape 121) : sinon les « » et les accents arriveraient cassés sur un Windows en cp1252.
  assert.match(py, /sys\.stdout\.reconfigure\(encoding="utf-8"\)/)
  // Le lecteur de description reste sur le processeur : 16,6 Go ne tiennent pas dans une carte de 8 Go.
  assert.doesNotMatch(py.slice(py.indexOf('def encode'), py.indexOf('def make_pipeline')), /cuda/)
})

test('environnement du duel : figé, à part de la voix, diffusers à un commit précis, torch hors de la liste', () => {
  const req = readFileSync(new URL('../python/video-duel-requirements.txt', import.meta.url), 'utf8')
  const lines = req.split('\n').filter((l) => l.trim() && !l.startsWith('#'))
  assert.match(lines[0], /^diffusers @ https:\/\/github\.com\/huggingface\/diffusers\/archive\/[0-9a-f]{40}\.zip$/)
  for (const line of lines.slice(1)) assert.match(line, /^[A-Za-z0-9_.-]+==[\w.+-]+$/, line)
  assert.ok(!lines.some((l) => /^torch(vision)?==/i.test(l)), 'torch vient de l’index CUDA, jamais de cette liste')
  const voice = readFileSync(new URL('../python/requirements.txt', import.meta.url), 'utf8')
  assert.ok(!/diffusers|^torch/m.test(voice), 'la voix ne reçoit rien du duel')
  const builder = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')
  assert.match(builder, /- video-duel-requirements\.txt/, 'empaqueté avec l’appli (sinon le bouton échouerait chez Léo)')
})
