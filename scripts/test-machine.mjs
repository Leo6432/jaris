import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 437 (Léo : « un bouton Machine à gauche… tout Jaris tourne sur le VPS, si je vais dans Analyse et que je lance,
 * ça se fait sur le VPS, et après je peux déconnecter »). Ce qui est vérifié ici : où partent VRAIMENT les demandes aux
 * modèles (machine connectée, ce PC, portée explicite), la connexion qui ne bascule jamais vers une adresse muette, la
 * préparation épinglée à la machine (une déconnexion en route ne télécharge jamais la suite sur ce PC), et les gardes.
 */
function loadConfig() {
  return loadTsModule('electron/config.ts', {
    async_hooks: { AsyncLocalStorage },
    dotenv: { config: () => ({}) },
    fs: { existsSync: () => false },
    path
  })
}

const duel = loadTsModule('shared/duel.ts')
const machine = loadTsModule('shared/machine.ts', { './duel': duel })

test('l’adresse des modèles : la machine connectée par défaut, mais une portée explicite garde la priorité', async () => {
  const config = loadConfig()
  const local = config.config.ollama.host
  assert.equal(config.config.ollama.remote, false)
  config.setMachineOllamaHost({ host: 'https://machine.example' })
  assert.equal(config.config.ollama.host, 'https://machine.example', 'Chat, Vocal, Code : vers la machine')
  assert.equal(config.config.ollama.remote, true, 'rien de ce PC ne s’y applique (disque, mémoire, vitesse)')
  assert.equal(config.config.ollama.localHost, local, 'la surveillance de l’Ollama de ce PC reste sur ce PC')
  assert.equal(await config.runWithLocalOllama(async () => config.config.ollama.host), local, 'les outils d’un duel restent sur ce PC')
  assert.equal(await config.runWithLocalOllama(async () => config.config.ollama.remote), false)
  assert.equal(await config.runWithOllamaHost('https://autre.example', async () => config.config.ollama.host), 'https://autre.example')
  config.setMachineOllamaHost(null)
  assert.equal(config.config.ollama.host, local, 'déconnectée : retour à ce PC')
  assert.equal(config.config.ollama.remote, false)
})

test('réglages de la machine : revérifiés, et l’ancienne adresse du Duel reprise une fois', () => {
  assert.deepEqual(
    { ...machine.parseRemoteMachine({ host: '123.45.67.89:11434', vramGb: 80, ramGb: 64, diskGb: 100 }) },
    { host: 'http://123.45.67.89:11434', vramGb: 80, ramGb: 64, diskGb: 100 }
  )
  assert.equal(machine.parseRemoteMachine({ host: 'pas une adresse', vramGb: 80, ramGb: 64, diskGb: 100 }), null)
  assert.equal(machine.parseRemoteMachine({ host: '1.2.3.4', vramGb: 80, ramGb: 64, diskGb: 5 }), null, 'moins de 10 Go de disque')
  assert.equal(machine.parseRemoteMachine({ host: '1.2.3.4', vramGb: Number.NaN, ramGb: 64, diskGb: 100 }), null)
  const old = machine.savedRemoteMachine({ duelRemote: { enabled: true, host: 'https://abc-11434.proxy.runpod.net', vramGb: 141, ramGb: 188 } })
  assert.equal(old.host, 'https://abc-11434.proxy.runpod.net')
  assert.equal(old.diskGb, 100)
  const saved = machine.savedRemoteMachine({ remoteMachine: { host: '1.2.3.4', vramGb: 24, ramGb: 32, diskGb: 200 }, duelRemote: { host: 'https://x.y', vramGb: 1, ramGb: 1 } })
  assert.equal(saved.host, 'http://1.2.3.4', 'la page Machine prime')
})

function loadService({ reachable = true, installed = [], onVersion = null } = {}) {
  const config = loadConfig()
  const calls = { pulls: [], lists: [], versions: [], patched: [] }
  let releasePull = null
  const ollama = {
    fetchOllamaVersion: async () => {
      calls.versions.push(config.config.ollama.host)
      onVersion?.()
      if (!reachable) throw new Error('La machine des modèles ne répond pas.')
      return '0.40.4'
    },
    listInstalledModels: async () => {
      calls.lists.push(config.config.ollama.host)
      return installed
    },
    pullModelIfMissing: (model, _status, onProgress, signal) =>
      new Promise((resolve, reject) => {
        calls.pulls.push([model, config.config.ollama.host])
        onProgress?.({ model, completed: 1, total: 2, percent: 50 })
        releasePull = () => resolve(true)
        signal?.addEventListener('abort', () => reject(new Error('arrêté')))
      })
  }
  const profile = { models: { flash: 'qwen3.5:2b', medium: 'qwen3.5:9b', large: 'qwen3.5:9b' }, visionModel: 'qwen3-vl:8b' }
  const service = loadTsModule('electron/services/remoteMachine.ts', {
    '../config': config,
    '../../shared/machine': machine,
    '../../shared/duel': duel,
    './ollama': ollama,
    './profileStore': { getProfile: async () => profile, patchProfile: async (change) => calls.patched.push(change) }
  })
  return { service, config, calls, release: () => releasePull?.() }
}

const SETTINGS = { host: 'http://10.0.0.5:11434', vramGb: 80, ramGb: 64, diskGb: 100 }
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('connecter : une adresse qui ne répond pas ne fait jamais basculer Jaris', async () => {
  const { service, config } = loadService({ reachable: false })
  const local = config.config.ollama.host
  const view = await service.connectMachine(SETTINGS)
  assert.equal(view.connected, false)
  assert.match(view.error, /ne répond pas/)
  assert.equal(config.config.ollama.host, local)
  await assert.rejects(service.connectMachine({ host: 'nulle part', vramGb: 80, ramGb: 64, diskGb: 100 }), /Vérifie les réglages/)
})

test('connecter : tout Jaris passe sur la machine, ses modèles y sont téléchargés ; déconnecter en route ne télécharge rien sur ce PC', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ models: [{ size: 6 * 1024 ** 3 }] }) })
  try {
    const { service, config, calls, release } = loadService({ installed: ['qwen3.5:2b'] })
    const local = config.config.ollama.host
    const view = await service.connectMachine(SETTINGS)
    assert.equal(view.connected, true)
    assert.equal(view.version, '0.40.4')
    assert.equal(config.config.ollama.host, SETTINGS.host)
    assert.deepEqual(calls.patched.map((c) => c.remoteMachine.host), [SETTINGS.host], 'l’adresse est gardée pour la prochaine fois')
    await tick()
    await tick()
    let now = service.machineView()
    assert.deepEqual(now.models.map((m) => [m.model, m.installed]), [['qwen3.5:2b', true], ['qwen3.5:9b', false], ['qwen3-vl:8b', false]], 'chaque modèle une fois')
    assert.equal(now.freeDiskGb, 84, '100 Go − 10 réservés − 6 de modèles')
    assert.deepEqual(calls.pulls, [['qwen3.5:9b', SETTINGS.host]])
    assert.deepEqual(now.pulling, { model: 'qwen3.5:9b', percent: 50 })
    release()
    await tick()
    await tick()
    assert.deepEqual(calls.pulls.at(-1), ['qwen3-vl:8b', SETTINGS.host], 'le suivant, toujours sur la machine')

    // Déconnexion pendant le 2e téléchargement : il s'arrête, et rien ne part vers ce PC.
    service.disconnectMachine()
    assert.equal(config.config.ollama.host, local)
    await tick()
    await tick()
    assert.equal(calls.pulls.length, 2)
    assert.ok(calls.pulls.every(([, host]) => host === SETTINGS.host))
    now = service.machineView()
    assert.equal(now.connected, false)
    assert.equal(now.pulling, null)
    assert.equal(now.saved.host, SETTINGS.host, 'l’adresse reste pré-remplie')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('pendant un test de modèles, ni connexion ni déconnexion ; pendant des duels sur ce PC, pas de connexion', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ models: [] }) })
  try {
    const { service } = loadService({ installed: ['qwen3.5:2b', 'qwen3.5:9b', 'qwen3-vl:8b'] })
    let busy = 'test'
    service.setMachineBusySource(() => busy)
    await assert.rejects(service.connectMachine(SETTINGS), /test de modèles est en cours/)
    busy = 'duel'
    await assert.rejects(service.connectMachine(SETTINGS), /session de duels/)
    busy = null
    assert.equal((await service.connectMachine(SETTINGS)).connected, true)
    busy = 'test'
    assert.throws(() => service.disconnectMachine(), /test de modèles est en cours/)
    busy = 'duel'
    assert.equal(service.disconnectMachine().connected, false, 'une session sur la machine garde sa machine : déconnecter reste possible')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('le script de test lit la machine louée : sa carte, sa mémoire, son disque, et s’y rattache dans les traces', async () => {
  const { readFileSync } = await import('node:fs')
  const script = readFileSync(new URL('./benchmark-models.mjs', import.meta.url), 'utf8')
  assert.match(script, /async function detectVramGb\(\) \{\s*if \(MACHINE\) return machineNumber\('JARIS_MACHINE_VRAM_GB'\)/)
  assert.match(script, /function detectRamGb\(\) \{\s*if \(MACHINE\) return machineNumber\('JARIS_MACHINE_RAM_GB'\)/)
  assert.match(script, /function detectFreeDiskGb\(\) \{\s*if \(MACHINE\) return machineFreeDiskGb/)
  // La place libre est relue avant CHAQUE téléchargement (le disque se remplit au fil du test) et au départ.
  assert.match(script, /console\.log\(`Téléchargement de \$\{model\}…`\)\s*await refreshMachineFreeDisk\(\)/)
  assert.match(script, /await refreshMachineFreeDisk\(\)\s*const freeDiskGbAtStart = detectFreeDiskGb\(\)/)
  assert.match(script, /rented: MACHINE/)
})

// Relecture adverse de l'étape 437 : les cas limites qu'elle a trouvés.
test('un test lancé PENDANT la connexion (attente de la machine) garde sa machine : la connexion est refusée', async () => {
  let busy = null
  const { service, config } = loadService({ onVersion: () => { busy = 'test' } })
  service.setMachineBusySource(() => busy)
  const local = config.config.ollama.host
  const view = await service.connectMachine(SETTINGS)
  assert.equal(view.connected, false)
  assert.match(view.error, /test de modèles est en cours/)
  assert.equal(config.config.ollama.host, local)
})

test('une connexion ratée vers une 2e machine laisse la 1re connectée, et ne remplace pas son adresse gardée', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ models: [] }) })
  try {
    let reachable = true
    const config = loadConfig()
    const patched = []
    const service = loadTsModule('electron/services/remoteMachine.ts', {
      '../config': config,
      '../../shared/machine': machine,
      '../../shared/duel': duel,
      './ollama': {
        fetchOllamaVersion: async () => {
          if (!reachable) throw new Error('ne répond pas')
          return '0.40.4'
        },
        listInstalledModels: async () => ['qwen3.5:9b'],
        pullModelIfMissing: async () => false
      },
      './profileStore': { getProfile: async () => ({ models: { flash: 'qwen3.5:9b' } }), patchProfile: async (c) => patched.push(c) }
    })
    service.setMachineModelSizeSource((model) => (model === 'qwen3.5:9b' ? 6.6 : undefined))
    await service.connectMachine(SETTINGS)
    // Étape 387 : un modèle qui tient sur la carte de la machine ne demande que 4 fils de calcul.
    assert.equal(config.config.ollama.threadsFor('qwen3.5:9b'), 4)
    reachable = false
    const view = await service.connectMachine({ ...SETTINGS, host: 'http://10.0.0.9:11434' })
    assert.equal(view.connected, true)
    assert.equal(view.version, '0.40.4')
    assert.match(view.error, /ne répond pas/)
    assert.equal(config.config.ollama.host, SETTINGS.host)
    assert.deepEqual(patched.map((c) => c.remoteMachine.host), [SETTINGS.host], 'la mauvaise adresse n’est pas gardée')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('une machine sans carte graphique (0 Go) est acceptée', () => {
  assert.equal(machine.parseRemoteMachine({ host: '1.2.3.4', vramGb: 0, ramGb: 64, diskGb: 100 }).vramGb, 0)
})
