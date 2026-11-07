import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 437 (Léo : « un bouton Machine à gauche… tout Jaris tourne sur le VPS, si je vais dans Analyse et que je lance,
 * ça se fait sur le VPS, et après je peux déconnecter »). Ce qui est vérifié ici : où partent VRAIMENT les demandes aux
 * modèles (ce PC sauf portée explicite), la connexion qui ne bascule jamais vers une adresse muette, et les gardes.
 * Étape 439 (Léo : « pour pas que ça installe des modèles dès qu'on met la machine, il met que quand il fait duel
 * classement, pas direct ») : connecter ne télécharge RIEN et ne déplace ni Chat, ni Vocal, ni Code.
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

test('l’adresse des modèles : ce PC, sauf dans une portée explicite (Duel, Analyse)', async () => {
  const config = loadConfig()
  const local = config.config.ollama.host
  assert.equal(config.config.ollama.remote, false)
  assert.equal(config.setMachineOllamaHost, undefined, 'plus de bascule de tout Jaris vers la machine')
  assert.equal(await config.runWithOllamaHost('https://machine.example', async () => config.config.ollama.host), 'https://machine.example')
  assert.equal(await config.runWithOllamaHost('https://machine.example', async () => config.config.ollama.remote), true)
  assert.equal(
    await config.runWithOllamaHost('https://machine.example', () => config.runWithLocalOllama(async () => config.config.ollama.host)),
    local,
    'les outils d’un duel restent sur ce PC'
  )
  assert.equal(config.config.ollama.localHost, local)
  assert.equal(config.config.ollama.host, local, 'hors portée : ce PC')
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

function loadService({ reachable = true, onVersion = null } = {}) {
  const config = loadConfig()
  const calls = { pulls: [], versions: [], patched: [] }
  const ollama = {
    fetchOllamaVersion: async () => {
      calls.versions.push(config.config.ollama.host)
      onVersion?.()
      if (!reachable) throw new Error('La machine des modèles ne répond pas.')
      return '0.40.4'
    },
    // Ne doit JAMAIS servir (étape 439) : gardé pour prouver qu'aucun téléchargement ne part à la connexion.
    pullModelIfMissing: async (model) => {
      calls.pulls.push(model)
      return true
    }
  }
  const profile = { models: { flash: 'qwen3.5:2b', medium: 'qwen3.5:9b', large: 'qwen3.5:9b' }, visionModel: 'qwen3-vl:8b' }
  const service = loadTsModule('electron/services/remoteMachine.ts', {
    '../config': config,
    '../../shared/machine': machine,
    '../../shared/duel': duel,
    './ollama': ollama,
    './profileStore': { getProfile: async () => profile, patchProfile: async (change) => calls.patched.push(change) }
  })
  return { service, config, calls }
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

test('connecter : rien n’est téléchargé, Chat/Vocal/Code restent sur ce PC, la place libre s’affiche', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ models: [{ size: 6 * 1024 ** 3 }] }) })
  try {
    const { service, config, calls } = loadService()
    const local = config.config.ollama.host
    const view = await service.connectMachine(SETTINGS)
    assert.equal(view.connected, true)
    assert.equal(view.version, '0.40.4')
    assert.equal(config.config.ollama.host, local, 'Chat, Vocal et Code restent sur ce PC')
    assert.equal(service.connectedMachine().host, SETTINGS.host, 'le Duel et l’Analyse la trouvent ici')
    assert.deepEqual(calls.patched.map((c) => c.remoteMachine.host), [SETTINGS.host], 'l’adresse est gardée pour la prochaine fois')
    await tick()
    await tick()
    let now = service.machineView()
    assert.equal(now.freeDiskGb, 84, '100 Go − 10 réservés − 6 de modèles')
    assert.deepEqual(calls.pulls, [], 'aucun modèle téléchargé à la connexion')
    assert.equal('models' in now, false)
    assert.equal('pulling' in now, false)
    service.disconnectMachine()
    now = service.machineView()
    assert.equal(now.connected, false)
    assert.equal(service.connectedMachine(), null)
    assert.equal(now.saved.host, SETTINGS.host, 'l’adresse reste pré-remplie')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('pendant un test de modèles, ni connexion ni déconnexion', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ models: [] }) })
  try {
    const { service } = loadService()
    let busy = 'test'
    service.setMachineBusySource(() => busy)
    await assert.rejects(service.connectMachine(SETTINGS), /test de modèles est en cours/)
    busy = null
    assert.equal((await service.connectMachine(SETTINGS)).connected, true)
    busy = 'test'
    assert.throws(() => service.disconnectMachine(), /test de modèles est en cours/)
    busy = null
    assert.equal(service.disconnectMachine().connected, false)
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
  // Le registre des modèles téléchargés par le test : à part pour la machine, et seulement pour CETTE machine.
  assert.match(script, /return new Set\(saved\?\.machine === MACHINE && Array\.isArray\(saved\.models\) \? saved\.models : \[\]\)/)
  assert.match(script, /if \(MACHINE\) writeFileSync\(machineLedgerPath, JSON\.stringify\(\{ machine: MACHINE, models: \[\.\.\.downloadedByTest\] \}\)/)
})

// Relecture adverse de l'étape 437 : les cas limites qu'elle a trouvés.
test('un test lancé PENDANT la connexion (attente de la machine) garde sa machine : la connexion est refusée', async () => {
  let busy = null
  const { service, config } = loadService({ onVersion: () => { busy = 'test' } })
  service.setMachineBusySource(() => busy)
  const view = await service.connectMachine(SETTINGS)
  assert.equal(view.connected, false)
  assert.match(view.error, /test de modèles est en cours/)
  assert.equal(service.connectedMachine(), null)
  void config
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
      './ollama': {
        fetchOllamaVersion: async () => {
          if (!reachable) throw new Error('ne répond pas')
          return '0.40.4'
        }
      },
      './profileStore': { getProfile: async () => ({ models: { flash: 'qwen3.5:9b' } }), patchProfile: async (c) => patched.push(c) }
    })
    await service.connectMachine(SETTINGS)
    reachable = false
    const view = await service.connectMachine({ ...SETTINGS, host: 'http://10.0.0.9:11434' })
    assert.equal(view.connected, true)
    assert.equal(view.version, '0.40.4')
    assert.match(view.error, /ne répond pas/)
    assert.equal(service.connectedMachine().host, SETTINGS.host)
    assert.deepEqual(patched.map((c) => c.remoteMachine.host), [SETTINGS.host], 'la mauvaise adresse n’est pas gardée')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('une machine sans carte graphique (0 Go) est acceptée', () => {
  assert.equal(machine.parseRemoteMachine({ host: '1.2.3.4', vramGb: 0, ramGb: 64, diskGb: 100 }).vramGb, 0)
})
