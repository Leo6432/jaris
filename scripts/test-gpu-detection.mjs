import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { promisify } from 'node:util'
import ts from 'typescript'

/**
 * Étape 208 (PC d'un ami de Léo : AMD Radeon RX 7600, 8 Go — Jaris disait « aucune carte graphique NVIDIA
 * détectée »). Sans nvidia-smi, la mémoire de la carte est lue dans le registre Windows (toutes marques).
 *
 * Vérifié ici : la lecture de la sortie (une carte ou plusieurs, carte intégrée ignorée), le repli qui ne se
 * déclenche que sans nvidia-smi, et — quand un PowerShell est disponible — le VRAI script, exécuté avec une
 * lecture du registre simulée (le registre n'existe que sous Windows). Sur le runner Windows de la CI, c'est
 * Windows PowerShell 5.1 qui l'exécute : le même que chez Léo. Non vérifiable ici : la valeur réellement écrite
 * par le pilote AMD sur la machine de l'ami.
 */
const nodeRequire = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('../electron/services/hardwareScan.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

function load({ platform = 'win32', nvidia = null, registry = null } = {}) {
  const commands = []
  const run = async (cmd) => {
    commands.push(cmd)
    if (cmd.startsWith('nvidia-smi')) {
      if (nvidia === null) throw new Error("'nvidia-smi' n'est pas reconnu")
      return { stdout: nvidia, stderr: '' }
    }
    if (cmd.startsWith('powershell')) {
      if (registry === null) throw new Error('powershell absent')
      return { stdout: registry, stderr: '' }
    }
    throw new Error(`commande inattendue : ${cmd}`)
  }
  // Même marque que le vrai exec de Node : sans elle, promisify changerait de forme de résultat (étape 114).
  const exec = (cmd, opts, cb) => run(cmd).then((r) => cb(null, r.stdout, r.stderr), (e) => cb(e))
  exec[promisify.custom] = (cmd) => run(cmd)
  const modules = {
    child_process: { exec },
    '../paths': { resourcesRoot: () => '/fake/resources' },
    './dataLocation': { getDataRoot: () => '/fake/data' },
    './systemResources': { RESOURCE_SAFETY_MARGIN_GB: 4, detectRamGb: () => 16 },
    './ollama': { getModelInfo: async () => null, getInstalledModelSizeBytes: async () => null, listInstalledModels: async () => [] }
  }
  const module = { exports: {} }
  vm.runInThisContext(`(function (exports, module, require, process) { ${source} })`)(
    module.exports,
    module,
    (name) => modules[name] ?? nodeRequire(name),
    { ...process, platform }
  )
  return { scan: module.exports, commands }
}

const AMD = '{"name":"AMD Radeon RX 7600","bytes":8589934592.0}'

test('une seule carte (objet seul, comme PowerShell 5.1) ou plusieurs : la plus grosse gagne', () => {
  const { scan } = load()
  assert.deepEqual({ ...scan.parseRegistryGpus(AMD) }, { name: 'AMD Radeon RX 7600', vramGb: 8 })
  const both = '[{"name":"Intel(R) UHD Graphics","bytes":134217728.0},{"name":"AMD Radeon RX 7600","bytes":8589934592.0}]'
  assert.deepEqual({ ...scan.parseRegistryGpus(both) }, { name: 'AMD Radeon RX 7600', vramGb: 8 })
})

test('carte intégrée seule, sortie vide ou illisible : « pas de carte », jamais une valeur inventée', () => {
  const { scan } = load()
  for (const out of ['{"name":"Intel(R) UHD Graphics","bytes":134217728.0}', '', 'Get-ItemProperty : erreur', '[]', '{"name":"X","bytes":"8 Go"}']) {
    assert.deepEqual({ ...scan.parseRegistryGpus(out) }, { name: null, vramGb: null }, out)
  }
})

test('AMD sous Windows : nvidia-smi absent → la carte est lue dans le registre (8 Go)', async () => {
  const { scan, commands } = load({ registry: AMD })
  assert.deepEqual({ ...(await scan.detectGpu()) }, { name: 'AMD Radeon RX 7600', vramGb: 8 })
  assert.ok(commands[1].includes('-EncodedCommand'), 'script passé encodé, rien à échapper')
})

test('NVIDIA : nvidia-smi répond, le registre n’est jamais interrogé (comportement inchangé)', async () => {
  const { scan, commands } = load({ nvidia: 'NVIDIA GeForce RTX 3070, 8192\n', registry: AMD })
  assert.deepEqual({ ...(await scan.detectGpu()) }, { name: 'NVIDIA GeForce RTX 3070', vramGb: 8 })
  assert.equal(commands.length, 1)
})

test('hors Windows, ou si PowerShell échoue : « pas de carte », sans erreur', async () => {
  assert.deepEqual({ ...(await load({ platform: 'linux', registry: AMD }).scan.detectGpu()) }, { name: null, vramGb: null })
  assert.deepEqual({ ...(await load().scan.detectGpu()) }, { name: null, vramGb: null })
})

test('les messages ne parlent plus de « NVIDIA » : une AMD ou une Intel compte aussi', () => {
  for (const file of ['shared/videoModel.ts', 'shared/imageModel.ts']) {
    assert.doesNotMatch(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /carte graphique NVIDIA détectée/, file)
  }
})

// Le vrai script, exécuté par un vrai PowerShell (Windows PowerShell 5.1 sur la CI) avec un registre simulé.
const powershell = process.platform === 'win32' ? 'powershell' : ['/tmp/pwsh/pwsh', process.env.PWSH].find((p) => p && existsSync(p))

test('le vrai script PowerShell : syntaxe, octets convertis, objet seul ou tableau', { skip: powershell ? false : 'PowerShell indisponible ici' }, () => {
  const { scan } = load()
  const dir = mkdtempSync(join(tmpdir(), 'jaris-gpu-'))
  try {
    const run = (fake) => {
      const file = join(dir, 't.ps1')
      writeFileSync(file, `function Get-ItemProperty { param($Path) ${fake} }\n${scan.REGISTRY_GPU_SCRIPT}`)
      return execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8' })
    }
    const amd = `[pscustomobject]@{ DriverDesc = 'AMD Radeon RX 7600'; 'HardwareInformation.qwMemorySize' = [uint64]8589934592 }`
    const intelBytes = `[pscustomobject]@{ DriverDesc = 'Intel(R) UHD Graphics'; 'HardwareInformation.qwMemorySize' = [byte[]][BitConverter]::GetBytes([uint64]134217728) }`
    const noMemory = `[pscustomobject]@{ DriverDesc = 'Microsoft Basic Display Adapter' }`
    assert.deepEqual({ ...scan.parseRegistryGpus(run(amd)) }, { name: 'AMD Radeon RX 7600', vramGb: 8 })
    assert.deepEqual({ ...scan.parseRegistryGpus(run(`${intelBytes}; ${amd}; ${noMemory}`)) }, { name: 'AMD Radeon RX 7600', vramGb: 8 })
    assert.deepEqual({ ...scan.parseRegistryGpus(run(intelBytes)) }, { name: null, vramGb: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
