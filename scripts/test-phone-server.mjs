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

async function start({ sendMessage, transcribe, history, now } = {}) {
  const { load } = loadPhoneModules()
  const { PhoneServer } = load('phoneServer')
  const { PhoneDeviceStore } = load('phoneDevices')
  const dir = mkdtempSync(join(tmpdir(), 'jaris-phone-'))
  const devicesFile = join(dir, 'phone-devices.json')
  const devices = new PhoneDeviceStore(devicesFile)
  const calls = { messages: [], transcribed: [] }
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
      (async (text, onStatus) => {
        calls.messages.push(text)
        onStatus('Recherche sur le web…')
        return { reply: `Réponse à : ${text}` }
      })
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
    for (const [path, method] of [['/api/history', 'GET'], ['/api/me', 'GET'], ['/api/message', 'POST'], ['/api/voice', 'POST']]) {
      const res = await t.request(path, { method, body: method === 'POST' ? { text: 'x' } : undefined })
      assert.equal(res.status, 401, path)
    }
    assert.equal((await t.request('/api/history', { token: 'faux-jeton' })).status, 401)
    assert.equal(t.calls.messages.length, 0)
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

test('message vocal : seul un WAV 16 kHz mono est accepté, transcrit sur le PC puis traité comme un message', async () => {
  const t = await start()
  try {
    const token = await t.paired()
    const bad = await t.request('/api/voice', { method: 'POST', token, body: Buffer.from('pas un wav du tout, juste du texte'), type: 'audio/wav' })
    assert.equal(bad.status, 400)
    const stereo = await t.request('/api/voice', { method: 'POST', token, body: makeWav(300, 16000, 2), type: 'audio/wav' })
    assert.equal(stereo.status, 400)
    const big = await t.request('/api/voice', { method: 'POST', token, body: makeWav(200_000), type: 'audio/wav' })
    assert.equal(big.status, 413, 'au-delà de ~2 min 40, refusé avant même d’être lu en entier')
    assert.equal(t.calls.transcribed.length, 0)

    const res = await t.request('/api/voice', { method: 'POST', token, body: makeWav(500), type: 'audio/wav' })
    assert.equal(res.status, 202)
    const job = await t.waitJob(token, (await res.json()).jobId)
    assert.equal(job.state, 'done')
    assert.equal(job.transcript, 'quelle heure est-il')
    assert.deepEqual(t.calls.messages, ['quelle heure est-il'])
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
