import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadPhoneModules, makeWav } from './phone-test-loader.mjs'

/**
 * Étape 214 (Léo : « on va faire parler depuis son téléphone », confidentiel et sans appli à installer) : le
 * serveur du téléphone est joignable depuis internet par Tailscale Funnel. Ce qui protège Jaris, c'est donc
 * ce serveur : code d'appairage court et à usage unique, jetons par appareil révocables, aucun fichier servi
 * hors de la liste, tailles bornées. Chaque garde est vérifiée ici sur le VRAI serveur, avec de vraies requêtes.
 */

const PAGE_DIR = fileURLToPath(new URL('../phone/', import.meta.url))

/** Faux sélecteur du PC : mêmes règles que main.ts (rôle installé obligatoire, réflexion selon le modèle). */
function fakeModelChoices() {
  const state = { chat: { model: null, think: null }, voice: { model: null, think: null } }
  const calls = []
  const roles = [
    { value: 'role:flash', label: 'Faible', model: 'qwen3.5:4b', installed: true },
    { value: 'role:medium', label: 'Moyen', model: 'qwen3.5:9b', installed: true },
    { value: 'role:large', label: 'Élevé', model: 'qwen3.8:27b', installed: false }
  ]
  const info = (mode) => ({
    selected: state[mode].model,
    installed: ['qwen3.5:4b', 'qwen3.5:9b'],
    autoModel: null,
    roles,
    thinking: state[mode].model
      ? {
          model: roles.find((r) => r.value === state[mode].model).model,
          kind: 'levels',
          options: [
            { value: false, label: 'Aucune' },
            { value: 'low', label: 'Faible' },
            { value: 'high', label: 'Élevé' }
          ],
          selected: state[mode].think
        }
      : null
  })
  return {
    calls,
    getModelChoice: async (mode) => info(mode),
    setModelChoice: async (mode, model) => {
      calls.push(['model', mode, model])
      if (model !== null && !roles.find((r) => r.value === model && r.installed)) throw new Error(`Le modèle du rôle ${model} n'est pas installé dans Ollama.`)
      state[mode] = { model, think: null }
    },
    setThinkChoice: async (mode, think) => {
      calls.push(['think', mode, think])
      if (!state[mode].model) throw new Error("Choisis d'abord un modèle : en Auto, il change selon la question.")
      state[mode].think = think
    }
  }
}

const PNG = Buffer.from('89504e470d0a1a0a', 'hex')
const STUDIO_READY = {
  image: { ready: true, reason: null },
  video: { ready: true, reason: null, qualities: [{ id: 'q6', label: 'Équilibrée' }], durations: [1, 2, 3, 4, 5] }
}

async function start({ sendMessage, transcribe, history, now, ...overrides } = {}) {
  const { load } = loadPhoneModules()
  const { PhoneServer } = load('phoneServer')
  const { PhoneDeviceStore } = load('phoneDevices')
  const dir = mkdtempSync(join(tmpdir(), 'jaris-phone-'))
  const devicesFile = join(dir, 'phone-devices.json')
  const devices = new PhoneDeviceStore(devicesFile)
  const models = fakeModelChoices()
  const calls = { messages: [], modes: [], transcribed: [], spoken: [], images: [], videos: [], read: [] }
  const server = new PhoneServer({
    devices,
    pageDir: PAGE_DIR,
    now,
    history: history ?? (async () => [{ role: 'user', content: 'salut' }, { role: 'assistant', content: 'Salut Léo !' }]),
    transcribe:
      transcribe ??
      (async (wav) => {
        calls.transcribed.push(wav.length)
        return 'quelle heure est-il'
      }),
    sendMessage:
      sendMessage ??
      (async (text, onStatus, mode) => {
        calls.messages.push(text)
        calls.modes.push(mode)
        onStatus('Recherche sur le web…')
        return { reply: `Réponse à : ${text}` }
      }),
    speak: async (text) => {
      calls.spoken.push(text)
      return Buffer.from('RIFF-voix-de-jaris')
    },
    studio: async () => STUDIO_READY,
    generateImage: async (prompt, onStatus) => {
      calls.images.push(prompt)
      onStatus('Dessin : étape 1 sur 4')
      return { fileName: '2026-10-01T10-00-00-un-chat.png' }
    },
    generateVideo: async (prompt, seconds, quality, onStatus) => {
      calls.videos.push({ prompt, seconds, quality })
      onStatus('Vidéo : étape 1 sur 8')
      return { fileName: '2026-10-01T10-00-00-des-vagues.webm' }
    },
    listImages: async () => [{ fileName: '2026-10-01T10-00-00-un-chat.png', label: 'un chat', timestamp: 1 }],
    listVideos: async () => [{ fileName: '2026-10-01T10-00-00-des-vagues.webm', label: 'des vagues', timestamp: 1 }],
    readImage: async (fileName) => {
      calls.read.push(fileName)
      if (!/^[\w-]+\.png$/.test(fileName)) throw new Error('Image inconnue.')
      return PNG
    },
    readImageThumbnail: async (fileName) => {
      calls.read.push('mini:' + fileName)
      return Buffer.from('ffd8ff', 'hex')
    },
    readVideo: async (fileName) => {
      calls.read.push(fileName)
      if (!/^[\w-]+\.webm$/.test(fileName)) throw new Error('Vidéo inconnue.')
      return Buffer.from('1a45dfa3', 'hex')
    },
    ...models,
    ...overrides
  })
  const port = await server.listen()
  const base = `http://127.0.0.1:${port}`
  const request = (path, { method = 'GET', token, body, type } = {}) =>
    fetch(base + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': type ?? 'application/json' } : {}) },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body)
    })
  const pairWith = async (code) => request('/api/pair', { method: 'POST', body: { code, name: 'iPhone' } })
  const paired = async () => {
    const { code } = server.createPairingCode()
    const res = await pairWith(code)
    assert.equal(res.status, 200)
    return (await res.json()).token
  }
  const waitJob = async (token, id) => {
    for (let i = 0; i < 200; i++) {
      const job = await (await request(`/api/jobs/${id}`, { token })).json()
      if (job.state !== 'running') return job
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error('tâche jamais terminée')
  }
  return {
    server,
    devices,
    devicesFile,
    calls,
    models,
    request,
    pairWith,
    paired,
    waitJob,
    close: async () => {
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

test('n’écoute que sur 127.0.0.1 : rien sur le réseau local ni sur internet sans le tunnel', async () => {
  const source = readFileSync(new URL('../electron/services/phoneServer.ts', import.meta.url), 'utf8')
  assert.match(source, /listen\(0, '127\.0\.0\.1'/)
})

test('la page se charge sans connexion, avec une politique de sécurité stricte ; aucun autre fichier n’est servi', async () => {
  const t = await start()
  try {
    const page = await t.request('/')
    assert.equal(page.status, 200)
    assert.match(await page.text(), /<title>Jaris<\/title>/)
    const csp = page.headers.get('content-security-policy')
    assert.match(csp, /script-src 'self'/)
    assert.doesNotMatch(csp, /unsafe-inline'[^;]*script|script-src[^;]*unsafe/, 'aucun script en ligne autorisé')
    assert.equal(page.headers.get('x-frame-options'), 'DENY')
    for (const path of ['/app.js', '/app.css', '/manifest.webmanifest', '/icon-192.png']) {
      assert.equal((await t.request(path)).status, 200, path)
    }
    for (const path of ['/../package.json', '/%2e%2e/package.json', '/index.html/../../electron/main.ts', '/phone-devices.json', '/api']) {
      assert.equal((await t.request(path)).status, 404, path)
    }
  } finally {
    await t.close()
  }
})

test('sans jeton, rien de Jaris n’est accessible', async () => {
  const t = await start()
  try {
    for (const [path, method] of [['/api/history', 'GET'], ['/api/me', 'GET'], ['/api/message', 'POST'], ['/api/talk', 'POST'], ['/api/studio', 'GET'], ['/api/image', 'POST'], ['/api/video', 'POST'], ['/api/images', 'GET'], ['/api/videos', 'GET'], ['/api/images/2026-10-01T10-00-00-un-chat.png', 'GET'], ['/api/videos/2026-10-01T10-00-00-des-vagues.webm', 'GET']]) {
      const res = await t.request(path, { method, body: method === 'POST' ? { text: 'x' } : undefined })
      assert.equal(res.status, 401, path)
    }
    assert.equal((await t.request('/api/history', { token: 'faux-jeton' })).status, 401)
    assert.equal(t.calls.messages.length, 0)
    assert.equal(t.calls.images.length + t.calls.videos.length + t.calls.read.length, 0)
  } finally {
    await t.close()
  }
})

test('appairage : bon code -> jeton ; le code ne sert qu’une fois', async () => {
  const t = await start()
  try {
    const { code } = t.server.createPairingCode()
    assert.match(code, /^\d{8}$/)
    const ok = await t.pairWith(code)
    assert.equal(ok.status, 200)
    const { token } = await ok.json()
    assert.ok(token.length >= 40)
    assert.equal((await t.request('/api/me', { token })).status, 200)
    assert.equal((await t.pairWith(code)).status, 403, 'le même code ne connecte jamais un second appareil')
    // Le jeton n'est jamais écrit tel quel sur le disque du PC, seulement son empreinte.
    assert.ok(!readFileSync(t.devicesFile, 'utf8').includes(token))
    assert.deepEqual((await t.devices.list()).map((d) => d.name), ['iPhone'])
  } finally {
    await t.close()
  }
})

test('appairage : 5 mauvais codes tuent le code, et un code expire après 10 minutes', async () => {
  let clock = 1_000_000
  const t = await start({ now: () => clock })
  try {
    const { code } = t.server.createPairingCode()
    const wrong = code === '00000000' ? '11111111' : '00000000'
    for (let i = 0; i < 5; i++) assert.equal((await t.pairWith(wrong)).status, 403)
    assert.equal((await t.pairWith(code)).status, 403, 'après 5 erreurs, même le bon code est refusé')

    clock += 120_000
    const fresh = t.server.createPairingCode()
    clock += 10 * 60_000 + 1
    const res = await t.pairWith(fresh.code)
    assert.equal(res.status, 403)
    assert.match((await res.json()).error, /expiré/)
  } finally {
    await t.close()
  }
})

test('appairage : pas plus de 10 essais par minute, même avec des codes différents', async () => {
  const clock = 5_000_000
  const t = await start({ now: () => clock })
  try {
    for (let i = 0; i < 10; i++) {
      t.server.createPairingCode()
      await t.pairWith('12345678')
    }
    const { code } = t.server.createPairingCode()
    assert.equal((await t.pairWith(code)).status, 429)
  } finally {
    await t.close()
  }
})

test('déconnecter un téléphone coupe immédiatement son accès, sans toucher aux autres', async () => {
  const t = await start()
  try {
    const first = await t.paired()
    const second = await t.paired()
    const [device] = await t.devices.list()
    await t.devices.remove(device.id)
    assert.equal((await t.request('/api/history', { token: first })).status, 401)
    assert.equal((await t.request('/api/history', { token: second })).status, 200)
  } finally {
    await t.close()
  }
})

test('message écrit : réponse suivie jusqu’au bout, avec la progression en français', async () => {
  let release
  const gate = new Promise((r) => (release = r))
  const t = await start({
    sendMessage: async (text, onStatus) => {
      onStatus('Recherche sur le web…')
      await gate
      return { reply: `Réponse à : ${text}`, image: 'data:image/png;base64,AAAA' }
    }
  })
  try {
    const token = await t.paired()
    const history = await (await t.request('/api/history', { token })).json()
    assert.equal(history.messages[1].content, 'Salut Léo !')

    const res = await t.request('/api/message', { method: 'POST', token, body: { text: 'météo à Lyon' } })
    assert.equal(res.status, 202)
    const { jobId } = await res.json()
    const running = await (await t.request(`/api/jobs/${jobId}`, { token })).json()
    assert.equal(running.state, 'running')
    assert.equal(running.status, 'Recherche sur le web…')
    assert.equal((await t.request('/api/message', { method: 'POST', token, body: { text: 'autre' } })).status, 409, 'un message à la fois')

    release()
    const job = await t.waitJob(token, jobId)
    assert.equal(job.state, 'done')
    assert.equal(job.reply, 'Réponse à : météo à Lyon')
    assert.equal(job.image, 'data:image/png;base64,AAAA')
    assert.equal((await t.request(`/api/jobs/${jobId}`)).status, 401, 'le suivi exige aussi le jeton')
  } finally {
    await t.close()
  }
})

test('Vocal : seul un WAV 16 kHz mono est accepté ; transcrit, répondu en mode voix, puis lu avec la voix de Jaris', async () => {
  const t = await start()
  try {
    const token = await t.paired()
    const bad = await t.request('/api/talk', { method: 'POST', token, body: Buffer.from('pas un wav du tout, juste du texte'), type: 'audio/wav' })
    assert.equal(bad.status, 400)
    const stereo = await t.request('/api/talk', { method: 'POST', token, body: makeWav(300, 16000, 2), type: 'audio/wav' })
    assert.equal(stereo.status, 400)
    const big = await t.request('/api/talk', { method: 'POST', token, body: makeWav(200_000), type: 'audio/wav' })
    assert.equal(big.status, 413, 'au-delà de ~2 min 40, refusé avant même d’être lu en entier')
    assert.equal(t.calls.transcribed.length, 0)
    assert.equal((await t.request('/api/voice', { method: 'POST', token, body: makeWav(500), type: 'audio/wav' })).status, 404, 'l’ancien dictaphone n’existe plus')

    const res = await t.request('/api/talk', { method: 'POST', token, body: makeWav(500), type: 'audio/wav' })
    assert.equal(res.status, 202)
    const job = await t.waitJob(token, (await res.json()).jobId)
    assert.equal(job.state, 'done')
    assert.equal(job.transcript, 'quelle heure est-il')
    assert.deepEqual(t.calls.messages, ['quelle heure est-il'])
    assert.deepEqual(t.calls.modes, ['voice'], 'réponse prévue pour être lue à voix haute')
    assert.deepEqual(t.calls.spoken, ['Réponse à : quelle heure est-il'])
    assert.equal(job.audio, true)
    assert.equal((await t.request(`/api/jobs/${job.id}/audio`)).status, 401, 'la voix exige aussi le jeton')
    const audio = await t.request(`/api/jobs/${job.id}/audio`, { token })
    assert.equal(audio.status, 200)
    assert.equal(audio.headers.get('content-type'), 'audio/wav')
    assert.equal(Buffer.from(await audio.arrayBuffer()).toString(), 'RIFF-voix-de-jaris')
  } finally {
    await t.close()
  }
})

test('Vocal : sans voix disponible sur le PC, la réponse arrive quand même, écrite', async () => {
  const t = await start({
    speak: async () => {
      throw new Error('Supertonic ne répond pas.')
    }
  })
  try {
    const token = await t.paired()
    const res = await t.request('/api/talk', { method: 'POST', token, body: makeWav(500), type: 'audio/wav' })
    const job = await t.waitJob(token, (await res.json()).jobId)
    assert.equal(job.state, 'done')
    assert.equal(job.reply, 'Réponse à : quelle heure est-il')
    assert.equal(job.audio, false)
    assert.equal((await t.request(`/api/jobs/${job.id}/audio`, { token })).status, 404)
  } finally {
    await t.close()
  }
})

test('Chat écrit : la réponse est demandée en mode chat (mise en forme permise)', async () => {
  const t = await start()
  try {
    const token = await t.paired()
    const res = await t.request('/api/message', { method: 'POST', token, body: { text: 'salut' } })
    await t.waitJob(token, (await res.json()).jobId)
    assert.deepEqual(t.calls.modes, ['chat'])
    assert.deepEqual(t.calls.spoken, [], 'le Chat ne fabrique jamais de voix')
  } finally {
    await t.close()
  }
})

test('Image : refusée tant que le mode Image n’est pas prêt sur le PC, avec la raison', async () => {
  const t = await start({
    studio: async () => ({
      image: { ready: false, reason: 'Le mode Image n’est pas encore installé : installe-le une fois depuis Jaris sur ton PC (mode Image).' },
      video: { ready: false, reason: 'Pas de vidéo ici.', qualities: [], durations: [1, 2] }
    })
  })
  try {
    const token = await t.paired()
    const res = await t.request('/api/image', { method: 'POST', token, body: { prompt: 'un chat' } })
    assert.equal(res.status, 409)
    assert.match((await res.json()).error, /installe-le une fois depuis Jaris sur ton PC/)
    assert.equal((await t.request('/api/video', { method: 'POST', token, body: { prompt: 'x', seconds: 1, quality: 'q6' } })).status, 409)
    assert.deepEqual(t.calls.images, [])
  } finally {
    await t.close()
  }
})

test('Image : créée sur le PC avec sa progression ; une seule création à la fois, sans bloquer la conversation', async () => {
  let release
  const gate = new Promise((r) => (release = r))
  const t = await start({
    generateImage: async (prompt, onStatus) => {
      onStatus('Dessin : étape 2 sur 4')
      await gate
      return { fileName: '2026-10-01T10-00-00-un-chat.png' }
    }
  })
  try {
    const token = await t.paired()
    assert.equal((await t.request('/api/image', { method: 'POST', token, body: { prompt: '   ' } })).status, 400)
    assert.equal((await t.request('/api/image', { method: 'POST', token, body: { prompt: 'a'.repeat(1001) } })).status, 413)
    const res = await t.request('/api/image', { method: 'POST', token, body: { prompt: 'un chat' } })
    assert.equal(res.status, 202)
    const { jobId } = await res.json()
    const running = await (await t.request(`/api/jobs/${jobId}`, { token })).json()
    assert.equal(running.status, 'Dessin : étape 2 sur 4')
    assert.equal((await t.request('/api/video', { method: 'POST', token, body: { prompt: 'x', seconds: 2, quality: 'q6' } })).status, 409, 'une création à la fois')
    const chat = await t.request('/api/message', { method: 'POST', token, body: { text: 'salut' } })
    assert.equal(chat.status, 202, 'parler à Jaris reste possible pendant une création')
    release()
    const job = await t.waitJob(token, jobId)
    assert.equal(job.state, 'done')
    assert.equal(job.fileName, '2026-10-01T10-00-00-un-chat.png')
  } finally {
    await t.close()
  }
})

test('Vidéo : seules une durée et une qualité proposées par le PC sont acceptées', async () => {
  const t = await start()
  try {
    const token = await t.paired()
    for (const body of [
      { prompt: 'vagues', seconds: 9, quality: 'q6' },
      { prompt: 'vagues', seconds: '2', quality: 'q6' },
      { prompt: 'vagues', seconds: 2, quality: 'q8' },
      { prompt: 'vagues', seconds: 2, quality: '../../x' }
    ]) {
      assert.equal((await t.request('/api/video', { method: 'POST', token, body })).status, 400, JSON.stringify(body))
    }
    assert.deepEqual(t.calls.videos, [])
    const res = await t.request('/api/video', { method: 'POST', token, body: { prompt: 'des vagues', seconds: 3, quality: 'q6' } })
    const job = await t.waitJob(token, (await res.json()).jobId)
    assert.equal(job.state, 'done')
    assert.deepEqual(t.calls.videos, [{ prompt: 'des vagues', seconds: 3, quality: 'q6' }])
  } finally {
    await t.close()
  }
})

test('Arrêter : une création s’arrête vraiment ; une réponse de Jaris, elle, ne s’arrête pas', async () => {
  let seenSignal
  const t = await start({
    generateVideo: (prompt, seconds, quality, onStatus, signal) => {
      seenSignal = signal
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Vidéo arrêtée.'))))
    },
    sendMessage: () => new Promise(() => {})
  })
  try {
    const token = await t.paired()
    const res = await t.request('/api/video', { method: 'POST', token, body: { prompt: 'vagues', seconds: 2, quality: 'q6' } })
    const { jobId } = await res.json()
    assert.equal((await t.request(`/api/jobs/${jobId}/cancel`, { method: 'POST', body: {} })).status, 401)
    assert.equal(seenSignal.aborted, false)
    assert.equal((await t.request(`/api/jobs/${jobId}/cancel`, { method: 'POST', token, body: {} })).status, 200)
    const job = await t.waitJob(token, jobId)
    assert.equal(job.state, 'cancelled')
    assert.equal(job.error, undefined, 'un arrêt demandé n’est pas présenté comme une erreur')
    assert.equal((await t.request('/api/image', { method: 'POST', token, body: { prompt: 'chat' } })).status, 202, 'la place est libérée')

    const chat = await t.request('/api/message', { method: 'POST', token, body: { text: 'salut' } })
    const chatId = (await chat.json()).jobId
    assert.equal((await t.request(`/api/jobs/${chatId}/cancel`, { method: 'POST', token, body: {} })).status, 400)
  } finally {
    await t.close()
  }
})

test('Galeries : listes et fichiers servis avec le jeton ; aucun nom hors de ceux de Jaris n’est même lu', async () => {
  const t = await start()
  try {
    const token = await t.paired()
    assert.equal((await (await t.request('/api/images', { token })).json()).items[0].label, 'un chat')
    assert.equal((await (await t.request('/api/videos', { token })).json()).items[0].label, 'des vagues')

    const image = await t.request('/api/images/2026-10-01T10-00-00-un-chat.png', { token })
    assert.equal(image.status, 200)
    assert.equal(image.headers.get('content-type'), 'image/png')
    assert.equal(image.headers.get('cache-control'), 'private, no-store')
    const mini = await t.request('/api/images/2026-10-01T10-00-00-un-chat.png?thumb=1', { token })
    assert.equal(mini.headers.get('content-type'), 'image/jpeg', 'la galerie reçoit une vignette légère')
    const video = await t.request('/api/videos/2026-10-01T10-00-00-des-vagues.webm', { token })
    assert.equal(video.headers.get('content-type'), 'video/webm')

    t.calls.read.length = 0
    for (const name of ['..%2F..%2Fpackage.json', '%2e%2e', '.env', 'a%00b.png', '%E0%A4%A', 'x'.repeat(200) + '.png']) {
      assert.equal((await t.request('/api/images/' + name, { token })).status, 404, name)
      assert.equal((await t.request('/api/videos/' + name, { token })).status, 404, name)
    }
    assert.deepEqual(t.calls.read, [], 'refusé avant même de demander le fichier au PC')
    assert.equal((await t.request('/api/images/autre-chose.webm', { token })).status, 404, 'erreur de lecture du PC -> introuvable')
  } finally {
    await t.close()
  }
})

test('une vidéo longue ne disparaît jamais du suivi, même après beaucoup de messages', async () => {
  let release
  const gate = new Promise((r) => (release = r))
  const t = await start({
    generateVideo: async () => {
      await gate
      return { fileName: '2026-10-01T10-00-00-des-vagues.webm' }
    }
  })
  try {
    const token = await t.paired()
    const res = await t.request('/api/video', { method: 'POST', token, body: { prompt: 'vagues', seconds: 2, quality: 'q6' } })
    const { jobId } = await res.json()
    for (let i = 0; i < 25; i++) {
      const chat = await t.request('/api/message', { method: 'POST', token, body: { text: 'message ' + i } })
      await t.waitJob(token, (await chat.json()).jobId)
    }
    assert.equal((await t.request(`/api/jobs/${jobId}`, { token })).status, 200)
    release()
    assert.equal((await t.waitJob(token, jobId)).state, 'done')
  } finally {
    await t.close()
  }
})

test('une erreur de Jaris arrive au téléphone telle quelle, lisible', async () => {
  const t = await start({
    sendMessage: async () => {
      throw new Error("Impossible de joindre Ollama : il n'est pas lancé.")
    }
  })
  try {
    const token = await t.paired()
    const res = await t.request('/api/message', { method: 'POST', token, body: { text: 'salut' } })
    const job = await t.waitJob(token, (await res.json()).jobId)
    assert.equal(job.state, 'error')
    assert.equal(job.error, "Impossible de joindre Ollama : il n'est pas lancé.")
    const next = await t.request('/api/message', { method: 'POST', token, body: { text: 'encore' } })
    assert.equal(next.status, 202, 'après une erreur, un nouveau message est accepté')
  } finally {
    await t.close()
  }
})

test('requêtes abusives : JSON illisible, texte vide ou géant', async () => {
  const t = await start()
  try {
    const token = await t.paired()
    assert.equal((await t.request('/api/message', { method: 'POST', token, body: Buffer.from('{pas du json'), type: 'application/json' })).status, 400)
    assert.equal((await t.request('/api/message', { method: 'POST', token, body: { text: '   ' } })).status, 400)
    assert.equal((await t.request('/api/message', { method: 'POST', token, body: { text: 'a'.repeat(5000) } })).status, 413)
    assert.equal((await t.request('/api/message', { method: 'POST', token, body: { text: 'a'.repeat(70_000) } })).status, 413)
  } finally {
    await t.close()
  }
})

test('Modèle : le même sélecteur que le PC, pour le Chat et le Vocal seulement ; ses refus arrivent lisibles', async () => {
  const t = await start()
  try {
    assert.equal((await t.request('/api/model?mode=chat')).status, 401)
    assert.equal((await t.request('/api/model', { method: 'POST', body: { mode: 'chat', model: null } })).status, 401)
    const token = await t.paired()
    const info = await (await t.request('/api/model?mode=chat', { token })).json()
    assert.equal(info.selected, null)
    assert.deepEqual(info.roles.map((r) => r.label), ['Faible', 'Moyen', 'Élevé'])
    for (const mode of ['code', '', 'chat2']) {
      assert.equal((await t.request('/api/model?mode=' + mode, { token })).status, 400, mode)
      assert.equal((await t.request('/api/model', { method: 'POST', token, body: { mode, model: null } })).status, 400, mode)
    }
    assert.equal((await t.request('/api/model', { method: 'POST', token, body: { mode: 'chat', model: 42 } })).status, 400)

    const chosen = await t.request('/api/model', { method: 'POST', token, body: { mode: 'voice', model: 'role:medium' } })
    assert.equal(chosen.status, 200)
    assert.equal((await chosen.json()).selected, 'role:medium', 'renvoie l’état à jour')
    const think = await t.request('/api/think', { method: 'POST', token, body: { mode: 'voice', think: 'high' } })
    assert.equal((await think.json()).thinking.selected, 'high')
    const refused = await t.request('/api/model', { method: 'POST', token, body: { mode: 'chat', model: 'role:large' } })
    assert.equal(refused.status, 400)
    assert.match((await refused.json()).error, /pas installé dans Ollama/)
    assert.deepEqual(t.models.calls, [
      ['model', 'voice', 'role:medium'],
      ['think', 'voice', 'high'],
      ['model', 'chat', 'role:large']
    ])
  } finally {
    await t.close()
  }
})
