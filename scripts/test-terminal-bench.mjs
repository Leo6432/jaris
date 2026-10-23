import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadTsModule } from './load-ts-module.mjs'

// Étape 349 : test Terminal-Bench 2.1 lancé depuis « Tous les modèles ». Les calculs sont testés tels quels ; le
// déroulé complet (installation de Harbor, téléchargement des tâches, une tâche après l'autre, reprise, arrêt,
// panne de Docker) tourne avec un faux Harbor et un faux Docker sur un vrai dossier.

const PYTHON_DIR = fileURLToPath(new URL('../python', import.meta.url))
const ipc = loadTsModule('shared/ipc.ts')
const TASKS = ipc.TERMINAL_BENCH_TASK_COUNT

function load(env) {
  const powerStopped = []
  return loadTsModule('electron/services/terminalBench.ts', {
    child_process: env.childProcess,
    crypto: { createHash: (...a) => cryptoModule.createHash(...a) },
    fs,
    'fs/promises': fs.promises,
    path: { join },
    electron: {
      powerSaveBlocker: {
        start: () => 7,
        stop: (id) => powerStopped.push(id),
        isStarted: (id) => !powerStopped.includes(id)
      }
    },
    '../config': { config: { ollama: { host: 'http://127.0.0.1:11435' } } },
    '../paths': { pythonScriptsDir: () => PYTHON_DIR },
    './dataLocation': { getDataRoot: () => env.root },
    './pythonRuntime': { resolvePythonBin: () => 'python', PIP_INSTALL: ['-m', 'pip', 'install', '--no-cache-dir'] },
    './ollama': {
      pullModelIfMissing: async (model) => env.pulled.push(model),
      fitToModelContext: async (_model, n) => n
    },
    './atomicFile': { writeFileAtomic: (p, d) => fs.promises.writeFile(p, d) },
    '../../shared/ipc': ipc
  })
}

const cryptoModule = await import('node:crypto')

/** Un faux processus : fermé tout de suite, ou seulement quand on le tue (`hang`). */
function fakeProcess(work, hang) {
  const proc = new EventEmitter()
  proc.stdout = Object.assign(new EventEmitter(), { setEncoding() {} })
  proc.stderr = Object.assign(new EventEmitter(), { setEncoding() {} })
  proc.killed = false
  proc.kill = () => {
    proc.killed = true
    setImmediate(() => proc.emit('close', null))
    return true
  }
  setImmediate(async () => {
    try {
      await work()
    } catch (err) {
      proc.stderr.emit('data', `${err.message}\n`)
      proc.emit('close', 1)
      return
    }
    if (!hang) proc.emit('close', 0)
  })
  return proc
}

function argAfter(args, flag) {
  const i = args.indexOf(flag)
  return i === -1 ? null : args[i + 1]
}

/**
 * Faux environnement : `trial(task, attempt)` décide du résultat d'un essai ({ reward, exception }).
 * `docker` : 'ready' | 'notInstalled' | 'notRunning' (modifiable en cours de test).
 */
function makeEnv({ trial = () => ({ reward: 1 }), hangTask = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jaris-tbench-'))
  const env = {
    root,
    docker: 'ready',
    pulled: [],
    spawns: [],
    execs: [],
    runs: [],
    ollamaUp: true
  }
  env.childProcess = {
    execFile(cmd, args, _opts, cb) {
      env.execs.push([cmd, ...args])
      setImmediate(() => {
        if (args[0] === 'info') {
          if (env.docker === 'ready') return cb(null, '27.0.0\n', '')
          const err = Object.assign(new Error('docker'), { code: env.docker === 'notInstalled' ? 'ENOENT' : 1 })
          return cb(err, '', 'Cannot connect to the Docker daemon')
        }
        if (args[0] === 'ps') return cb(null, 'abc123\n', '')
        cb(null, '', '')
      })
    },
    spawn(bin, args, opts) {
      env.spawns.push({ bin, args, env: opts.env })
      const libDir = opts.env.PYTHONPATH
      if (args.includes('pip')) {
        return fakeProcess(() => fs.promises.mkdir(join(argAfter(args, '--target'), 'harbor'), { recursive: true }))
      }
      if (args.includes('dataset')) {
        return fakeProcess(async () => {
          const dir = join(argAfter(args, '-o'), 'terminal-bench-2-1')
          for (let i = 0; i < TASKS; i++) {
            const task = `tache-${String(i).padStart(2, '0')}`
            await fs.promises.mkdir(join(dir, task), { recursive: true })
            await fs.promises.writeFile(
              join(dir, task, 'task.toml'),
              `[metadata]\nname = "${task}"\n\n[agent]\ntimeout_sec = ${i === 0 ? '9000.0' : '900.0'}\n\n[verifier]\ntimeout_sec = 600.0\n\n[environment]\ndocker_image = "registry/tb/${task}:1"\n`
            )
          }
        })
      }
      // harbor run
      const task = argAfter(args, '-i')
      const attempts = Number(argAfter(args, '-k'))
      const jobDir = join(argAfter(args, '-o'), argAfter(args, '--job-name'))
      env.runs.push({ task, args, libDir })
      return fakeProcess(async () => {
        await fs.promises.mkdir(jobDir, { recursive: true })
        await fs.promises.writeFile(join(jobDir, 'result.json'), '{"job": true}')
        if (task === hangTask) return
        for (let k = 0; k < attempts; k++) {
          const outcome = trial(task, k)
          const dir = join(jobDir, `${task}__t${k}`)
          await fs.promises.mkdir(dir, { recursive: true })
          await fs.promises.writeFile(
            join(dir, 'result.json'),
            JSON.stringify({
              task_name: task,
              verifier_result: outcome.reward === undefined ? null : { rewards: { reward: outcome.reward } },
              exception_info: outcome.exception ? { exception_type: outcome.exception, exception_message: 'x' } : null
            })
          )
        }
      }, task === hangTask)
    }
  }
  globalThis.fetch = async () => {
    if (!env.ollamaUp) throw new Error('fetch failed')
    return { ok: true, json: async () => ({ version: '0.40.10' }) }
  }
  return env
}

function waitForEnd(mod, ms = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('le test ne s’est jamais terminé')), ms)
    const off = mod.onTerminalBenchProgress((p) => {
      if (p.phase === 'done' || p.phase === 'stopped' || p.phase === 'error') {
        clearTimeout(timer)
        off()
        resolve(p)
      }
    })
  })
}

function readResults(root) {
  return JSON.parse(readFileSync(join(root, 'terminal-bench', 'results.json'), 'utf8'))
}

// ---------------------------------------------------------------------------------------------------------------

test('délai de l’agent porté à 2 h (ou plus long si la tâche le prévoit), jamais celui du correcteur', () => {
  const env = makeEnv()
  const mod = load(env)
  const toml = '[agent]\ntimeout_sec = 900.0\n\n[verifier]\ntimeout_sec = 600.0\n'
  assert.equal(mod.patchAgentTimeout(toml, 7200), '[agent]\ntimeout_sec = 7200.0\n\n[verifier]\ntimeout_sec = 600.0\n')
  assert.match(mod.patchAgentTimeout('[agent]\r\ntimeout_sec = 12000\r\n', 7200), /timeout_sec = 12000\.0/)
  assert.equal(mod.dockerImageOf('[environment]\ndocker_image = "a/b:1"\n'), 'a/b:1')
  assert.equal(mod.dockerImageOf('[environment]\n'), null)
})

test('options d’Artificial Analysis, et limite de mémoire bien rattachée au modèle par LiteLLM', () => {
  const env = makeEnv()
  const mod = load(env)
  const args = mod.harborRunArgs({
    tasksDir: '/t',
    task: 'fix-git',
    model: 'granite4.2:3b',
    attempts: 3,
    ollamaHost: 'http://127.0.0.1:11435',
    numCtx: 32768,
    jobsDir: '/j',
    jobName: 'job'
  })
  const kw = Object.fromEntries(
    args.flatMap((a, i) => (args[i - 1] === '--ak' ? [a.split(/=(.*)/s).slice(0, 2)] : []))
  )
  assert.equal(argAfter(args, '-a'), 'terminus-2')
  assert.equal(argAfter(args, '-m'), 'ollama_chat/granite4.2:3b')
  assert.equal(argAfter(args, '-k'), '3')
  assert.equal(argAfter(args, '-n'), '1')
  assert.equal(kw.temperature, '0.6')
  assert.equal(kw.max_turns, '250')
  assert.equal(kw.api_base, 'http://127.0.0.1:11435')
  assert.deepEqual(JSON.parse(kw.llm_call_kwargs), { num_ctx: 32768 })
  const info = JSON.parse(kw.model_info)
  assert.equal(info.max_input_tokens, 32768)
  // Sans lui, LiteLLM ignore ces chiffres et prend une limite d'un million de tokens (vérifié avec Harbor).
  assert.equal(info.litellm_provider, 'ollama_chat')
  assert.equal(mod.jobNameFor('hf.co/a/b:Q4_K_M', 'fix-git', 3), 'hf.co_a_b_Q4_K_M__3x__fix-git')
})

test('seul le temps de l’agent dépassé compte contre le modèle', () => {
  const mod = load(makeEnv())
  assert.equal(mod.isModelFailure(null), true)
  assert.equal(mod.isModelFailure('AgentTimeoutError'), true)
  for (const e of ['EnvironmentStartTimeoutError', 'AgentSetupTimeoutError', 'VerifierTimeoutError', 'DockerError']) {
    assert.equal(mod.isModelFailure(e), false, e)
  }
})

test('score et temps restant', () => {
  const mod = load(makeEnv())
  const run = {
    model: 'm',
    attempts: 3,
    startedAt: '',
    finishedAt: null,
    seconds: 0,
    tasks: { a: { passed: 3, trials: 3, seconds: 600 }, b: { passed: 0, trials: 3, seconds: 1200 } }
  }
  assert.deepEqual(mod.scoreOf(run), { passed: 3, trials: 6, percent: 50 })
  // Moyenne 15 min, 87 tâches restantes.
  assert.equal(mod.remainingMs(run, 89), 87 * 900_000)
  // La tâche en cours depuis 5 min est déjà entamée.
  assert.equal(mod.remainingMs(run, 89, 300_000), 87 * 900_000 - 300_000)
  // Jamais un chiffre inventé avant la première tâche.
  assert.equal(mod.remainingMs({ ...run, tasks: {} }, 89), null)
})

test('déroulé complet : Harbor installé avec les versions figées, 89 tâches, score enregistré', async () => {
  const env = makeEnv({ trial: (task, k) => ({ reward: Number(task.slice(-2)) % 2 === 0 || k === 0 ? 1 : 0 }) })
  try {
    const mod = load(env)
    const end = waitForEnd(mod)
    mod.startTerminalBench('granite4.2:3b', 3)
    const last = await end
    assert.equal(last.phase, 'done', last.error ?? '')

    const pip = env.spawns.find((s) => s.args.includes('pip'))
    assert.ok(pip.args.includes('harbor==0.24.0'))
    assert.equal(argAfter(pip.args, '-c'), join(PYTHON_DIR, 'terminal-bench-constraints.txt'))
    assert.ok(readFileSync(join(PYTHON_DIR, 'terminal-bench-constraints.txt'), 'utf8').includes('harbor==0.24.0'))
    // Sortie en UTF-8 même sous un Windows en cp1252, Harbor lu depuis ses fichiers.
    assert.equal(pip.env.PYTHONIOENCODING, 'utf-8')
    assert.equal(env.runs[0].libDir, join(env.root, 'terminal-bench', 'harbor'))

    assert.equal(env.runs.length, TASKS)
    assert.deepEqual(env.pulled, ['granite4.2:3b'])
    const tasksDir = join(env.root, 'terminal-bench', 'tasks', 'terminal-bench-2-1')
    assert.match(readFileSync(join(tasksDir, 'tache-01', 'task.toml'), 'utf8'), /\[agent\]\ntimeout_sec = 7200\.0/)
    assert.match(readFileSync(join(tasksDir, 'tache-00', 'task.toml'), 'utf8'), /\[agent\]\ntimeout_sec = 9000\.0/)
    assert.match(readFileSync(join(tasksDir, 'tache-01', 'task.toml'), 'utf8'), /\[verifier\]\ntimeout_sec = 600\.0/)

    const run = readResults(env.root).runs['granite4.2:3b|3']
    assert.ok(run.finishedAt)
    assert.equal(Object.keys(run.tasks).length, TASKS)
    // 45 tâches paires réussies 3 fois, 44 impaires réussies une fois sur trois.
    assert.deepEqual(mod.scoreOf(run), { passed: 45 * 3 + 44, trials: TASKS * 3, percent: ((45 * 3 + 44) / 267) * 100 })
    assert.equal(last.passed, 45 * 3 + 44)
    assert.equal(last.remainingMs, 0)
    // Chaque image de tâche est effacée après la tâche (89 images ne tiendraient pas sur le disque).
    assert.equal(env.execs.filter((e) => e[1] === 'image' && e[2] === 'rm').length, TASKS)

    // Deuxième lancement : rien n'est réinstallé ni retéléchargé, et un test fini ne refait aucune tâche.
    const spawnsBefore = env.spawns.length
    const mod2 = load(env)
    const end2 = waitForEnd(mod2)
    mod2.startTerminalBench('granite4.2:3b', 3)
    assert.equal((await end2).phase, 'done')
    assert.equal(env.spawns.length, spawnsBefore)
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})

test('reprise : seules les tâches pas encore faites sont lancées', async () => {
  const env = makeEnv()
  try {
    const mod = load(env)
    const end = waitForEnd(mod)
    mod.startTerminalBench('granite4.2:3b', 1)
    await end
    // On efface 5 tâches du résultat, comme si Jaris avait été fermé avant elles.
    const results = readResults(env.root)
    const run = results.runs['granite4.2:3b|1']
    for (const t of ['tache-10', 'tache-11', 'tache-12', 'tache-13', 'tache-14']) delete run.tasks[t]
    run.finishedAt = null
    fs.writeFileSync(join(env.root, 'terminal-bench', 'results.json'), JSON.stringify(results))
    env.runs = []

    const mod2 = load(env)
    const end2 = waitForEnd(mod2)
    mod2.startTerminalBench('granite4.2:3b', 1)
    assert.equal((await end2).phase, 'done')
    assert.deepEqual(
      env.runs.map((r) => r.task),
      ['tache-10', 'tache-11', 'tache-12', 'tache-13', 'tache-14']
    )
    assert.ok(readResults(env.root).runs['granite4.2:3b|1'].finishedAt)
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})

test('Harbor réinstallé quand les versions figées changent', async () => {
  const env = makeEnv()
  try {
    const harbor = join(env.root, 'terminal-bench', 'harbor')
    fs.mkdirSync(join(harbor, 'harbor'), { recursive: true })
    // Ancienne marque : version seule, sans l'empreinte des versions figées.
    fs.writeFileSync(join(harbor, '.jaris-harbor-version'), '0.24.0')
    const mod = load(env)
    const end = waitForEnd(mod)
    mod.startTerminalBench('granite4.2:3b', 1)
    assert.equal((await end).phase, 'done')
    assert.equal(env.spawns.filter((s) => s.args.includes('pip')).length, 1)
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})

test('Docker absent : rien n’est lancé, la carte dit quoi faire', async () => {
  const env = makeEnv()
  env.docker = 'notInstalled'
  try {
    const mod = load(env)
    const end = waitForEnd(mod)
    mod.startTerminalBench('granite4.2:3b', 3)
    const last = await end
    assert.equal(last.phase, 'error')
    assert.match(last.error, /Docker/)
    assert.equal(env.spawns.length, 0)
    assert.equal((await mod.getTerminalBenchStatus()).docker, 'notInstalled')
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})

test('panne de la machine : la tâche n’est jamais comptée contre le modèle', async () => {
  const env = makeEnv({
    trial: (task) => {
      if (task === 'tache-03') {
        env.docker = 'notRunning'
        return { exception: 'EnvironmentStartTimeoutError' }
      }
      return { reward: 1 }
    }
  })
  try {
    const mod = load(env)
    const end = waitForEnd(mod)
    mod.startTerminalBench('granite4.2:3b', 1)
    const last = await end
    assert.equal(last.phase, 'error')
    assert.match(last.error, /tache-03/)
    const run = readResults(env.root).runs['granite4.2:3b|1']
    assert.deepEqual(Object.keys(run.tasks), ['tache-00', 'tache-01', 'tache-02'])
    assert.equal(run.finishedAt, null)
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})

test('temps dépassé par l’agent : compté comme un échec, sans arrêter le test', async () => {
  const env = makeEnv({ trial: (task) => (task === 'tache-03' ? { exception: 'AgentTimeoutError' } : { reward: 1 }) })
  try {
    const mod = load(env)
    const end = waitForEnd(mod)
    mod.startTerminalBench('granite4.2:3b', 1)
    assert.equal((await end).phase, 'done')
    const run = readResults(env.root).runs['granite4.2:3b|1']
    assert.deepEqual(run.tasks['tache-03'], { ...run.tasks['tache-03'], passed: 0, trials: 1 })
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})

test('« Arrêter » : la tâche en cours n’est pas enregistrée et ses conteneurs sont retirés', async () => {
  const env = makeEnv({ hangTask: 'tache-02' })
  try {
    const mod = load(env)
    const end = waitForEnd(mod)
    mod.startTerminalBench('granite4.2:3b', 3)
    assert.throws(() => mod.startTerminalBench('granite4.2:3b', 3), /cours/)
    for (let i = 0; i < 400 && !env.runs.some((r) => r.task === 'tache-02'); i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.ok(env.runs.some((r) => r.task === 'tache-02'), 'la tâche bloquée n’a jamais démarré')
    await mod.stopTerminalBench()
    const last = await end
    assert.equal(last.phase, 'stopped')
    const run = readResults(env.root).runs['granite4.2:3b|3']
    assert.deepEqual(Object.keys(run.tasks), ['tache-00', 'tache-01'])
    assert.ok(env.execs.some((e) => e[1] === 'rm' && e.includes('abc123')))
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})

test('seuls 1 ou 3 essais sont acceptés', () => {
  const mod = load(makeEnv())
  assert.throws(() => mod.startTerminalBench('granite4.2:3b', 2))
})

test('les versions figées de Harbor sont bien livrées avec Jaris (electron-builder ne signale pas un oubli)', () => {
  const yml = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const python = yml.slice(yml.indexOf('  - from: python'), yml.indexOf('  - from:', yml.indexOf('  - from: python') + 5))
  assert.match(python, /^\s+- terminal-bench-constraints\.txt$/m)
})
