import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * electron/services/legacyCleanup.ts (étape 200) : le Montage est retiré, son paquet Remotion (~600 Mo) est
 * effacé au démarrage — y compris sur l'autre disque s'il avait été déplacé (jonction) —, sans jamais toucher
 * aux vidéos de Léo ni suivre une jonction qui pointerait ailleurs. Sur un VRAI dossier temporaire.
 */
const require = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('../electron/services/legacyCleanup.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const module = { exports: {} }
vm.runInThisContext(`(function (exports, require, module, process) { ${source} })`)(module.exports, require, module, process)
const { removeLeftoverMontage, leftoverMontageDir, removeLeftoverVideoDuel, removeLeftoverTerminalBench } = module.exports

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'jaris-legacy-'))
  return { root, done: () => rmSync(root, { recursive: true, force: true }) }
}

test('le paquet du Montage est effacé, les vidéos de Léo restent', async () => {
  const { root, done } = sandbox()
  try {
    const dir = leftoverMontageDir(join(root, 'Local'))
    mkdirSync(join(dir, 'node_modules', 'remotion'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'remotion', 'package.json'), '{}')
    const videos = join(root, 'Donnees', 'generated-videos')
    mkdirSync(videos, { recursive: true })
    writeFileSync(join(videos, 'vacances.mp4'), 'video')
    assert.equal(await removeLeftoverMontage(dir), true)
    assert.equal(existsSync(dir), false)
    assert.equal(existsSync(join(videos, 'vacances.mp4')), true)
  } finally {
    done()
  }
})

test('déplacé sur un autre disque : la jonction ET son vrai dossier partent', async () => {
  const { root, done } = sandbox()
  try {
    const moved = join(root, 'D', 'Jaris', 'montage')
    mkdirSync(join(moved, 'node_modules'), { recursive: true })
    writeFileSync(join(moved, 'node_modules', 'gros.bin'), 'x')
    const dir = leftoverMontageDir(join(root, 'Local'))
    mkdirSync(join(dir, '..'), { recursive: true })
    symlinkSync(moved, dir, 'junction')
    assert.equal(await removeLeftoverMontage(dir), true)
    assert.equal(existsSync(dir), false)
    assert.equal(existsSync(moved), false)
  } finally {
    done()
  }
})

test('une jonction qui pointe AILLEURS qu’un dossier « montage » n’est jamais suivie', async () => {
  const { root, done } = sandbox()
  try {
    const precious = join(root, 'D', 'Photos')
    mkdirSync(precious, { recursive: true })
    writeFileSync(join(precious, 'souvenir.jpg'), 'x')
    const dir = leftoverMontageDir(join(root, 'Local'))
    mkdirSync(join(dir, '..'), { recursive: true })
    symlinkSync(precious, dir, 'junction')
    await removeLeftoverMontage(dir)
    assert.equal(existsSync(join(precious, 'souvenir.jpg')), true)
  } finally {
    done()
  }
})

test('rien d’installé : aucune erreur', async () => {
  const { root, done } = sandbox()
  try {
    assert.equal(await removeLeftoverMontage(leftoverMontageDir(join(root, 'Local'))), false)
  } finally {
    done()
  }
})

test('duel vidéo retiré (étape 258) : Python et Kandinsky effacés, les vidéos et le choix de Léo restent', async () => {
  const { root, done } = sandbox()
  try {
    const duel = join(root, 'moteur', 'video-duel')
    for (const part of ['python/Lib', 'kandinsky6-lite/transformer', '.temp']) mkdirSync(join(duel, part), { recursive: true })
    writeFileSync(join(duel, 'kandinsky6-lite', 'transformer', 'poids.safetensors'), 'x')
    mkdirSync(join(duel, 'resultats'), { recursive: true })
    writeFileSync(join(duel, 'resultats', 'resultats.json'), '{}')
    writeFileSync(join(duel, 'resultats', 'fastwan-chat.webm'), 'video')
    assert.equal(await removeLeftoverVideoDuel(duel), true)
    for (const part of ['python', 'kandinsky6-lite', '.temp']) assert.equal(existsSync(join(duel, part)), false, part)
    assert.equal(existsSync(join(duel, 'resultats', 'resultats.json')), true)
    assert.equal(existsSync(join(duel, 'resultats', 'fastwan-chat.webm')), true)
    // Deuxième démarrage : plus rien à effacer, aucune erreur.
    assert.equal(await removeLeftoverVideoDuel(duel), false)
    // Duel jamais lancé : rien ne se passe.
    assert.equal(await removeLeftoverVideoDuel(join(root, 'absent')), false)
  } finally {
    done()
  }
})

/** Un faux Docker qui journalise ses commandes ; `state` : 'ready', 'stopped' ou 'absent'. */
function fakeDocker(state, { containers = [], images = [] } = {}) {
  const calls = []
  const run = async (args) => {
    calls.push(args.join(' '))
    if (state === 'absent') throw new Error('docker introuvable')
    if (args[0] === '--version') return 'Docker version 29.0.0'
    if (state === 'stopped') throw new Error('Cannot connect to the Docker daemon')
    if (args[0] === 'info') return '29.0.0'
    if (args[0] === 'ps') return containers.map(([id, image]) => `${id} ${image}`).join('\n')
    if (args[0] === 'images') return images.join('\n')
    return ''
  }
  return { run, calls }
}

function terminalBenchLeftovers(root) {
  const dir = join(root, 'terminal-bench')
  mkdirSync(join(dir, 'harbor', 'harbor'), { recursive: true })
  writeFileSync(join(dir, 'harbor', 'harbor', '__init__.py'), '')
  for (const [task, image] of [['fix-git', 'alexgshaw/fix-git:20251031'], ['pypi-server', 'alexgshaw/pypi-server']]) {
    mkdirSync(join(dir, 'tasks', 'terminal-bench-2-1', task), { recursive: true })
    writeFileSync(join(dir, 'tasks', 'terminal-bench-2-1', task, 'task.toml'), `[environment]\ndocker_image = "${image}"\n`)
  }
  mkdirSync(join(dir, 'jobs', 'essai-1'), { recursive: true })
  writeFileSync(join(dir, 'jobs', 'essai-1', 'trial.log'), 'log')
  mkdirSync(join(dir, '.temp'), { recursive: true })
  writeFileSync(join(dir, 'results.json'), '{"runs":{}}')
  return dir
}

test('test Terminal-Bench retiré (étape 353) : Harbor, tâches et journaux effacés, ses images Docker seulement, les résultats restent', async () => {
  const { root, done } = sandbox()
  try {
    const dir = terminalBenchLeftovers(root)
    const docker = fakeDocker('ready', {
      containers: [['c1', 'alexgshaw/fix-git:20251031'], ['c2', 'postgres:16'], ['c3', 'alexgshaw/pypi-server:latest']],
      images: ['alexgshaw/fix-git:20251031', 'postgres:16', 'alexgshaw/pypi-server:latest']
    })
    assert.equal(await removeLeftoverTerminalBench(root, docker.run), true)
    for (const part of ['harbor', 'tasks', 'jobs', '.temp']) assert.equal(existsSync(join(dir, part)), false, part)
    assert.equal(readFileSync(join(dir, 'results.json'), 'utf8'), '{"runs":{}}')
    // Seuls les conteneurs et images des tâches du test, même une image donnée sans version (« :latest »).
    assert.ok(docker.calls.includes('rm -f c1 c3'), docker.calls.join(' | '))
    assert.ok(docker.calls.includes('image rm -f alexgshaw/fix-git:20251031'))
    assert.ok(docker.calls.includes('image rm -f alexgshaw/pypi-server:latest'))
    assert.ok(!docker.calls.some((c) => c.includes('postgres') || c.includes('c2')), 'une autre image ou un autre conteneur touché')
    // Deuxième démarrage : plus aucune tâche, donc plus aucune commande Docker, et aucune erreur.
    const again = fakeDocker('ready')
    assert.equal(await removeLeftoverTerminalBench(root, again.run), true)
    assert.deepEqual(again.calls.length, 0)
  } finally {
    done()
  }
})

test('Docker arrêté : les tâches (qui donnent les noms des images) restent pour le prochain démarrage, le reste part', async () => {
  const { root, done } = sandbox()
  try {
    const dir = terminalBenchLeftovers(root)
    assert.equal(await removeLeftoverTerminalBench(root, fakeDocker('stopped').run), false)
    assert.equal(existsSync(join(dir, 'tasks', 'terminal-bench-2-1', 'fix-git', 'task.toml')), true)
    for (const part of ['harbor', 'jobs', '.temp']) assert.equal(existsSync(join(dir, part)), false, part)
    // Docker relancé au démarrage suivant : les images partent, puis les tâches.
    const docker = fakeDocker('ready', { images: ['alexgshaw/fix-git:20251031'] })
    assert.equal(await removeLeftoverTerminalBench(root, docker.run), true)
    assert.ok(docker.calls.includes('image rm -f alexgshaw/fix-git:20251031'))
    assert.equal(existsSync(join(dir, 'tasks')), false)
    assert.equal(existsSync(join(dir, 'results.json')), true)
  } finally {
    done()
  }
})

test('pas de Docker du tout, ou test jamais lancé : tout part sans erreur, ou rien ne se passe', async () => {
  const { root, done } = sandbox()
  try {
    const dir = terminalBenchLeftovers(root)
    assert.equal(await removeLeftoverTerminalBench(root, fakeDocker('absent').run), true)
    assert.equal(existsSync(join(dir, 'tasks')), false)
    assert.equal(existsSync(join(dir, 'results.json')), true)
    assert.equal(await removeLeftoverTerminalBench(join(root, 'absent'), fakeDocker('ready').run), false)
  } finally {
    done()
  }
})
