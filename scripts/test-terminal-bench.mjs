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
// Les mêmes paliers que le curseur de mémoire d'Options, relus dans hardwareScan.ts (trop lourd à charger ici).
const STEPS = JSON.parse(
  `[${/export const CONTEXT_LENGTH_STEPS = \[([^\]]+)\]/.exec(readFileSync(new URL('../electron/services/hardwareScan.ts', import.meta.url), 'utf8'))[1]}]`
)
const GB = 1024 ** 3

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
      fitToModelContext: async (_model, n) => (env.native !== null && env.native < n ? env.native : n),
      modelNativeContext: async () => env.native,
      loadedOllamaModels: async () => (env.loaded ? [{ model: env.loaded.model, vramGb: 5 }] : []),
      unloadOllamaModels: async () => {
        env.unloads++
        env.loaded = null
        return []
      },
      preloadModel: async (model, numCtx) => {
        // Rien d'autre ne doit être chargé pendant la mesure.
        env.loadedDuringLoad.push(env.loaded)
        env.loads.push(numCtx)
        env.loaded = { model, numCtx }
        return true
      },
      // Fausse carte : tout le modèle y tient jusqu'à `fitsUpTo` tokens, au-delà une partie reste sur le processeur.
      modelPlacement: async (model) =>
        env.loaded?.model === model
          ? { sizeBytes: 5 * GB, vramBytes: env.loaded.numCtx <= env.fitsUpTo ? 5 * GB : 4 * GB, contextLength: env.loaded.numCtx }
          : null
    },
    './hardwareScan': { CONTEXT_LENGTH_STEPS: STEPS, estimateContextOnCard: async () => env.estimate },
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
    ollamaUp: true,
    // Carte graphique : rien de connu par défaut (fenêtre de 32 768, sans aucun essai de chargement).
    native: null,
    estimate: null,
    fitsUpTo: 0,
    loaded: null,
    loads: [],
    loadedDuringLoad: [],
    unloads: 0
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

// Étape 352, Léo : « mais on mesure pas la vitesse, ouais fais en sorte qu'on fait autant d'étapes que eux ».
test('plus de limite de temps pour l’agent, celle du correcteur reste celle de la tâche', () => {
  const env = makeEnv()
  const mod = load(env)
  // La vraie forme d'un task.toml de Terminal-Bench 2.1 (path-tracing), avec ses sous-tables.
  const real = [
    'schema_version = "1.1"',
    '[task]',
    'name = "terminal-bench/path-tracing"',
    '[[task.authors]]',
    'name = "Nicholas Carlini"',
    '[verifier]',
    'timeout_sec = 1800.0',
    '[agent]',
    'timeout_sec = 1800.0',
    '[environment]',
    'build_timeout_sec = 600.0',
    'docker_image = "alexgshaw/path-tracing:20251031"',
    '[verifier.env]',
    ''
  ].join('\n')
  const out = mod.removeAgentTimeout(real)
  assert.equal(out, real.replace('[agent]\ntimeout_sec = 1800.0\n', '[agent]\n'))
  assert.match(out, /\[verifier\]\ntimeout_sec = 1800\.0/)
  // Un fichier déjà porté à 2 h par une version précédente, aux fins de ligne Windows, en commentaire après l'en-tête.
  assert.equal(mod.removeAgentTimeout('[agent]  # agent\r\ntimeout_sec = 7200.0\r\nuser = "root"\r\n'), '[agent]  # agent\nuser = "root"\n')
  // Un timeout_sec d'une autre section n'est jamais touché.
  assert.equal(mod.removeAgentTimeout('[agent.env]\ntimeout_sec = 5\n'), '[agent.env]\ntimeout_sec = 5\n')
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
  // Une réponse ne dépasse jamais la mémoire du modèle : la seule borne d'un modèle qui écrirait sans fin.
  assert.deepEqual(JSON.parse(kw.llm_call_kwargs), { num_ctx: 32768, num_predict: 32768 })
  const info = JSON.parse(kw.model_info)
  assert.equal(info.max_input_tokens, 32768)
  // Seulement le chiffre que Terminus 2 cite au modèle quand sa réponse est trop longue : il ne limite rien.
  assert.equal(info.max_output_tokens, 8192)
  // Préparation de la tâche : une connexion lente ne compte jamais contre le modèle.
  assert.equal(argAfter(args, '--environment-build-timeout-multiplier'), '6')
  assert.equal(argAfter(args, '--agent-setup-timeout-multiplier'), '6')
  // Aucune option de Harbor ne remet de limite de temps à l'agent.
  for (const flag of ['--timeout-multiplier', '--agent-timeout-multiplier']) assert.ok(!args.includes(flag), flag)
  assert.ok(!args.some((a) => a.includes('override_timeout')))
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
  // Ces deux délais ne mesurent que la machine (image à télécharger, agent à installer).
  assert.equal(mod.isSlowMachine('EnvironmentStartTimeoutError'), true)
  assert.equal(mod.isSlowMachine('AgentSetupTimeoutError'), true)
  for (const e of [null, 'AgentTimeoutError', 'VerifierTimeoutError', 'Timeout', 'DockerError']) {
    assert.equal(mod.isSlowMachine(e), false, String(e))
  }
})

test('test d’avant l’étape 352 : une tâche est gardée seulement si aucune limite de temps n’a pu la couper', () => {
  const mod = load(makeEnv())
  const ok = { passed: true, exception: null }
  // Plus courte que la plus petite limite d'alors (6 min pour installer l'agent) : gardée sans rien relire.
  assert.equal(mod.keptWithoutTimeLimit({ trials: 3, seconds: 359 }, null), true)
  // Agent trop lent à installer (6 min), compté contre le modèle à l'époque : refaite.
  assert.equal(mod.keptWithoutTimeLimit({ trials: 1, seconds: 420 }, [{ passed: false, exception: 'AgentSetupTimeoutError' }]), false)
  // Assez longue pour avoir été coupée : gardée seulement si chaque essai s'est fini sans erreur.
  assert.equal(mod.keptWithoutTimeLimit({ trials: 3, seconds: 600 }, [ok, ok, ok]), true)
  assert.equal(mod.keptWithoutTimeLimit({ trials: 1, seconds: 3600 }, [{ ...ok, longestCallMs: 599_000, llmError: false }]), true)
  // Une réponse de 10 min ou plus : coupée à 600 s puis refaite par un essai automatique, sans erreur visible.
  assert.equal(mod.keptWithoutTimeLimit({ trials: 1, seconds: 3628 }, [{ ...ok, longestCallMs: 1_676_579 }]), false)
  // Un appel échoué jusqu'au bout puis relancé par Terminus 2 : seule la ligne de son journal le dit.
  assert.equal(mod.keptWithoutTimeLimit({ trials: 1, seconds: 3600 }, [{ ...ok, longestCallMs: 30_000, llmError: true }]), false)
  assert.equal(mod.keptWithoutTimeLimit({ trials: 3, seconds: 9000 }, [ok, { passed: false, exception: 'AgentTimeoutError' }, ok]), false)
  // « Timeout » : une réponse coupée au bout de 10 min par LiteLLM, puis l'essai abandonné.
  assert.equal(mod.keptWithoutTimeLimit({ trials: 1, seconds: 2000 }, [{ passed: false, exception: 'Timeout' }]), false)
  // Fichiers de l'essai introuvables ou incomplets : impossible de savoir, la tâche est refaite.
  assert.equal(mod.keptWithoutTimeLimit({ trials: 3, seconds: 2000 }, null), false)
  assert.equal(mod.keptWithoutTimeLimit({ trials: 3, seconds: 2000 }, [ok, ok]), false)
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
    // Sans REQUEST_TIMEOUT, LiteLLM coupe chaque réponse du modèle au bout de 10 minutes (étape 352).
    const harborRun = env.spawns.find((s) => s.args.includes('-i'))
    assert.equal(harborRun.env.REQUEST_TIMEOUT, String(24 * 3600))
    // Harbor passe par python/tbench_boot.py (250 réponses du modèle au plus, réponses trop longues comprises),
    // sans que le dossier des scripts de Jaris n'entre dans son chemin de modules (-P).
    const boot = join(PYTHON_DIR, 'tbench_boot.py')
    assert.ok(fs.existsSync(boot))
    assert.deepEqual(harborRun.args.slice(0, 2), ['-P', boot])
    assert.deepEqual(env.spawns.find((s) => s.args.includes('dataset')).args.slice(0, 2), ['-P', boot])
    assert.equal(harborRun.env.JARIS_TBENCH_MAX_TURNS, '250')

    assert.equal(env.runs.length, TASKS)
    assert.deepEqual(env.pulled, ['granite4.2:3b'])
    const tasksDir = join(env.root, 'terminal-bench', 'tasks', 'terminal-bench-2-1')
    // Plus aucune limite de temps pour l'agent (étape 352), celle du correcteur ne bouge pas.
    for (const task of ['tache-00', 'tache-01']) {
      const toml = readFileSync(join(tasksDir, task, 'task.toml'), 'utf8')
      assert.match(toml, /\[agent\]\n\n\[verifier\]\ntimeout_sec = 600\.0/, task)
    }

    const run = readResults(env.root).runs['granite4.2:3b|3']
    assert.ok(run.finishedAt)
    assert.equal(run.noTimeLimit, true)
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

test('préparation de la tâche trop lente : jamais comptée contre le modèle, même avec Docker et Ollama en marche', async () => {
  for (const exception of ['EnvironmentStartTimeoutError', 'AgentSetupTimeoutError']) {
    const env = makeEnv({ trial: (task) => (task === 'tache-03' ? { exception } : { reward: 1 }) })
    try {
      const mod = load(env)
      const end = waitForEnd(mod)
      mod.startTerminalBench('granite4.2:3b', 1)
      const last = await end
      assert.equal(last.phase, 'error', exception)
      assert.match(last.error, /tache-03/)
      assert.match(last.error, /préparation de la tâche/)
      const run = readResults(env.root).runs['granite4.2:3b|1']
      assert.deepEqual(Object.keys(run.tasks), ['tache-00', 'tache-01', 'tache-02'])

      // Relancé une fois la connexion revenue : la tâche est reprise, sans rien refaire d'autre.
      const env2Runs = env.runs.length
      const mod2 = load(env)
      const end2 = waitForEnd(mod2)
      mod2.startTerminalBench('granite4.2:3b', 1)
      await end2
      assert.equal(env.runs[env2Runs].task, 'tache-03')
    } finally {
      rmSync(env.root, { recursive: true, force: true })
    }
  }
})

test('test commencé avec la limite de 2 h : seules ses tâches coupées par le temps sont refaites', async () => {
  const env = makeEnv()
  try {
    const mod = load(env)
    const end = waitForEnd(mod)
    mod.startTerminalBench('granite4.2:3b', 3)
    assert.equal((await end).phase, 'done')
    // On en fait un test d'avant l'étape 352, comme s'il avait été joué avec la limite de 2 h.
    const results = readResults(env.root)
    const run = results.runs['granite4.2:3b|3']
    delete run.noTimeLimit
    const jobs = join(env.root, 'terminal-bench', 'jobs')
    const trialFile = (task, k) => join(jobs, mod.jobNameFor('granite4.2:3b', task, 3), `${task}__t${k}`, 'result.json')
    const cut = (task, k, exception) =>
      fs.writeFileSync(trialFile(task, k), JSON.stringify({ verifier_result: { rewards: { reward: 0 } }, exception_info: { exception_type: exception } }))
    // tache-05 : un essai coupé par les 2 h. tache-06 : une réponse coupée par LiteLLM au bout de 10 min.
    cut('tache-05', 1, 'AgentTimeoutError')
    cut('tache-06', 2, 'Timeout')
    // tache-07 : longue mais sans erreur, gardée. tache-08 : longue, fichiers disparus, refaite.
    // tache-09 : erreur, mais trop courte pour avoir été coupée par une limite de temps : gardée.
    cut('tache-09', 0, 'AgentTimeoutError')
    // tache-10 : une réponse de 28 min (coupée à 10 min puis refaite, sans erreur visible). tache-11 : un appel échoué
    // puis relancé par Terminus 2, seulement écrit dans son journal. Toutes deux refaites.
    const quiet = (task, k, times) =>
      fs.writeFileSync(trialFile(task, k), JSON.stringify({ verifier_result: { rewards: { reward: 1 } }, exception_info: null, agent_result: { metadata: { api_request_times_msec: times } } }))
    quiet('tache-07', 0, [40_000, 599_000])
    quiet('tache-10', 1, [44_381, 1_676_579])
    fs.writeFileSync(join(trialFile('tache-11', 2), '..', 'trial.log'), 'ERROR Unknown Error in LLM interaction: litellm.Timeout\n')
    for (const t of ['tache-05', 'tache-06', 'tache-07', 'tache-08', 'tache-10', 'tache-11']) run.tasks[t].seconds = 7300
    run.tasks['tache-09'].seconds = 100
    rmSync(join(jobs, mod.jobNameFor('granite4.2:3b', 'tache-08', 3)), { recursive: true, force: true })
    run.seconds = Object.values(run.tasks).reduce((sum, t) => sum + t.seconds, 0)
    const secondsBefore = run.seconds
    fs.writeFileSync(join(env.root, 'terminal-bench', 'results.json'), JSON.stringify(results))
    // Tâches encore portées à 2 h par l'ancienne version : la limite doit être retirée à la reprise.
    const tasksDir = join(env.root, 'terminal-bench', 'tasks', 'terminal-bench-2-1')
    fs.writeFileSync(join(tasksDir, 'tache-01', 'task.toml'), '[agent]\ntimeout_sec = 7200.0\n\n[verifier]\ntimeout_sec = 600.0\n')
    fs.writeFileSync(join(tasksDir, '.jaris-timeouts'), '7200')
    env.runs = []

    const mod2 = load(env)
    const end2 = waitForEnd(mod2)
    mod2.startTerminalBench('granite4.2:3b', 3)
    assert.equal((await end2).phase, 'done')
    assert.deepEqual(env.runs.map((r) => r.task), ['tache-05', 'tache-06', 'tache-08', 'tache-10', 'tache-11'])
    const after = readResults(env.root).runs['granite4.2:3b|3']
    assert.equal(after.noTimeLimit, true)
    assert.ok(after.finishedAt)
    assert.equal(after.tasks['tache-07'].seconds, 7300, 'la tâche longue sans erreur est gardée telle quelle')
    assert.equal(after.tasks['tache-09'].seconds, 100)
    // Les secondes des tâches refaites remplacent les anciennes.
    const redoneTasks = ['tache-05', 'tache-06', 'tache-08', 'tache-10', 'tache-11']
    const redone = redoneTasks.reduce((sum, t) => sum + after.tasks[t].seconds, 0)
    assert.equal(after.seconds, secondsBefore - redoneTasks.length * 7300 + redone)
    assert.equal(readFileSync(join(tasksDir, 'tache-01', 'task.toml'), 'utf8'), '[agent]\n\n[verifier]\ntimeout_sec = 600.0\n')
    assert.equal(readFileSync(join(tasksDir, '.jaris-timeouts'), 'utf8'), 'none')

    // Un test déjà joué sans limite n'est jamais relu ni refait.
    env.runs = []
    const mod3 = load(env)
    const end3 = waitForEnd(mod3)
    mod3.startTerminalBench('granite4.2:3b', 3)
    assert.equal((await end3).phase, 'done')
    assert.deepEqual(env.runs, [])
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

// Étape 351, Léo : « mémoire on peut pas changer ça ? » puis « oui ». La fenêtre n'est plus fixe : la plus grande qui
// tient ENTIÈREMENT sur la carte, vérifiée par un vrai chargement du modèle, jamais moins qu'avant (32 768).
function numCtxOfRun(r) {
  const i = r.args.findIndex((a, k) => r.args[k - 1] === '--ak' && a.startsWith('llm_call_kwargs='))
  return JSON.parse(r.args[i].slice('llm_call_kwargs='.length)).num_ctx
}
function maxInputOfRun(r) {
  const i = r.args.findIndex((a, k) => r.args[k - 1] === '--ak' && a.startsWith('model_info='))
  return JSON.parse(r.args[i].slice('model_info='.length)).max_input_tokens
}

test('fenêtres à essayer : de la plus grande qui devrait tenir au plancher, jamais au-delà du modèle', () => {
  const mod = load(makeEnv())
  const C = (native, upper) => mod.benchContextCandidates(native, upper, STEPS)
  assert.deepEqual(C(262144, 140000), [131072, 65536, 32768])
  assert.deepEqual(C(131072, 1e9), [131072, 65536, 32768], 'jamais plus que le modèle')
  // Un maximum qui n'est pas un palier est essayé tel quel.
  assert.deepEqual(C(40960, 1e9), [40960, 32768])
  assert.deepEqual(C(40960, 35000), [32768])
  // Le modèle seul déborde déjà de la carte, ou la carte est inconnue : la fenêtre d'avant, sans rien essayer.
  assert.deepEqual(C(131072, 0), [32768])
  assert.deepEqual(C(131072, null), [32768])
  assert.deepEqual(C(null, 1e9), [32768])
  // Un modèle qui ne lit pas 32 768 tokens garde son propre maximum, comme avant.
  assert.deepEqual(C(8192, 1e9), [8192])
  assert.equal(mod.shortContext(65536), '64k')
  assert.equal(mod.shortContext(40960), '40k')
})

test('« tient sur la carte » : tout le modèle sur la carte, avec la fenêtre demandée', () => {
  const mod = load(makeEnv())
  assert.equal(mod.fullyOnCard({ sizeBytes: 5 * GB, vramBytes: 5 * GB, contextLength: 65536 }, 65536), true)
  assert.equal(mod.fullyOnCard({ sizeBytes: 5 * GB, vramBytes: 5 * GB, contextLength: null }, 65536), true)
  assert.equal(mod.fullyOnCard({ sizeBytes: 5 * GB, vramBytes: 4.8 * GB, contextLength: 65536 }, 65536), false)
  assert.equal(mod.fullyOnCard({ sizeBytes: 5 * GB, vramBytes: 5 * GB, contextLength: 32768 }, 65536), false)
  assert.equal(mod.fullyOnCard(null, 65536), false)
})

test('nouveau test : la plus grande fenêtre qui tient vraiment sur la carte, puis gardée pour la reprise', async () => {
  const env = makeEnv()
  Object.assign(env, { native: 131072, estimate: 140000, fitsUpTo: 65536, loaded: { model: 'autre:7b', numCtx: 8192 } })
  try {
    const mod = load(env)
    const seen = []
    mod.onTerminalBenchProgress((p) => seen.push(p))
    const end = waitForEnd(mod)
    mod.startTerminalBench('granite4.2:3b', 1)
    assert.equal((await end).phase, 'done')
    // 128k essayé puis refusé (une partie sur le processeur), 64k retenu ; chaque essai seul sur la carte.
    assert.deepEqual(env.loads, [131072, 65536])
    assert.deepEqual(env.loadedDuringLoad, [null, null])
    assert.ok(seen.some((p) => /mémoire de 128k/.test(p.step)), 'l’essai en cours est affiché')
    assert.equal(seen.at(-1).numCtx, 65536)
    assert.ok(env.runs.every((r) => numCtxOfRun(r) === 65536 && maxInputOfRun(r) === 65536))
    assert.equal(readResults(env.root).runs['granite4.2:3b|1'].numCtx, 65536)

    // Reprise : la même fenêtre, sans rien remesurer, même si la carte est plus chargée ce jour-là.
    const results = readResults(env.root)
    const run = results.runs['granite4.2:3b|1']
    for (const t of ['tache-10', 'tache-11']) delete run.tasks[t]
    run.finishedAt = null
    fs.writeFileSync(join(env.root, 'terminal-bench', 'results.json'), JSON.stringify(results))
    Object.assign(env, { runs: [], loads: [], fitsUpTo: 0 })
    const mod2 = load(env)
    const end2 = waitForEnd(mod2)
    mod2.startTerminalBench('granite4.2:3b', 1)
    assert.equal((await end2).phase, 'done')
    assert.deepEqual(env.loads, [])
    assert.deepEqual(env.runs.map((r) => [r.task, numCtxOfRun(r)]), [['tache-10', 65536], ['tache-11', 65536]])
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})

test('carte inconnue ou modèle trop gros : la fenêtre d’avant, sans aucun essai de chargement', async () => {
  for (const estimate of [null, 0]) {
    const env = makeEnv()
    Object.assign(env, { native: 131072, estimate, fitsUpTo: 262144 })
    try {
      const mod = load(env)
      const end = waitForEnd(mod)
      mod.startTerminalBench('granite4.2:3b', 1)
      assert.equal((await end).phase, 'done')
      assert.deepEqual(env.loads, [], `estimate=${estimate}`)
      assert.equal(env.unloads, 0, 'aucun modèle de Jaris déchargé pour rien')
      assert.ok(env.runs.every((r) => numCtxOfRun(r) === 32768))
    } finally {
      rmSync(env.root, { recursive: true, force: true })
    }
  }
})

test('test commencé avant l’étape 351 : repart de zéro si la fenêtre change, continue sinon', async () => {
  const oldRun = (root) => {
    const tasks = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`tache-0${i}`, { passed: 1, trials: 1, seconds: 60 }]))
    fs.mkdirSync(join(root, 'terminal-bench'), { recursive: true })
    fs.writeFileSync(
      join(root, 'terminal-bench', 'results.json'),
      JSON.stringify({
        version: 1,
        runs: { 'granite4.2:3b|1': { model: 'granite4.2:3b', attempts: 1, startedAt: 'x', finishedAt: null, seconds: 300, tasks } }
      })
    )
  }
  // La carte permet 64k : les 5 tâches faites avec 32 768 ne sont pas mélangées avec les nouvelles.
  const env = makeEnv()
  Object.assign(env, { native: 131072, estimate: 70000, fitsUpTo: 65536 })
  try {
    oldRun(env.root)
    const mod = load(env)
    const end = waitForEnd(mod)
    mod.startTerminalBench('granite4.2:3b', 1)
    assert.equal((await end).phase, 'done')
    assert.equal(env.runs.length, TASKS)
    const run = readResults(env.root).runs['granite4.2:3b|1']
    assert.equal(run.numCtx, 65536)
    assert.ok(run.seconds < 300, 'les secondes de l’ancien test ne sont pas reprises')
    assert.equal(Object.keys(run.tasks).length, TASKS)
    assert.notEqual(run.startedAt, 'x')
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
  // La carte ne permet pas plus : l'ancien test continue où il en était.
  const env2 = makeEnv()
  Object.assign(env2, { native: 131072, estimate: 70000, fitsUpTo: 32768 })
  try {
    oldRun(env2.root)
    const mod = load(env2)
    const end = waitForEnd(mod)
    mod.startTerminalBench('granite4.2:3b', 1)
    assert.equal((await end).phase, 'done')
    assert.deepEqual(env2.loads, [65536])
    assert.equal(env2.runs.length, TASKS - 5)
    const run = readResults(env2.root).runs['granite4.2:3b|1']
    assert.equal(run.startedAt, 'x')
    assert.equal(run.numCtx, 32768)
  } finally {
    rmSync(env2.root, { recursive: true, force: true })
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

// Étape 350, Léo : « ça fait 58 min et toujours pareil ». Pendant une tâche, la carte lit ce que Harbor écrit au fil
// de l'essai (même structure que le vrai dossier d'un essai de Harbor 0.24.0, relevée sur un vrai lancement).
function writeTrial(jobDir, name, { config = true, steps = null, trajectory = null, verifier = false, result = false } = {}) {
  const dir = join(jobDir, name)
  fs.mkdirSync(join(dir, 'agent'), { recursive: true })
  fs.mkdirSync(join(dir, 'verifier'), { recursive: true })
  if (config) fs.writeFileSync(join(dir, 'config.json'), '{}')
  if (steps !== null) {
    const list = [{ step_id: 1, source: 'user', message: 'tâche' }]
    for (let i = 0; i < steps; i++) list.push({ step_id: i + 2, source: 'agent', message: 'commande' })
    fs.writeFileSync(join(dir, 'agent', 'trajectory.json'), JSON.stringify({ schema_version: 'x', steps: list }))
  }
  if (trajectory !== null) fs.writeFileSync(join(dir, 'agent', 'trajectory.json'), trajectory)
  if (verifier) fs.writeFileSync(join(dir, 'verifier', 'test-stdout.txt'), 'tests')
  if (result) fs.writeFileSync(join(dir, 'result.json'), '{}')
  return dir
}

function setTime(file, ms) {
  fs.utimesSync(file, ms / 1000, ms / 1000)
}

test('pendant une tâche : essai en cours, étapes du modèle et dernière activité lus dans les fichiers de Harbor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jaris-tbench-live-'))
  try {
    const mod = load(makeEnv())
    const jobDir = join(root, 'job')
    // Harbor n'a encore rien écrit.
    assert.deepEqual(await mod.readLiveTrial(jobDir, 3), {
      trial: 1, trialsDone: 0, stage: 'starting', steps: 0, trialStartedAt: null, lastActivityAt: null
    })
    // Essai commencé, conteneur en préparation (aucune étape du modèle).
    fs.mkdirSync(jobDir, { recursive: true })
    const first = writeTrial(jobDir, 'tache__a1')
    setTime(join(first, 'config.json'), 1_000_000)
    let live = await mod.readLiveTrial(jobDir, 3)
    assert.equal(live.stage, 'environment')
    assert.equal(live.trialStartedAt, 1_000_000)
    // Le modèle a fait 37 étapes : trajectory.json est réécrit après chacune.
    writeTrial(jobDir, 'tache__a1', { steps: 37 })
    setTime(join(first, 'agent', 'trajectory.json'), 5_000_000)
    fs.writeFileSync(join(first, 'agent', 'recording.cast'), 'x')
    setTime(join(first, 'agent', 'recording.cast'), 4_000_000)
    live = await mod.readLiveTrial(jobDir, 3)
    assert.equal(live.stage, 'agent')
    assert.equal(live.steps, 37, 'seules les étapes du modèle comptent, pas la consigne')
    assert.equal(live.lastActivityAt, 5_000_000, 'la dernière écriture, quel que soit le fichier')
    // Fichier en pleine écriture : le dernier nombre lu est gardé, jamais 0.
    fs.writeFileSync(join(first, 'agent', 'trajectory.json'), '{"steps": [{"source": "ag')
    setTime(join(first, 'agent', 'trajectory.json'), 6_000_000)
    assert.equal((await mod.readLiveTrial(jobDir, 3)).steps, 37)
    // Les tests de la tâche tournent.
    fs.writeFileSync(join(first, 'verifier', 'test-stdout.txt'), 'tests')
    assert.equal((await mod.readLiveTrial(jobDir, 3)).stage, 'verifying')
    // Premier essai fini, deuxième commencé.
    fs.writeFileSync(join(first, 'result.json'), '{}')
    writeTrial(jobDir, 'tache__b2', { steps: 4 })
    live = await mod.readLiveTrial(jobDir, 3)
    assert.deepEqual([live.trial, live.trialsDone, live.stage, live.steps], [2, 1, 'agent', 4])
    // Entre deux essais : rien d'en cours, l'essai suivant démarre.
    fs.writeFileSync(join(jobDir, 'tache__b2', 'result.json'), '{}')
    live = await mod.readLiveTrial(jobDir, 3)
    assert.deepEqual([live.trial, live.trialsDone, live.stage], [3, 2, 'starting'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pendant une tâche : la carte reçoit l’essai en cours, puis plus rien une fois la tâche finie', async (t) => {
  const env = makeEnv({ hangTask: 'tache-01' })
  t.mock.timers.enable({ apis: ['setInterval'] })
  try {
    const mod = load(env)
    const seen = []
    mod.onTerminalBenchProgress((p) => seen.push(p))
    const end = waitForEnd(mod)
    mod.startTerminalBench('granite4.2:3b', 3)
    for (let i = 0; i < 400 && !env.runs.some((r) => r.task === 'tache-01'); i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.ok(env.runs.some((r) => r.task === 'tache-01'), 'la tâche bloquée n’a jamais démarré')
    const started = seen.find((p) => p.currentTask === 'tache-01')
    assert.equal(started.live.stage, 'starting', 'dès le début de la tâche, la carte sait qu’un essai démarre')
    assert.equal(typeof started.startedAt, 'number')
    // Le faux Harbor ne joue rien : on écrit ce que le vrai écrirait, puis on avance l’horloge d’une mise à jour.
    const jobDir = join(env.root, 'terminal-bench', 'jobs', mod.jobNameFor('granite4.2:3b', 'tache-01', 3))
    for (let i = 0; i < 200 && !fs.existsSync(jobDir); i++) await new Promise((r) => setTimeout(r, 10))
    writeTrial(jobDir, 'tache-01__x', { steps: 12 })
    t.mock.timers.tick(10_000)
    for (let i = 0; i < 200 && !seen.some((p) => p.live?.steps === 12); i++) await new Promise((r) => setTimeout(r, 10))
    const live = seen.findLast((p) => p.live?.steps === 12)?.live
    assert.ok(live, 'les étapes du modèle n’ont jamais été envoyées à la carte')
    assert.deepEqual([live.trial, live.stage], [1, 'agent'])
    await mod.stopTerminalBench()
    await end
    assert.equal(seen.at(-1).live ?? null, null, 'hors d’une tâche, plus rien n’est affiché sur l’essai')
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})

test('le texte « rien depuis plus de 15 minutes » suit le seuil de la carte', () => {
  const src = readFileSync(new URL('../src/components/TerminalBenchTest.tsx', import.meta.url), 'utf8')
  assert.match(src, /const QUIET_MS = 15 \* 60_000/)
  const fr = readFileSync(new URL('../shared/i18n/fr.ts', import.meta.url), 'utf8')
  assert.match(fr, /"tbench\.quiet": "Aucune activité depuis plus de 15 minutes/)
})
