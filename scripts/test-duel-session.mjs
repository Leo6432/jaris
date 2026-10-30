import assert from 'node:assert/strict'
import test from 'node:test'
import { i18nModules, loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 355 — une session de Duel de bout en bout, avec de faux Ollama/converse/profil : préparation (téléchargements
 * sans nom), A puis B (chacun avec SON modèle, sans raccourci de Jaris, jamais d'extinction du PC), vote, duel suivant,
 * fin avec les noms révélés et le choix de Jaris mis à jour, suppression des modèles téléchargés.
 *
 * Le point le plus important : l'écran ne reçoit JAMAIS le nom d'un modèle avant la fin (Léo : « anonyme »).
 */
const duelModule = loadTsModule('shared/duel.ts')
const effortModule = loadTsModule('shared/effort.ts')
/**
 * Étape 365 : ce que chaque faux modèle annonce de sa réflexion (`/api/show`) — un modèle à niveaux comme qwen3.8, un
 * modèle « avec ou sans » comme gemma4, un modèle sans réflexion, et un modèle à deux niveaux seulement.
 */
const THINKING = {
  // Les défauts tels qu'Ollama les annonce vraiment (server/model_thinking.go : « medium » pour qwen3.8, « activée »
  // pour un modèle avec ou sans comme gemma4).
  'alpha-model:3b': effortModule.parseModelThinking({ capabilities: ['thinking'], thinking: { values: [false, 'low', 'medium', 'xhigh'], default: 'medium' } }),
  'bravo-model:8b': effortModule.parseModelThinking({ capabilities: ['thinking'], thinking: { values: [false, true], default: true } }),
  'charlie-model:4b': effortModule.parseModelThinking({ capabilities: ['completion', 'tools'] }),
  'delta-model:7b': effortModule.parseModelThinking({ capabilities: ['thinking'], thinking: { values: ['low', 'high'], default: 'high' } })
}
/** La réflexion attendue pour chacun : l'équivalent de « moyen » dans SES réglages. */
const EXPECTED_THINK = { 'alpha-model:3b': 'medium', 'bravo-model:8b': true, 'charlie-model:4b': false, 'delta-model:7b': 'low' }
const MODELS = ['alpha-model:3b', 'bravo-model:8b', 'charlie-model:4b', 'delta-model:7b']
const tick = () => new Promise((resolve) => setImmediate(resolve))

async function waitFor(predicate, what) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return
    await tick()
  }
  // Étape 365 : la fausse génération de code attend une vraie mise à jour de l'écran (200 ms) — on patiente en vrai temps.
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`jamais arrivé : ${what}`)
}

/**
 * Étape 382 : un faux disque pour la série gardée (duelSeriesStore.ts), qui survit d'un « lancement de Jaris » (setup)
 * à l'autre quand on le passe au suivant. La vraie lecture (parseSeriesSnapshot) relit ce qui a été écrit, comme le
 * vrai fichier : un snapshot qui ne se relit pas ne reprendrait jamais.
 */
const seriesStoreModule = loadTsModule('electron/services/duelSeriesStore.ts', {
  'fs/promises': {},
  path: { join: (...parts) => parts.join('/') },
  './atomicFile': { UNREADABLE_DATA_DIR: 'x', readJsonDataFile: async () => ({ status: 'missing' }), writeFileAtomic: async () => {} },
  './dataLocation': { getDataRoot: () => '/donnees' },
  '../../shared/duel': duelModule
})
function newSeriesStore() {
  const store = { json: null, apps: new Map(), saves: 0, cleared: 0 }
  store.module = {
    SERIES_FORMAT: seriesStoreModule.SERIES_FORMAT,
    SERIES_VERSION: seriesStoreModule.SERIES_VERSION,
    saveSeries: async (snapshot) => {
      store.saves++
      store.json = JSON.stringify(snapshot)
    },
    loadSeries: async () => (store.json === null ? null : seriesStoreModule.parseSeriesSnapshot(JSON.parse(store.json))),
    clearSeries: async () => {
      store.cleared++
      store.json = null
      store.apps.clear()
    },
    saveSeriesApp: async (number, side, html) => {
      store.apps.set(`${number}-${side}`, html)
    },
    readSeriesApp: async (number, side) => store.apps.get(`${number}-${side}`) ?? null
  }
  Object.defineProperty(store, 'snapshot', { get: () => (store.json === null ? null : JSON.parse(store.json)) })
  return store
}

function setup({ installed = [], failPull = [], category = 'conversation', profile: initialProfile, converseImpl, ttsFails = false, blind = false, repairs = true, canDraw = true, vramGb = 8, generateGate = null, seriesStore = newSeriesStore(), freeDiskGb = 100, sizes = null, generateImpl = null, podDiskGb = null, priorVotes = [] } = {}) {
  const calls = { pulls: [], converse: [], generate: [], deleted: [], patches: [], speech: [], drawChecks: 0, awake: [], active: new Map(), mostModels: 0, pulled: [] }
  let ollamaDown = false
  const votes = [...priorVotes]
  const apps = new Map()
  const emitted = []
  let profile = initialProfile ?? {
    name: 'Léo',
    models: { flash: 'alpha-model:3b', medium: 'alpha-model:3b', large: 'bravo-model:8b' },
    codeModel: 'bravo-model:8b'
  }
  let installedNow = [...installed]
  let uuid = 0
  const pullGates = new Map()
  const modules = {
    crypto: { randomUUID: () => `uuid-${uuid++}` },
    './assistant': {
      converse: async (...args) => {
        calls.converse.push(args)
        return converseImpl ? converseImpl(...args) : defaultConverse(...args)
      }
    },
    './codeGenerator': {
      generateApp: async (prompt, _onStatus, _current, _image, options) => {
        calls.generate.push({ prompt, options })
        // Modèles différents qui écrivent en même temps (un même modèle n'est chargé qu'une fois par Ollama).
        calls.active.set(options.model, (calls.active.get(options.model) ?? 0) + 1)
        calls.mostModels = Math.max(calls.mostModels, calls.active.size)
        const done = () => {
          const left = (calls.active.get(options.model) ?? 1) - 1
          if (left > 0) calls.active.set(options.model, left)
          else calls.active.delete(options.model)
        }
        try {
          return await generateBody(prompt, options)
        } finally {
          done()
        }
      }
    },
    './generatedAppPreview': { createGeneratedAppPreview: (html) => `jaris-preview://app/${html.length}/index.html` }
  }
  async function generateBody(prompt, options) {
    // Étape 382 : un modèle qui n'est pas sur le disque ne peut pas écrire (comme le vrai Ollama).
    if (!installedNow.includes(options.model)) {
      calls.notInstalled = (calls.notInstalled ?? 0) + 1
      throw new Error(`model '${options.model}' not found`)
    }
    // Étape 365 : un vrai avancement de génération (CodeGenProgress), réflexion comprise.
    options.onProgress?.({
      label: 'Génération',
      stepIndex: 1,
      stepCount: 2,
      charsWritten: 0,
      thinking: true,
      idleMs: 0,
      elapsedMs: 1000,
      phase: 'thinking',
      thinkingChars: 12400,
      thinkingText: `Je suis ${options.model} et je réfléchis`
    })
    // Le temps qu'une mise à jour parte vers l'écran (au plus une toutes les 120 ms).
    await new Promise((resolve) => setTimeout(resolve, 200))
    // Étape 379 : une génération qui attend qu'on la libère, pour voir A et B travailler en même temps.
    if (generateGate) await generateGate.promise
    if (options.signal?.aborted) throw Object.assign(new Error('arrêté'), { name: 'AbortError' })
    // Étape 382 : Ollama arrêté en pleine série, ou une génération propre au test.
    if (ollamaDown) throw new Error('Ollama ne répond pas')
    if (generateImpl) return generateImpl(prompt, options)
    return { html: `<html><body>${options.model.length}</body></html>`, issues: [], dir: '' }
  }
  Object.assign(modules, {
    // Étape 366 : ce que le PC peut faire tourner (dessin, modèle de vision par défaut).
    '../config': { config: { ollama: { visionModel: 'vision-model:8b' } } },
    './imageGenerator': {
      imageDrawingAvailable: async () => {
        calls.drawChecks++
        return canDraw
      }
    },
    './hardwareScan': {
      duelMachine: async () => ({ vramGb, ramGb: 32 }),
      duelPrior: (category) => () => (category === 'code' ? 20 : 10),
      getDuelCandidates: async () =>
        MODELS.map((model, index) => ({ model, vramGb: sizes?.[model] ?? index + 2, note: 10 - index, duels: 0, inUse: profile?.models && Object.values(profile.models).includes(model) })),
      imageReadingModels: () => ['vision-model:8b'],
      getDuelModelList: async () => [
        ...MODELS.map((model, index) => ({ model, vramGb: index + 2, reason: null })),
        { model: 'echo-model:70b', vramGb: 42, reason: { kind: 'tooBig', needGb: 42, budgetGb: 23 } }
      ],
      pickModelsForDuelCategory: async () => ({ flash: 'charlie-model:4b', medium: 'charlie-model:4b', large: 'bravo-model:8b', code: 'delta-model:7b' })
    },
    './ollama': {
      deleteModel: async (model) => {
        calls.deleted.push(model)
        installedNow = installedNow.filter((m) => m !== model)
      },
      // Étape 365 : `blind` = Ollama ne voit aucun modèle du disque (étapes 289/313) tant qu'il n'a pas été réparé.
      listInstalledModels: async () => (blind ? [] : [...installedNow]),
      repairModelsViewIfNeeded: async () => {
        calls.repairs = (calls.repairs ?? 0) + 1
        if (!repairs) return false
        blind = false
        return true
      },
      getModelThinking: async (model) => THINKING[model] ?? null,
      fetchOllamaVersion: async () => {
        if (ollamaDown) throw new Error('Ollama ne répond pas')
        return '0.40.10'
      },
      pullModelIfMissing: async (model, _onStatus, onProgress, signal) => {
        calls.pulls.push(model)
        // Comme le vrai : la vue est réparée, et un modèle déjà sur le disque n'est pas retéléchargé (`false`).
        blind = false
        if (installedNow.includes(model)) return false
        if (pullGates.has(model)) await pullGates.get(model).promise
        if (ollamaDown) throw new Error('fetch failed')
        if (signal?.aborted) throw new Error('arrêté')
        onProgress?.({ percent: 50 })
        if (failPull.includes(model)) throw new Error(`pull model manifest: ${model} introuvable`)
        // Étape 383 : le disque d'une machine louée, dont Jaris ne connaît pas la place libre, se remplit.
        if (podDiskGb !== null && installedNow.reduce((sum, m) => sum + (sizes?.[m] ?? 0), 0) + (sizes?.[model] ?? 0) > podDiskGb) {
          throw new Error(`write /root/.ollama/models/blobs/sha256-${model}-partial: no space left on device`)
        }
        installedNow.push(model)
        calls.pulled.push(model)
        return true
      }
    },
    './profileStore': {
      getProfile: async () => profile,
      patchProfile: async (change) => {
        calls.patches.push(change)
        profile = { ...profile, ...change }
        if ('voiceModels' in change && change.voiceModels === undefined) delete profile.voiceModels
        return profile
      }
    },
    './systemResources': {
      DISK_SAFETY_MARGIN_GB: 5,
      // Étape 382 : le disque se remplit à chaque modèle présent et se libère à chaque suppression.
      detectFreeDiskGb: async () => (podDiskGb !== null ? null : sizes ? freeDiskGb - installedNow.reduce((sum, m) => sum + (sizes[m] ?? 0), 0) : freeDiskGb)
    },
    './tools': {
      TOOLS: ['open_app', 'type_text', 'set_reminder', 'shutdown_pc', 'search_web', 'generate_image', 'look_at_screen', 'computer_use_task'].map((name) => ({
        function: { name }
      }))
    },
    './tts': {
      synthesizeSpeech: async (text) => {
        calls.speech.push(text)
        if (ttsFails) throw new Error('voix indisponible')
        return Buffer.from('RIFFwave')
      }
    },
    './duelStore': {
      addDuelVote: async (vote) => {
        votes.push(vote)
      },
      getDuelVotes: () => votes,
      getRankingVotes: () => votes,
      saveDuelApp: async (id, side, html) => {
        apps.set(`${id}-${side}`, html)
      },
      readDuelApp: async (id, side) => apps.get(`${id}-${side}`) ?? null
    },
    './duelSeriesStore': seriesStore.module,
    '../../shared/duel': duelModule,
    '../../shared/effort': effortModule
  })
  const session = loadTsModule('electron/services/duelSession.ts', modules)
  session.setDuelEnvironment({
    onReminderFire: () => {},
    emit: (view) => emitted.push(JSON.parse(JSON.stringify(view))),
    keepAwake: (on) => calls.awake.push(on)
  })
  return {
    session,
    calls,
    votes,
    apps,
    emitted,
    get profile() {
      return profile
    },
    get installed() {
      return installedNow
    },
    setOllamaDown(down) {
      ollamaDown = down
    },
    seriesStore,
    gatePull(model) {
      let release
      const promise = new Promise((resolve) => (release = resolve))
      pullGates.set(model, { promise })
      return release
    }
  }
}

/** Le modèle « fait » quelque chose de vérifiable (ouvre le Bloc-notes), écrit sa réponse au fil de l'eau, la rend. */
async function defaultConverse(_prompt, _name, _onReminder, onLog, _history, _signal, _live, _channel, onToken) {
  onLog?.('Modèle choisi à la main : quelque-chose (réflexion : medium)')
  onLog?.('Outil appelé : open_app({"app_name":"Bloc-notes"})')
  onLog?.("Résultat de l'outil : L'application Bloc-notes a été lancée.")
  onToken?.('C’est ')
  onToken?.('ouvert.')
  return 'C’est ouvert.'
}

/** Rien de ce que reçoit l'écran ne contient le nom d'un modèle (ni le tag complet, ni le nom sans tag). */
function assertAnonymous(views, when) {
  const text = JSON.stringify(views)
  for (const model of MODELS) {
    assert.ok(!text.includes(model), `${when} : « ${model} » envoyé à l’écran`)
    assert.ok(!text.includes(model.split(':')[0]), `${when} : « ${model.split(':')[0]} » envoyé à l’écran`)
  }
}

async function readySession(env, count = 4) {
  const started = await env.session.startDuel('conversation', count)
  await waitFor(() => env.session.getDuelView()?.phase === 'ready', 'session prête')
  return started
}

test('anonyme jusqu’au vote, puis noms révélés tout de suite (étape 358, comme Arena), puis duel suivant', async () => {
  const env = setup({ installed: ['alpha-model:3b', 'bravo-model:8b'] })
  const returned = [await readySession(env)]
  // Téléchargés : seulement les deux qui manquaient, et jamais un message qui les nomme.
  assert.deepEqual(env.calls.pulls.sort(), ['charlie-model:4b', 'delta-model:7b'])
  const preparing = env.emitted.filter((v) => v?.phase === 'preparing' && v.preparing)
  assert.ok(preparing.some((v) => v.preparing.total === 2), 'l’avancement du téléchargement est envoyé')

  returned.push(env.session.askDuel('Ouvre le Bloc-notes'))
  await waitFor(() => env.session.getDuelView().round.a.status === 'done', 'A a fini')
  returned.push(env.session.runDuelB())
  await waitFor(() => env.session.getDuelView().round.b.status === 'done', 'B a fini')
  const round = env.session.getDuelView().round
  assert.equal(round.a.text, 'C’est ouvert.')
  assert.deepEqual(round.a.actions, [{ tool: 'open_app', detail: 'Bloc-notes' }], 'ce qu’il a fait sur le PC, à vérifier')
  assertAnonymous(env.emitted, 'avant le vote')
  assertAnonymous(returned, 'réponses aux actions de l’écran avant le vote')
  const voted = await env.session.voteDuel('a')
  // Le vote est enregistré AVANT la révélation : seuls les votes à l'aveugle comptent.
  assert.equal(env.votes.length, 1)
  assert.equal(voted.round.number, 1, 'le même duel, noms révélés')
  assert.deepEqual([voted.round.revealed.a, voted.round.revealed.b, voted.round.revealed.outcome], [env.votes[0].modelA, env.votes[0].modelB, 'a'])
  await assert.rejects(env.session.voteDuel('b'), /déjà voté/, 'pas de second vote une fois les noms connus')
  const next = env.session.nextDuel()
  assert.equal(next.round.number, 2, 'duel suivant')
  assert.equal(next.round.prompt, null)
  assert.equal(next.round.revealed, null)
  assertAnonymous([next], 'duel suivant')
  // Le vote, lui, garde les vrais noms (dans le fichier des votes, jamais à l'écran).
  assert.equal(env.votes.length, 1)
  assert.ok(MODELS.includes(env.votes[0].modelA) && MODELS.includes(env.votes[0].modelB))
  assert.equal(env.votes[0].outcome, 'a')
  assert.equal(env.votes[0].prompt, 'Ouvre le Bloc-notes')
})

test('chaque côté répond avec SON modèle, sans raccourci de Jaris, et sans jamais pouvoir éteindre le PC', async () => {
  const env = setup({ installed: MODELS })
  await readySession(env)
  env.session.askDuel('Salut')
  await waitFor(() => env.session.getDuelView().round.a.status === 'done', 'A a fini')
  env.session.runDuelB()
  await waitFor(() => env.session.getDuelView().round.b.status === 'done', 'B a fini')
  const [a, b] = env.calls.converse.map((args) => args[11])
  assert.notEqual(a.model, b.model, 'deux modèles différents')
  assert.ok(MODELS.includes(a.model) && MODELS.includes(b.model))
  for (const restrictions of [a, b]) {
    assert.equal(restrictions.modelOnly, true, '« Salut » doit aller au modèle, pas à la réponse toute faite de Jaris')
    assert.equal(restrictions.allowedTools.has('shutdown_pc'), false)
    assert.equal(restrictions.allowedTools.has('open_app'), true)
    assert.equal(restrictions.note, '', 'aucune consigne en plus : le modèle répond comme d’habitude')
    assert.equal(restrictions.journalLabel, 'duel')
    assert.match(restrictions.refusal, /bloqué pendant un duel/)
  }
  // Aucun historique : chaque duel part de zéro, et rien n'entre dans la conversation du Chat.
  assert.deepEqual(env.calls.converse[0][4], [])
  assert.equal(env.calls.converse[0][7], 'chat', 'duel Conversation : comme dans le Chat')
})

test('l’ordre est tenu : B attend A, le vote attend les deux, une seule demande par duel', async () => {
  let releaseA
  const env = setup({
    installed: MODELS,
    converseImpl: (prompt) => (env.calls.converse.length === 1 ? new Promise((resolve) => (releaseA = () => resolve('fini'))) : Promise.resolve('fini'))
  })
  await readySession(env)
  assert.throws(() => env.session.askDuel('   '), /demande/)
  env.session.askDuel('Écris un poème')
  assert.throws(() => env.session.askDuel('Autre chose'), /déjà sa demande/)
  // Le modèle A est vraiment parti (après la lecture de sa réflexion et des outils de ce PC).
  await waitFor(() => env.session.getDuelView().round.a.status === 'running' && typeof releaseA === 'function', 'A tourne')
  assert.throws(() => env.session.runDuelB(), /A doit d.abord finir/)
  await assert.rejects(env.session.voteDuel('a'), /doivent d.abord finir/)
  releaseA()
  await waitFor(() => env.session.getDuelView().round.a.status === 'done', 'A a fini')
  await assert.rejects(env.session.voteDuel('b'), /doivent d.abord finir/, 'B n’a pas encore répondu')
  env.session.runDuelB()
  assert.throws(() => env.session.runDuelB(), /A doit d.abord finir/, 'B ne repart pas deux fois')
})

test('arrêter un modèle : son côté est « arrêté », pas en erreur, et le vote reste possible', async () => {
  const env = setup({
    installed: MODELS,
    converseImpl: (...args) =>
      new Promise((_resolve, reject) => args[5].addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
  })
  await readySession(env)
  env.session.askDuel('Long travail')
  await waitFor(() => env.session.getDuelView().round.a.status === 'running', 'A tourne')
  env.session.stopDuelRun()
  await waitFor(() => env.session.getDuelView().round.a.status === 'stopped', 'A arrêté')
  assert.equal(env.session.getDuelView().round.a.error, null)
})

test('une erreur d’Ollama qui nomme le modèle n’est jamais affichée avec son nom', async () => {
  const env = setup({
    installed: MODELS,
    converseImpl: async (...args) => {
      const model = args[11].model
      throw new Error(`Ollama a répondu 404 : model '${model}' not found (${model.split(':')[0]})`)
    }
  })
  await readySession(env)
  env.session.askDuel('Bonjour')
  await waitFor(() => env.session.getDuelView().round.a.status === 'error', 'A en erreur')
  const error = env.session.getDuelView().round.a.error
  assert.match(error, /Modèle A/)
  assertAnonymous([env.session.getDuelView(), ...env.emitted], 'message d’erreur')
  // Un nom qui en contient un autre (« qwen3.5:9b » et « qwen3.5 ») : le plus long d'abord, rien ne reste à moitié.
  assert.equal(env.session.withoutModelNames("model 'qwen3.5:9b' / qwen3.5", ['qwen3.5:9b', 'qwen3.5:4b'], ['qwen3.5:9b', 'qwen3.5:4b']), "model 'Modèle A' / …")
  // Un nom sans tag (« :latest » ajouté par Ollama) et un import hf.co/ (deux « : » possibles dans le nom).
  assert.equal(env.session.withoutModelNames("model 'phi4-mini:latest'", ['phi4-mini', 'x:1b'], ['x:1b', 'phi4-mini']), "model 'Modèle B'")
  assert.equal(
    env.session.withoutModelNames('hf.co/ggml-org/GLM-4.6V-Flash-GGUF:Q4_K_M a échoué', ['hf.co/ggml-org/GLM-4.6V-Flash-GGUF:Q4_K_M', 'y:2b'], ['hf.co/ggml-org/GLM-4.6V-Flash-GGUF:Q4_K_M', 'y:2b']),
    'Modèle A a échoué'
  )
})

test('un téléchargement impossible retire le modèle sans le nommer ; moins de deux modèles : la session s’arrête', async () => {
  const env = setup({ installed: ['alpha-model:3b', 'bravo-model:8b'], failPull: ['charlie-model:4b'] })
  await readySession(env)
  assert.equal(env.session.getDuelView().dropped, 1)
  assert.equal(env.session.getDuelView().modelCount, 3)
  assertAnonymous(env.emitted, 'modèle retiré')

  const env2 = setup({ installed: ['alpha-model:3b'], failPull: ['bravo-model:8b', 'charlie-model:4b', 'delta-model:7b'] })
  await env2.session.startDuel('conversation', 4)
  await waitFor(() => env2.session.getDuelView()?.phase === 'ended', 'session arrêtée')
  assert.match(env2.session.getDuelView().error, /Moins de deux modèles/)
  assert.equal(env2.session.getDuelView().round, null)
  // Étape 380 : la vraie raison est dite (ici « introuvable »), sans le nom du modèle qui a échoué.
  assert.match(env2.session.getDuelView().error, /Dernière erreur : pull model manifest: … introuvable/)
  assert.match(env.session.getDuelView().dropReason, /introuvable/)
  assertAnonymous(env2.emitted, 'raison d’un téléchargement raté')
})

test('« Arrêter la session » pendant un téléchargement l’arrête, et rien n’est voté', async () => {
  const env = setup({ installed: ['alpha-model:3b'] })
  const release = env.gatePull('bravo-model:8b')
  env.gatePull('charlie-model:4b')
  env.gatePull('delta-model:7b')
  await env.session.startDuel('conversation', 4)
  await waitFor(() => env.calls.pulls.length === 1, 'premier téléchargement')
  const summary = await env.session.endDuel()
  release()
  await tick()
  assert.equal(env.session.getDuelView().phase, 'ended')
  assert.deepEqual(summary.rounds, [])
  assert.deepEqual(summary.changes, [], 'sans vote, le choix de Jaris ne change pas')
  assert.equal(env.votes.length, 0)
  assert.equal(env.calls.pulls.length, 1, 'les téléchargements suivants ne partent pas')
})

test('fin de session : les noms sont révélés, le choix de Jaris suit les votes, seuls les modèles installés sont appliqués', async () => {
  const env = setup({ installed: ['alpha-model:3b', 'bravo-model:8b'] })
  await readySession(env)
  env.session.askDuel('Ouvre le Bloc-notes')
  await waitFor(() => env.session.getDuelView().round.a.status === 'done', 'A')
  env.session.runDuelB()
  await waitFor(() => env.session.getDuelView().round.b.status === 'done', 'B')
  await env.session.voteDuel('b')
  const summary = await env.session.endDuel()
  assert.equal(summary.rounds.length, 1)
  assert.ok(MODELS.includes(summary.rounds[0].modelA), 'les noms sont donnés à la fin')
  // pickModelsForDuelCategory : Faible et Moyen passent à charlie (installé par la session), Élevé ne change pas.
  assert.deepEqual(
    summary.changes.map((c) => [c.role, c.from, c.to, c.applied]),
    [
      ['flash', 'alpha-model:3b', 'charlie-model:4b', true],
      ['medium', 'alpha-model:3b', 'charlie-model:4b', true]
    ]
  )
  assert.deepEqual(env.profile.models, { flash: 'charlie-model:4b', medium: 'charlie-model:4b', large: 'bravo-model:8b' })
  assert.equal(env.profile.voiceModels, undefined, 'un duel Conversation ne touche pas aux modèles de la voix')
  // Téléchargés pour la session : charlie est maintenant utilisé (jamais proposé à la suppression), delta non.
  assert.deepEqual(
    summary.downloaded.map((d) => [d.model, d.inUse]).sort(),
    [
      ['charlie-model:4b', true],
      ['delta-model:7b', false]
    ]
  )
})

test('suppression : seulement les modèles téléchargés par la session et dont Jaris ne se sert pas', async () => {
  const env = setup({ installed: ['alpha-model:3b', 'bravo-model:8b'] })
  await readySession(env)
  await assert.rejects(env.session.deleteDuelModels(['delta-model:7b']), /Aucune session/, 'pas pendant la session')
  await env.session.endDuel()
  const result = await env.session.deleteDuelModels(['delta-model:7b', 'alpha-model:3b', 'bravo-model:8b', 'inconnu:1b'])
  assert.deepEqual(result.deleted, ['delta-model:7b'], 'les autres sont à Léo ou utilisés : jamais effacés')
  assert.deepEqual(env.calls.deleted, ['delta-model:7b'])
  env.session.closeDuel()
  assert.equal(env.session.getDuelView(), null)
})

test('duel Vocal : la réponse est écrite pour la voix, lue, et une voix en panne n’efface jamais la réponse', async () => {
  const env = setup({ installed: MODELS })
  await env.session.startDuel('voice', 4)
  await waitFor(() => env.session.getDuelView()?.phase === 'ready', 'prête')
  env.session.askDuel('Quel temps fera-t-il demain ?')
  await waitFor(() => env.session.getDuelView().round.a.status === 'done', 'A')
  assert.equal(env.calls.converse[0][7], 'voice', 'canal voix : pas de listes ni de gras')
  assert.equal(env.session.getDuelView().round.a.audio, true)
  assert.ok(env.session.duelAudio('a') instanceof Uint8Array)
  assert.equal(env.session.duelAudio('b'), null)

  const broken = setup({ installed: MODELS, ttsFails: true })
  await broken.session.startDuel('voice', 4)
  await waitFor(() => broken.session.getDuelView()?.phase === 'ready', 'prête')
  broken.session.askDuel('Bonjour')
  await waitFor(() => broken.session.getDuelView().round.a.status === 'done', 'A')
  const a = broken.session.getDuelView().round.a
  assert.equal(a.text, 'C’est ouvert.')
  assert.equal(a.audio, false)
  assert.equal(a.audioError, 'voix indisponible')
})

test('duel Vocal terminé : seuls les modèles de la VOIX changent, ceux du Chat restent', async () => {
  const env = setup({ installed: MODELS })
  await env.session.startDuel('voice', 4)
  await waitFor(() => env.session.getDuelView()?.phase === 'ready', 'prête')
  env.session.askDuel('Bonjour')
  await waitFor(() => env.session.getDuelView().round.a.status === 'done', 'A')
  env.session.runDuelB()
  await waitFor(() => env.session.getDuelView().round.b.status === 'done', 'B')
  await env.session.voteDuel('tie')
  await env.session.endDuel()
  assert.deepEqual(env.profile.models, { flash: 'alpha-model:3b', medium: 'alpha-model:3b', large: 'bravo-model:8b' })
  assert.deepEqual(env.profile.voiceModels, { flash: 'charlie-model:4b', medium: 'charlie-model:4b', large: 'bravo-model:8b' })
})

test('duel Code : l’application est écrite par CE modèle, montrée dans l’aperçu, jamais rangée dans « Tes applications »', async () => {
  const env = setup({ installed: MODELS })
  await env.session.startDuel('code', 4)
  await waitFor(() => env.session.getDuelView()?.phase === 'ready', 'prête')
  env.session.askDuel('Un jeu du serpent')
  await waitFor(() => env.session.getDuelView().round.a.status === 'done', 'A')
  const call = env.calls.generate[0]
  assert.ok(MODELS.includes(call.options.model))
  assert.equal(call.options.persist, false)
  assert.match(env.session.getDuelView().round.a.previewUrl, /^jaris-preview:/)
  // Étape 364 : le code de A se lit une fois A fini ; B n'a encore rien écrit.
  assert.ok(env.session.duelSideCode('a').startsWith('<html>'))
  assert.equal(env.session.duelSideCode('b'), null)
  assert.equal(JSON.stringify(env.session.getDuelView()).includes('<html>'), false, 'le code ne voyage pas avec chaque mise à jour')
  // Étape 365 : pendant la génération, l'écran reçoit l'étape et les compteurs — jamais le texte de la réflexion.
  const live = env.emitted.map((v) => v?.round?.a?.activity).find((activity) => activity?.code)
  assert.deepEqual(
    { kind: live?.kind, ...live?.code },
    { kind: 'thinking', step: 1, steps: 2, charsWritten: 0, thinkingChars: 12400, idleMs: 0, elapsedMs: 1000 }
  )
  assert.equal(JSON.stringify(env.emitted).includes('je réfléchis'), false, 'la réflexion pourrait nommer le modèle')
  env.session.runDuelB()
  await waitFor(() => env.session.getDuelView().round.b.status === 'done', 'B')
  await env.session.voteDuel('a')
  const summary = await env.session.endDuel()
  assert.deepEqual(summary.changes.map((c) => [c.role, c.to, c.applied]), [['code', 'delta-model:7b', true]])
  assert.equal(env.profile.codeModel, 'delta-model:7b')
})

test('une seule session à la fois, et une catégorie ou une taille venues de l’écran sont revérifiées par main.ts', async () => {
  const env = setup({ installed: MODELS })
  await readySession(env)
  await assert.rejects(env.session.startDuel('code', 4), /déjà en cours/)
  const { readFileSync } = await import('node:fs')
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
  assert.match(main, /if \(!isDuelCategory\(value\)\) throw new Error/)
  assert.match(main, /pick < 2 \|\| pick > 6\) throw new Error/)
  assert.match(main, /pick\.length > 200 \|\| !pick\.every/)
  assert.match(main, /if \(!isDuelOutcome\(outcome\)\) throw new Error/)
  // Un duel s'arrête avec Jaris et avant un « Déplacer » (les modèles écrivent sur le PC, un téléchargement remplit le disque).
  assert.equal((main.match(/abortDuel\(\)/g) ?? []).length, 2)
})

/** Un modèle qui cherche sur internet ; la recherche de JARIS échoue (moteur bloqué), comme assistant.ts le signale. */
function searchFails() {
  return async (...args) => {
    const onLog = args[3]
    const restrictions = args.at(-1)
    onLog?.('Outil appelé : search_web({"query":"météo Lyon"})')
    const err = new Error('Recherche impossible : DuckDuckGo a demandé une vérification anti-robot (modèle alpha-model:3b).')
    restrictions.onToolFailure?.('search_web', err)
    onLog?.(`Résultat de l'outil : Échec de l'outil : ${err.message}`)
    return `Échec de l'outil : ${err.message}`
  }
}

test('un outil de JARIS qui échoue (recherche bloquée) : pas la faute du modèle, le duel ne peut pas être voté', async () => {
  let failing = true
  const env = setup({
    installed: MODELS,
    converseImpl: (...args) => (failing ? searchFails()(...args) : defaultConverse(...args))
  })
  await readySession(env)
  env.session.askDuel('Quel temps fera-t-il demain ?')
  await waitFor(() => env.session.getDuelView().round.a.status === 'done', 'A a fini')
  const a = env.session.getDuelView().round.a
  assert.equal(a.trouble.tool, 'search_web')
  assert.ok(!/qwen3\.5|alpha|bravo|charlie|delta/.test(a.trouble.message), 'le message ne nomme aucun modèle')
  assertAnonymous(env.emitted, 'avec un outil en panne')
  // B ne peut pas départager un duel déjà gâché, et aucun vote n'est accepté.
  await assert.rejects(env.session.voteDuel('b'), /un outil de Jaris a échoué/)
  assert.equal(env.votes.length, 0)

  // Rejouer : même paire, même demande, A recommence (la panne est réglée).
  const before = env.session.getDuelView().round
  const pairBefore = env.calls.converse.length
  failing = false
  env.session.retryDuel()
  await waitFor(() => env.session.getDuelView().round.a.status === 'done', 'A rejoué')
  const after = env.session.getDuelView().round
  assert.equal(after.number, before.number)
  assert.equal(after.prompt, before.prompt)
  assert.equal(after.a.trouble, null)
  assert.equal(env.calls.converse[pairBefore].at(-1).model, env.calls.converse[0].at(-1).model, 'le même modèle A')
  env.session.runDuelB()
  await waitFor(() => env.session.getDuelView().round.b.status === 'done', 'B')
  await env.session.voteDuel('a')
  assert.equal(env.votes.length, 1)
})

test('passer un duel gâché : aucun vote, la paire n’est pas comptée comme jouée, un autre duel commence', async () => {
  const env = setup({ installed: MODELS, converseImpl: searchFails() })
  await readySession(env)
  env.session.askDuel('Quel temps fera-t-il demain ?')
  await waitFor(() => env.session.getDuelView().round.a.status === 'done', 'A a fini')
  // Sans panne de Jaris, « passer » est refusé (on vote).
  env.session.skipDuel()
  const view = env.session.getDuelView()
  assert.equal(view.round.prompt, null, 'nouveau duel')
  assert.equal(view.votes, 0)
  assert.equal(env.votes.length, 0)
})

test('rejouer ou passer sans panne de Jaris est refusé : un mauvais modèle ne s’efface pas', async () => {
  const env = setup({ installed: MODELS })
  await readySession(env)
  env.session.askDuel('Ouvre le Bloc-notes')
  await waitFor(() => env.session.getDuelView().round.a.status === 'done', 'A a fini')
  assert.throws(() => env.session.retryDuel(), /invalide/)
  assert.throws(() => env.session.skipDuel(), /invalide/)
})

test('une page web « introuvable » (adresse inventée) ou une application inconnue restent la faute du modèle', () => {
  assert.equal(duelModule.isJarisToolFailure('read_web_page', 'PageHttpError'), false)
  assert.equal(duelModule.isJarisToolFailure('read_web_page', 'Error'), true)
  assert.equal(duelModule.isJarisToolFailure('search_web', 'Error'), true)
  assert.equal(duelModule.isJarisToolFailure('look_at_screen', 'Error'), true)
  assert.equal(duelModule.isJarisToolFailure('open_app', 'Error'), false)
  assert.equal(duelModule.isJarisToolFailure('type_text', 'Error'), false)
})

test('historique : chaque vote garde les deux réponses et ce qu’elles ont fait, avec les noms révélés au vote', async () => {
  const env = setup({ installed: MODELS })
  await readySession(env)
  env.session.askDuel('Ouvre le Bloc-notes')
  await waitFor(() => env.session.getDuelView().round.a.status === 'done', 'A')
  env.session.runDuelB()
  await waitFor(() => env.session.getDuelView().round.b.status === 'done', 'B')
  await env.session.voteDuel('b')
  const stored = env.votes[0].sides
  assert.equal(stored.a.text, 'C’est ouvert.')
  assert.deepEqual(stored.b.actions, [{ tool: 'open_app', detail: 'Bloc-notes' }])
  assert.ok(stored.a.durationMs >= 0)
  assert.equal(stored.a.app, false)

  // Étape 358 : les noms sont révélés dès le vote, l'historique les montre donc aussi pendant la session.
  const after = env.session.duelHistory()
  assert.equal(after.length, 1)
  assert.ok(MODELS.includes(after[0].modelA) && MODELS.includes(after[0].modelB), 'noms révélés dès le vote')
  assert.equal(after[0].sides.b.text, 'C’est ouvert.')
})

test('historique Code : l’application de chaque côté est gardée et se rouvre dans l’aperçu isolé', async () => {
  const env = setup({ installed: MODELS })
  await env.session.startDuel('code', 4)
  await waitFor(() => env.session.getDuelView()?.phase === 'ready', 'prête')
  env.session.askDuel('Un jeu du serpent')
  await waitFor(() => env.session.getDuelView().round.a.status === 'done', 'A')
  env.session.runDuelB()
  await waitFor(() => env.session.getDuelView().round.b.status === 'done', 'B')
  await env.session.voteDuel('a')
  const id = env.votes[0].id
  assert.equal(env.votes[0].sides.a.app, true)
  assert.ok(env.apps.get(`${id}-a`).startsWith('<html>'))
  assert.match(await env.session.duelHistoryApp(id, 'a'), /^jaris-preview:/)
  assert.equal(await env.session.duelHistoryApp('inconnu', 'a'), null, 'un identifiant qui n’est pas un vote : rien')
  assert.ok((await env.session.duelHistoryCode(id, 'a')).startsWith('<html>'))
  assert.equal(await env.session.duelHistoryCode('inconnu', 'a'), null)
})

test('étape 363 : le plan montre TOUS les modèles, ceux que le PC ne peut pas faire tourner avec leur raison', async () => {
  const env = setup({ installed: ['alpha-model:3b'] })
  const plan = await env.session.planDuel('conversation')
  assert.equal(plan.models.length, MODELS.length + 1)
  const big = plan.models.find((m) => m.model === 'echo-model:70b')
  assert.equal(big.reason.kind, 'tooBig')
  assert.equal(plan.models.find((m) => m.model === 'alpha-model:3b').installed, true)
  assert.equal(plan.models.find((m) => m.model === 'bravo-model:8b').installed, false)
  assert.equal(plan.downloadBudgetGb, 95)
})

test('étape 363 : modèles choisis à la main — exactement ceux-là, au moins 4, jamais un modèle indisponible ou inventé', async () => {
  const env = setup({ installed: [] })
  await assert.rejects(env.session.startDuel('conversation', MODELS.slice(0, 3)), /au moins 4/)
  await assert.rejects(env.session.startDuel('conversation', [...MODELS.slice(0, 3), 'echo-model:70b']), /ne peut pas faire de duel/)
  await assert.rejects(env.session.startDuel('conversation', [...MODELS.slice(0, 3), 'inventé:1b']), /ne peut pas faire de duel/)
  // Un doublon ne compte qu'une fois.
  await assert.rejects(env.session.startDuel('conversation', [...MODELS.slice(0, 3), MODELS[0]]), /au moins 4/)
  const started = await env.session.startDuel('conversation', [...MODELS].reverse())
  assertAnonymous([started], 'session choisie')
  await waitFor(() => env.session.getDuelView()?.phase === 'ready', 'session prête')
  // Exactement les modèles choisis : ce sont eux qui sont téléchargés, aucun autre.
  assert.deepEqual([...env.calls.pulls].sort(), [...MODELS].sort())
})

test('étape 363 : un modèle choisi et absent est téléchargé, sans jamais envoyer son nom à l’écran', async () => {
  const env = setup({ installed: MODELS.slice(0, 3) })
  await env.session.startDuel('conversation', MODELS)
  await waitFor(() => env.session.getDuelView()?.phase === 'ready', 'session prête')
  assert.deepEqual(env.calls.pulls, [MODELS[3]])
  // Étape 365 (Léo : « je choisis 7 modèles, ça met téléchargement des 5 ») : l'écran sait combien sont déjà là.
  const preparing = env.emitted.filter((v) => v?.preparing).map((v) => v.preparing)
  assert.ok(preparing.length > 0)
  assert.ok(preparing.every((p) => p.total === 1 && p.installed === 3), JSON.stringify(preparing))
  assertAnonymous(env.emitted, 'téléchargement')
})

test('étape 365 : en duel, tous les modèles reçoivent « moyen », traduit dans leurs propres réglages', async () => {
  // Conversation : la réflexion part avec les restrictions du duel, et l'emporte sur le palier de la question.
  const env = setup({ installed: MODELS })
  await env.session.startDuel('conversation', MODELS)
  await waitFor(() => env.session.getDuelView()?.phase === 'ready', 'prête')
  for (let i = 0; i < 2; i++) {
    env.session.askDuel(`Question ${i}`)
    await waitFor(() => env.session.getDuelView().round.a.status === 'done', 'A')
    env.session.runDuelB()
    await waitFor(() => env.session.getDuelView().round.b.status === 'done', 'B')
    await env.session.voteDuel('tie')
    env.session.nextDuel()
  }
  assert.equal(env.calls.converse.length, 4)
  for (const args of env.calls.converse) {
    const { model, think } = args[11]
    assert.equal(think, EXPECTED_THINK[model], model)
  }
  // Code : la même règle, passée à la génération de l'application.
  const code = setup({ installed: MODELS })
  await code.session.startDuel('code', MODELS)
  await waitFor(() => code.session.getDuelView()?.phase === 'ready', 'prête')
  code.session.askDuel('Un compteur')
  await waitFor(() => code.session.getDuelView().round.a.status === 'done', 'A')
  code.session.runDuelB()
  await waitFor(() => code.session.getDuelView().round.b.status === 'done', 'B')
  for (const { options } of code.calls.generate) assert.equal(options.think, EXPECTED_THINK[options.model], options.model)
})

test('étape 365 : Ollama ne voit pas les modèles (étapes 289/313) — rien n’est annoncé à télécharger ni proposé à la suppression', async () => {
  // La vue est réparée avant de compter : les 4 modèles choisis sont déjà là, aucun téléchargement annoncé.
  const env = setup({ installed: MODELS, blind: true })
  await env.session.startDuel('conversation', MODELS)
  await waitFor(() => env.session.getDuelView()?.phase === 'ready', 'prête')
  assert.ok(env.calls.repairs >= 1)
  assert.deepEqual(env.calls.pulls, [])
  assert.equal(env.emitted.some((v) => v?.preparing), false)
  // Réparation impossible au départ : les modèles passent par le téléchargement, qui les trouve déjà là — et la fin de
  // session ne les compte JAMAIS comme téléchargés pour elle (sinon proposés à la suppression : des Go qui étaient à Léo).
  const blindToTheEnd = setup({ installed: MODELS, blind: true, repairs: false })
  await blindToTheEnd.session.startDuel('conversation', MODELS)
  await waitFor(() => blindToTheEnd.session.getDuelView()?.phase === 'ready', 'prête')
  assert.equal(blindToTheEnd.calls.pulls.length, 4)
  const summary = await blindToTheEnd.session.endDuel()
  assert.deepEqual(summary.downloaded, [])
  const result = await blindToTheEnd.session.deleteDuelModels(MODELS)
  assert.deepEqual(result.deleted, [])
  assert.deepEqual(blindToTheEnd.calls.deleted, [])
})

/**
 * Étape 366 (capture de Léo, PC sans carte graphique) : un modèle a voulu dessiner, Jaris a répondu « ton PC n'a pas
 * assez de puissance », et le duel est devenu impossible à voter — « Rejouer » refaisait la même chose. Un outil que CE
 * PC ne peut jamais faire tourner n'est plus proposé, et le demander quand même est le choix du modèle.
 */
test('étape 366 : sur un PC qui ne peut pas dessiner, le dessin n’est pas proposé, et le demander quand même se vote', async () => {
  const env = setup({
    installed: [...MODELS, 'vision-model:8b'],
    canDraw: false,
    converseImpl: async (_prompt, _name, _onReminder, onLog, _history, _signal, _live, _channel, onToken, _onImage, _onWeb, restrictions) => {
      // Comme le vrai converse() : l'outil non proposé est annoncé, puis refusé sans être exécuté (jamais onToolFailure).
      onLog?.('Outil appelé : generate_image({"prompt":"A colorful slither.io game board"})')
      const refusal = restrictions.refusalFor('generate_image')
      onToken?.(refusal)
      return refusal
    }
  })
  await readySession(env)
  env.session.askDuel('Fais un jeu style slither.io')
  await waitFor(() => env.session.getDuelView().round.a.status === 'done', 'A a fini')
  env.session.runDuelB()
  await waitFor(() => env.session.getDuelView().round.b.status === 'done', 'B a fini')
  const [a, b] = env.calls.converse.map((args) => args[11])
  for (const restrictions of [a, b]) {
    assert.equal(restrictions.allowedTools.has('generate_image'), false, 'ce PC ne dessine pas : outil pas proposé')
    assert.equal(restrictions.allowedTools.has('look_at_screen'), true, 'le modèle de vision est installé')
    assert.equal(restrictions.allowedTools.has('shutdown_pc'), false)
    assert.equal(restrictions.refusalFor('generate_image'), 'Cet outil n’est pas disponible sur ce PC.'.replace('’', "'"))
    assert.match(restrictions.refusalFor('shutdown_pc'), /bloqué pendant un duel/)
  }
  assert.deepEqual([...a.allowedTools].sort(), [...b.allowedTools].sort(), 'A et B ont exactement les mêmes outils')
  assert.equal(env.calls.drawChecks, 1, 'lu une fois par duel, gardé pour B')
  const round = env.session.getDuelView().round
  assert.equal(round.a.trouble, null, 'pas une panne de Jaris : le modèle a choisi un outil absent')
  assert.equal(round.b.trouble, null)
  assert.equal(round.a.actions[0].tool, 'generate_image', 'Léo voit ce que le modèle a voulu faire')
  await env.session.voteDuel('a')
  assert.equal(env.votes.length, 1, 'le duel se vote')
})

test('étape 366 : PC qui dessine mais sans modèle de vision — dessin proposé, regarder l’écran non', async () => {
  const env = setup({ installed: MODELS, canDraw: true })
  await readySession(env)
  env.session.askDuel('Dessine un chat')
  await waitFor(() => env.session.getDuelView().round.a.status === 'done', 'A a fini')
  const restrictions = env.calls.converse[0][11]
  assert.equal(restrictions.allowedTools.has('generate_image'), true)
  assert.equal(restrictions.allowedTools.has('look_at_screen'), false)
  assert.equal(restrictions.allowedTools.has('computer_use_task'), false)
  assert.equal(restrictions.allowedTools.has('open_app'), true)
})


test('étape 379 : en Code, avec assez de mémoire pour les deux, A et B écrivent EN MÊME TEMPS ; « Arrêter » arrête les deux', async () => {
  let release
  const gate = { promise: new Promise((resolve) => (release = resolve)) }
  const env = setup({ installed: MODELS, vramGb: 80, generateGate: gate })
  await env.session.startDuel('code', 4)
  await waitFor(() => env.session.getDuelView()?.phase === 'ready', 'session prête')
  assert.equal(env.session.getDuelView().round.together, true)
  const asked = env.session.askDuel('Un compteur')
  assert.equal(asked.round.a.status, 'running')
  assert.equal(asked.round.b.status, 'running', 'B n’attend pas A')
  await waitFor(() => env.calls.generate.length === 2, 'les deux générations lancées')
  assert.notEqual(env.calls.generate[0].options.model, env.calls.generate[1].options.model, 'chacun son modèle')
  assert.throws(() => env.session.runDuelB(), /finir/i, 'pas de second lancement de B')
  env.session.stopDuelRun()
  release()
  await waitFor(() => ['a', 'b'].every((s) => env.session.getDuelView().round[s].status === 'stopped'), 'les deux arrêtés')
  assertAnonymous(env.emitted, 'duel en parallèle')
})

test('étape 379 : en Code sans assez de mémoire, ou en Conversation même avec beaucoup de mémoire, B attend A', async () => {
  const small = setup({ installed: MODELS, vramGb: 8 })
  await small.session.startDuel('code', 4)
  await waitFor(() => small.session.getDuelView()?.phase === 'ready', 'session prête')
  assert.equal(small.session.getDuelView().round.together, false)
  const smallAsked = small.session.askDuel('Un compteur')
  assert.equal(smallAsked.round.b.status, 'idle')
  // En Conversation, les modèles agissent sur le PC : jamais deux à la fois, quelle que soit la carte.
  const big = setup({ installed: MODELS, vramGb: 288 })
  await readySession(big)
  assert.equal(big.session.getDuelView().round.together, false)
  assert.equal(big.session.askDuel('Ouvre le Bloc-notes').round.b.status, 'idle')
  await waitFor(() => big.session.getDuelView().round.a.status === 'done', 'A a fini')
  assert.equal(big.calls.converse.length, 1, 'B n’a pas commencé')
})

async function readyCode(env) {
  await env.session.startDuel('code', 4)
  await waitFor(() => env.session.getDuelView()?.phase === 'ready', 'session prête')
}

const running = (view) => view.batch.flatMap((r) => [r.a, r.b]).filter((s) => s === 'running').length

test('étape 381 : 6 demandes d’un coup — au plus 4 générations à la fois sur une grosse carte, puis vote duel par duel', async () => {
  let release
  const gate = { promise: new Promise((resolve) => (release = resolve)) }
  const env = setup({ installed: MODELS, vramGb: 80, generateGate: gate })
  await readyCode(env)
  const prompts = ['Un compteur', 'Une horloge', 'Un morpion', 'Un pendu', 'Un minuteur', 'Un dé']
  const started = env.session.startDuelBatch(prompts)
  assert.equal(started.round, null, 'Léo regarde la liste')
  assert.deepEqual(started.batch.map((r) => r.prompt), prompts)
  assert.equal(running(started), 4, 'quatre générations en même temps, pas plus')
  for (const r of started.batch) assert.notEqual(r.a, undefined)
  release()
  await waitFor(() => env.session.getDuelView().batch.every((r) => r.a === 'done' && r.b === 'done'), 'tous les duels finis')
  assert.equal(env.calls.generate.length, 12, 'deux générations par demande')
  assert.equal(env.votes.length, 0, 'rien n’est voté tout seul')
  assertAnonymous(env.emitted, 'file avant les votes')
  // Les paires varient, jamais la même deux fois d'affilée.
  const pairs = env.calls.generate.reduce((byPrompt, g) => ({ ...byPrompt, [g.prompt]: [...(byPrompt[g.prompt] ?? []), g.options.model] }), {})
  const keys = prompts.map((p) => [...pairs[p]].sort().join('|'))
  for (let i = 1; i < keys.length; i++) assert.notEqual(keys[i], keys[i - 1], 'deux duels de suite avec la même paire')

  for (const [index, item] of env.session.getDuelView().batch.entries()) {
    const opened = env.session.openBatchRound(item.number)
    assert.equal(opened.round.prompt, prompts[index])
    const voted = await env.session.voteDuel('a')
    assert.ok(voted.round.revealed, 'noms révélés après le vote')
    const back = env.session.nextDuel()
    if (index < prompts.length - 1) {
      assert.equal(back.round, null, 'retour à la liste')
      assert.equal(back.batch.filter((r) => r.revealed).length, index + 1)
    } else {
      assert.equal(back.batch, null, 'tout est voté : fin de la file')
      assert.equal(back.round.prompt, null, 'un duel ordinaire attend sa demande')
    }
  }
  assert.equal(env.votes.length, 6)
  assert.deepEqual(env.votes.map((v) => v.prompt), prompts)
})

test('étape 381 : sur une petite carte, un seul modèle à la fois — la file avance quand même jusqu’au bout', async () => {
  const env = setup({ installed: MODELS, vramGb: 8 })
  await readyCode(env)
  const started = env.session.startDuelBatch(['Un compteur', 'Une horloge'])
  assert.equal(running(started), 1, 'un seul à la fois')
  await waitFor(() => env.session.getDuelView().batch.every((r) => r.a === 'done' && r.b === 'done'), 'tout fini')
  // Jamais deux modèles DIFFÉRENTS à la fois sur 8 Go. Deux côtés du même modèle peuvent tourner ensemble (Ollama ne le
  // charge qu'une fois) : compter les côtés en cours rendait ce test aléatoire, selon les paires tirées.
  assert.equal(env.calls.mostModels, 1, 'jamais deux modèles à la fois sur 8 Go')
  // B ne se lance pas à la main dans une file : c'est Jaris qui le fait.
  env.session.openBatchRound(env.session.getDuelView().batch[0].number)
  assert.throws(() => env.session.runDuelB())
})

test('étape 381 : « Tout arrêter » retire ce qui n’est pas fini, garde ce qui est prêt pour le vote', async () => {
  let release
  const gate = { promise: new Promise((resolve) => (release = resolve)) }
  const env = setup({ installed: MODELS, vramGb: 80, generateGate: gate })
  await readyCode(env)
  env.session.startDuelBatch(['Un', 'Deux', 'Trois', 'Quatre'])
  env.session.stopDuelRun()
  release()
  // Tout tournait ou attendait : rien n'est prêt, la file disparaît et un duel ordinaire reprend.
  await waitFor(() => env.session.getDuelView().batch === null, 'file vidée')
  const view = env.session.getDuelView()
  assert.equal(view.round.prompt, null)
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.ok(env.calls.generate.length <= 4, 'les demandes qui attendaient ne partent jamais')
  assert.equal(env.votes.length, 0)
})

test('étape 381 : arrêter un duel ouvert de la file n’arrête que lui ; les autres continuent', async () => {
  const env = setup({ installed: MODELS, vramGb: 80 })
  await readyCode(env)
  const started = env.session.startDuelBatch(['Un', 'Deux'])
  env.session.openBatchRound(started.batch[0].number)
  env.session.stopDuelRun()
  const after = env.session.getDuelView()
  assert.equal(after.round, null, 'retour à la liste')
  assert.deepEqual(after.batch.map((r) => r.prompt), ['Deux'])
  await waitFor(() => env.session.getDuelView().batch[0].a === 'done' && env.session.getDuelView().batch[0].b === 'done', 'l’autre a fini')
})

test('étape 381 : refusé en Conversation, sous 2 ou au-delà de 12 demandes, ou pendant une file', async () => {
  const conv = setup({ installed: MODELS, vramGb: 80 })
  await readySession(conv)
  assert.throws(() => conv.session.startDuelBatch(['Un', 'Deux']), /Code/)
  const env = setup({ installed: MODELS, vramGb: 80 })
  await readyCode(env)
  assert.throws(() => env.session.startDuelBatch(['Un', '   ']), /entre 2 et 12/)
  assert.throws(() => env.session.startDuelBatch(Array.from({ length: 13 }, (_, i) => `D${i}`)), /entre 2 et 12/)
  env.session.startDuelBatch(['Un', 'Deux'])
  assert.throws(() => env.session.startDuelBatch(['Trois', 'Quatre']))
})

// --- Étape 382 : la série de duels Code ---------------------------------------------------------------------------

/** Les modèles réellement utilisés par chaque génération, dans l'ordre. */
const generatedModels = (env) => env.calls.generate.map((g) => g.options.model)
const seriesDone = (env) => {
  const view = env.session.getDuelView()
  return Boolean(view?.batch?.length) && view.batch.every((r) => ['done', 'error'].includes(r.a) && ['done', 'error'].includes(r.b)) && !view.series?.active
}
const CODE_IDEAS = new Set(Array.from({ length: duelModule.DUEL_CODE_IDEAS }, (_, i) => i18nModules()['../../shared/i18n'].t(`duel.suggest.code.${i + 1}`)))

test('étape 382 : la série — chaque modèle au moins N duels, chaque modèle téléchargé une fois puis supprimé après son dernier duel', async () => {
  // Aucun modèle dont Jaris se sert parmi ceux de la série : tous peuvent être supprimés.
  const env = setup({ category: 'code', vramGb: 8, profile: { name: 'Léo' } })
  env.session.setDuelSeriesDelays({ idleCheckMs: 20 })
  const started = await env.session.startDuel('code', 4, 3)
  assert.equal(started.phase, 'ready')
  assert.ok(started.batch.length >= 6, 'au moins 4 × 3 / 2 duels')
  for (const item of started.batch) assert.ok(CODE_IDEAS.has(item.prompt), `une idée de la liste : ${item.prompt}`)
  await waitFor(() => seriesDone(env), 'la série a fini de tourner')
  const view = env.session.getDuelView()
  assert.equal(view.batch.filter((r) => r.a === 'error' || r.b === 'error').length, 0)
  // Jamais une génération lancée avant que son modèle soit sur le disque.
  assert.equal(env.calls.notInstalled ?? 0, 0)
  // Au moins 3 duels par modèle.
  const counts = new Map()
  for (const model of generatedModels(env)) counts.set(model, (counts.get(model) ?? 0) + 1)
  for (const model of MODELS) assert.ok((counts.get(model) ?? 0) >= 3, `${model} : ${counts.get(model)} duels`)
  // Chaque modèle téléchargé UNE fois, supprimé ensuite, et plus jamais utilisé après sa suppression.
  assert.deepEqual([...env.calls.pulls].sort(), [...MODELS].sort())
  assert.deepEqual([...env.calls.deleted].sort(), [...MODELS].sort())
  assert.equal(view.series.deleted, 4)
  // Le PC reste éveillé pendant la série, plus après.
  assert.deepEqual(env.calls.awake, [true, false])
  // Anonymat : aucun nom de modèle n'est parti vers l'écran.
  const sent = JSON.stringify(env.emitted)
  for (const model of MODELS) assert.ok(!sent.includes(model), `nom envoyé à l'écran : ${model}`)
  // Gardée sur le disque à chaque étape.
  assert.ok(env.seriesStore.snapshot.rounds.length === view.batch.length)
  assert.ok(env.seriesStore.apps.size >= view.batch.length * 2 - 1)
})

test('étape 385 : série sur une grosse carte — plusieurs modèles en même temps, 4 duels au plus par modèle, chacun téléchargé une fois', async () => {
  let release
  const gate = { promise: new Promise((resolve) => (release = resolve)) }
  const env = setup({ category: 'code', vramGb: 140, profile: { name: 'Léo' }, generateGate: gate })
  env.session.setDuelSeriesDelays({ idleCheckMs: 20 })
  let mostPerModel = 0
  const gen = env.calls.generate
  const pushGen = gen.push.bind(gen)
  gen.push = (entry) => {
    const n = pushGen(entry)
    mostPerModel = Math.max(mostPerModel, (env.calls.active.get(entry.options.model) ?? 0) + 1)
    return n
  }
  await env.session.startDuel('code', 4, 10)
  // Les générations attendent : le gardien a le temps de télécharger les autres modèles, qui démarrent à leur tour.
  await waitFor(() => env.calls.active.size === MODELS.length, 'les 4 modèles tournent ensemble')
  release()
  await waitFor(() => seriesDone(env), 'la série a fini de tourner')
  assert.ok(mostPerModel <= 4, `${mostPerModel} duels à la fois pour un même modèle`)
  assert.equal(env.session.getDuelView().batch.filter((r) => r.a === 'error' || r.b === 'error').length, 0)
  assert.equal(env.calls.notInstalled ?? 0, 0)
  assert.deepEqual([...env.calls.pulls].sort(), [...MODELS].sort())
  assert.deepEqual([...env.calls.deleted].sort(), [...MODELS].sort())
})

test('étape 382 : un modèle supprimé n’est plus jamais utilisé après, ni retéléchargé', async () => {
  const order = []
  const env = setup({ category: 'code', vramGb: 8, profile: { name: 'Léo' } })
  env.session.setDuelSeriesDelays({ idleCheckMs: 20 })
  const deleteModel = env.calls.deleted
  const pushed = deleteModel.push.bind(deleteModel)
  deleteModel.push = (model) => {
    order.push(['delete', model])
    return pushed(model)
  }
  const gen = env.calls.generate
  const pushGen = gen.push.bind(gen)
  gen.push = (entry) => {
    order.push(['use', entry.options.model])
    return pushGen(entry)
  }
  await env.session.startDuel('code', 4, 4)
  await waitFor(() => seriesDone(env), 'la série a fini de tourner')
  for (const model of MODELS) {
    const deletedAt = order.findIndex(([kind, m]) => kind === 'delete' && m === model)
    assert.ok(deletedAt >= 0, `${model} supprimé`)
    assert.ok(!order.slice(deletedAt).some(([kind, m]) => kind === 'use' && m === model), `${model} utilisé après sa suppression`)
  }
  assert.equal(env.calls.pulls.length, 4)
})

test('étape 382 : un modèle dont Jaris se sert, ou déjà sur le PC, n’est jamais supprimé', async () => {
  const env = setup({ category: 'code', vramGb: 8, installed: ['charlie-model:4b'] })
  env.session.setDuelSeriesDelays({ idleCheckMs: 20 })
  await env.session.startDuel('code', 4, 2)
  await waitFor(() => seriesDone(env), 'la série a fini de tourner')
  // alpha et bravo servent à Jaris (profil), charlie était déjà là : seul delta part.
  assert.deepEqual(env.calls.deleted, ['delta-model:7b'])
  assert.ok(!env.calls.pulls.includes('charlie-model:4b') || env.installed.includes('charlie-model:4b'))
})

test('étape 382 : disque limité — jamais plus de modèles téléchargés qu’il n’en tient, et aucun duel abandonné', async () => {
  const sizes = Object.fromEntries(MODELS.map((m) => [m, 10]))
  // 5 Go de marge : 25 Go utilisables, soit 2 modèles de 10 Go à la fois.
  const env = setup({ category: 'code', vramGb: 8, profile: { name: 'Léo' }, sizes, freeDiskGb: 30 })
  env.session.setDuelSeriesDelays({ idleCheckMs: 20 })
  let most = 0
  const pulls = env.calls.pulls
  const push = pulls.push.bind(pulls)
  pulls.push = (model) => {
    most = Math.max(most, env.installed.length + 1)
    return push(model)
  }
  await env.session.startDuel('code', 4, 3)
  await waitFor(() => seriesDone(env), 'la série a fini de tourner')
  assert.ok(most <= 2, `${most} modèles sur le disque en même temps`)
  assert.equal(env.session.getDuelView().dropped, 0)
  assert.equal(env.session.getDuelView().batch.filter((r) => r.a === 'error' || r.b === 'error').length, 0)
})

test('étape 383 : disque plein sur une machine dont Jaris ne connaît pas la place — la série attend une suppression, puis reprend', async () => {
  const sizes = Object.fromEntries(MODELS.map((m) => [m, 10]))
  // 25 Go sur le « pod » : deux modèles de 10 Go à la fois, pas trois. Jaris ne connaît pas cette place (null).
  const env = setup({ category: 'code', vramGb: 8, profile: { name: 'Léo' }, sizes, podDiskGb: 25 })
  env.session.setDuelSeriesDelays({ idleCheckMs: 20 })
  await env.session.startDuel('code', 4, 3)
  await waitFor(() => seriesDone(env), 'la série a fini de tourner')
  const view = env.session.getDuelView()
  assert.equal(view.dropped, 0, 'aucun modèle abandonné : le disque s’est libéré')
  assert.equal(view.batch.filter((r) => r.a === 'error' || r.b === 'error').length, 0)
  assert.deepEqual([...env.calls.pulled].sort(), [...MODELS].sort(), 'chaque modèle téléchargé une fois au bout du compte')
  assert.ok(env.calls.pulls.length > MODELS.length, 'au moins un téléchargement refusé par le disque, puis refait')
})

test('étape 383 : disque plein et rien à supprimer — les duels du modèle partent, avec une raison claire', async () => {
  const sizes = Object.fromEntries(MODELS.map((m) => [m, 10]))
  const env = setup({ category: 'code', vramGb: 8, profile: { name: 'Léo' }, sizes, podDiskGb: 5 })
  env.session.setDuelSeriesDelays({ idleCheckMs: 20 })
  await env.session.startDuel('code', 4, 2)
  await waitFor(() => !env.session.getDuelView()?.series?.active, 'la série s’arrête au lieu d’attendre sans fin')
  const view = env.session.getDuelView()
  assert.ok(view.dropped > 0)
  assert.equal(view.dropReason, i18nModules()['../../shared/i18n'].t('duel.series.diskFull'))
  assert.equal(env.calls.pulled.length, 0)
})

test('étape 384 : la série déduit les duels déjà votés ; tout est déjà fait → refusée avec une explication', async () => {
  const [first, ...others] = MODELS
  const vote = (a, b) => ({ id: `v-${a}-${b}-${Math.random()}`, category: 'code', at: 0, sessionId: 's', modelA: a, modelB: b, outcome: 'a' })
  // Le premier modèle a déjà 3 duels Code (dont un compté sous « :latest »), un vote Conversation ne compte pas.
  const priorVotes = [vote(first, 'zz:1b'), vote('zz:1b', first), vote(`${first.split(':')[0]}:latest`, 'zz:1b'), { ...vote(others[0], 'zz:1b'), category: 'conversation' }]
  const env = setup({ category: 'code', vramGb: 8, profile: { name: 'Léo' }, priorVotes })
  env.session.setDuelSeriesDelays({ idleCheckMs: 20 })
  const started = await env.session.startDuel('code', [...MODELS], 3)
  assert.ok(started.batch.length > 0)
  await waitFor(() => seriesDone(env), 'la série a fini de tourner')
  const counts = new Map()
  for (const model of generatedModels(env)) counts.set(model, (counts.get(model) ?? 0) + 1)
  for (const m of others) assert.ok((counts.get(m) ?? 0) >= 3, `${m} : ${counts.get(m)}`)
  assert.ok((counts.get(first) ?? 0) < 3, `${first} avait déjà ses 3 duels : ${counts.get(first)} de plus`)

  const full = MODELS.flatMap((a) => MODELS.filter((b) => b !== a).map((b) => vote(a, b)))
  const done = setup({ category: 'code', vramGb: 8, profile: { name: 'Léo' }, priorVotes: full })
  await assert.rejects(() => done.session.startDuel('code', [...MODELS], 3), /déjà 3 duels/)
  assert.equal(done.session.getDuelView(), null, 'aucune session laissée derrière')
})

test('étape 382 : Ollama arrêté en pleine série — rien n’est compté comme une erreur du modèle, tout reprend quand il revient', async () => {
  const env = setup({ category: 'code', vramGb: 8, profile: { name: 'Léo' } })
  env.session.setDuelSeriesDelays({ idleCheckMs: 20, ollamaRetryMs: 30 })
  await env.session.startDuel('code', 4, 2)
  await waitFor(() => env.calls.generate.length >= 1, 'une génération a commencé')
  env.setOllamaDown(true)
  await waitFor(() => env.session.getDuelView().series?.waiting === 'ollama', 'la série attend Ollama')
  env.setOllamaDown(false)
  await waitFor(() => seriesDone(env), 'la série a fini de tourner')
  const view = env.session.getDuelView()
  assert.equal(view.batch.filter((r) => r.a === 'error' || r.b === 'error').length, 0)
  assert.equal(view.series.waiting, null)
})

test('étape 382 : « model not found » — le modèle est retéléchargé et le côté refait, pas compté comme une erreur', async () => {
  let failed = false
  const env = setup({
    category: 'code',
    vramGb: 8,
    profile: { name: 'Léo' },
    generateImpl: (_prompt, options) => {
      if (!failed && options.model === 'alpha-model:3b') {
        failed = true
        throw new Error("model 'alpha-model:3b' not found")
      }
      return { html: `<html><body>${options.model.length}</body></html>`, issues: [], dir: '' }
    }
  })
  env.session.setDuelSeriesDelays({ idleCheckMs: 20 })
  await env.session.startDuel('code', 4, 2)
  await waitFor(() => seriesDone(env), 'la série a fini de tourner')
  assert.ok(failed)
  assert.equal(env.session.getDuelView().batch.filter((r) => r.a === 'error' || r.b === 'error').length, 0)
})

test('étape 382 : Jaris fermé en pleine série, puis rouvert — les duels finis attendent le vote, les autres reprennent', async () => {
  const store = newSeriesStore()
  const first = setup({ category: 'code', vramGb: 8, profile: { name: 'Léo' }, seriesStore: store })
  first.session.setDuelSeriesDelays({ idleCheckMs: 20 })
  const started = await first.session.startDuel('code', 4, 3)
  const total = started.batch.length
  await waitFor(() => first.session.getDuelView().batch.filter((r) => r.a === 'done' && r.b === 'done').length >= 2, 'deux duels finis')
  // Un vote avant de fermer : il ne doit plus être dans la série gardée.
  const ready = first.session.getDuelView().batch.find((r) => r.a === 'done' && r.b === 'done')
  first.session.openBatchRound(ready.number)
  await first.session.voteDuel('a')
  // Gardé tout de suite après le vote, sans attendre la fermeture : une coupure de courant juste après ne le refait pas.
  await waitFor(() => !store.snapshot.rounds.some((r) => r.number === ready.number), 'vote retiré de la série gardée')
  first.session.abortDuel()
  await waitFor(() => !first.session.getDuelView().series?.active, 'série arrêtée')
  const saved = store.snapshot
  assert.ok(saved, 'la série est gardée sur le disque')
  assert.equal(saved.rounds.length, total - 1, 'le duel voté n’y est plus')
  assert.ok(!saved.rounds.some((r) => r.number === ready.number))

  // Nouveau lancement de Jaris, même disque.
  const second = setup({ category: 'code', vramGb: 8, profile: { name: 'Léo' }, seriesStore: store, installed: [...first.installed] })
  second.session.setDuelSeriesDelays({ idleCheckMs: 20 })
  assert.equal(await second.session.restoreDuelSeries(), true)
  const restored = second.session.getDuelView()
  assert.equal(restored.category, 'code')
  assert.equal(restored.batch.length, total - 1)
  const finishedBefore = saved.rounds.filter((r) => r.a.status === 'done' && r.b.status === 'done').map((r) => r.number)
  for (const number of finishedBefore) {
    const item = restored.batch.find((r) => r.number === number)
    assert.equal(item.a, 'done')
    assert.equal(item.b, 'done')
  }
  await waitFor(() => seriesDone(second), 'la série reprise a fini')
  // Seuls les côtés pas encore faits sont refaits (un côté fini garde son application).
  const idleSides = saved.rounds.reduce((sum, r) => sum + (r.a.status === 'idle') + (r.b.status === 'idle'), 0)
  assert.ok(idleSides > 0, 'des côtés restaient à faire')
  assert.equal(second.calls.generate.length, idleSides)
  // Un duel fini avant la fermeture se rouvre avec son application.
  second.session.openBatchRound(finishedBefore[0])
  assert.ok(second.session.getDuelView().round.a.previewUrl)
  assert.ok(second.session.duelSideCode('a'))
})

test('étape 382 : tout voté — la série gardée est effacée ; « Terminer » l’efface aussi', async () => {
  const env = setup({ category: 'code', vramGb: 80, profile: { name: 'Léo' } })
  env.session.setDuelSeriesDelays({ idleCheckMs: 20 })
  await env.session.startDuel('code', 4, 1)
  await waitFor(() => seriesDone(env), 'la série a fini de tourner')
  for (const item of env.session.getDuelView().batch) {
    env.session.openBatchRound(item.number)
    await env.session.voteDuel('tie')
    env.session.nextDuel()
  }
  assert.equal(env.session.getDuelView().batch, null)
  assert.equal(env.seriesStore.json, null)
  assert.ok(env.seriesStore.cleared >= 1)

  const other = setup({ category: 'code', vramGb: 80, profile: { name: 'Léo' } })
  other.session.setDuelSeriesDelays({ idleCheckMs: 20 })
  await other.session.startDuel('code', 4, 2)
  assert.ok(other.seriesStore.json)
  // Étape 388 : des duels pas votés — « Terminer » est refusé sans confirmation, et rien n'est effacé.
  await assert.rejects(other.session.endDuel(), /pas encore votés/)
  assert.ok(other.seriesStore.json, 'la série gardée n’est pas effacée sans confirmation')
  assert.ok(other.session.getDuelView().batch?.length, 'les duels sont toujours là')
  await other.session.endDuel(true)
  assert.equal(other.seriesStore.json, null)
})

test('étape 382 : « Tout arrêter » arrête la série (téléchargement compris) et garde ce qui est prêt', async () => {
  const env = setup({ category: 'code', vramGb: 8, profile: { name: 'Léo' } })
  env.session.setDuelSeriesDelays({ idleCheckMs: 20 })
  const gates = new Map(MODELS.map((m) => [m, env.gatePull(m)]))
  await env.session.startDuel('code', 4, 3)
  // Les trois premiers modèles arrivent ; le quatrième reste en cours de téléchargement.
  for (let k = 1; k <= 3; k++) {
    await waitFor(() => env.calls.pulls.length >= k, `téléchargement ${k}`)
    gates.get(env.calls.pulls[k - 1])()
  }
  await waitFor(() => env.calls.pulls.length === 4, 'quatrième téléchargement en cours')
  const last = env.calls.pulls[3]
  await waitFor(() => env.session.getDuelView().batch.some((r) => r.a === 'done' && r.b === 'done'), 'un duel prêt pour le vote')
  env.session.stopDuelRun()
  gates.get(last)()
  await waitFor(() => !env.session.getDuelView().series?.active, 'série arrêtée')
  // Le téléchargement en cours est annulé : rien n'arrive sur le disque après « Tout arrêter ».
  assert.ok(!env.calls.pulled.includes(last), 'le téléchargement aurait dû être annulé')
  const view = env.session.getDuelView()
  assert.ok(view.batch.length > 0, 'les duels prêts restent à voter')
  assert.ok(view.batch.every((r) => r.a === 'done' && r.b === 'done'))
})

test('étape 382 : refusé hors Code, ou avec un nombre de duels par modèle impossible', async () => {
  const env = setup()
  await assert.rejects(env.session.startDuel('conversation', 4, 5))
  await assert.rejects(env.session.startDuel('code', 4, 0))
  await assert.rejects(env.session.startDuel('code', 4, 51))
  await assert.rejects(env.session.startDuel('code', 4, 2.5))
})
