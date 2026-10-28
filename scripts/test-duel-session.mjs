import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 355 — une session de Duel de bout en bout, avec de faux Ollama/converse/profil : préparation (téléchargements
 * sans nom), A puis B (chacun avec SON modèle, sans raccourci de Jaris, jamais d'extinction du PC), vote, duel suivant,
 * fin avec les noms révélés et le choix de Jaris mis à jour, suppression des modèles téléchargés.
 *
 * Le point le plus important : l'écran ne reçoit JAMAIS le nom d'un modèle avant la fin (Léo : « anonyme »).
 */
const duelModule = loadTsModule('shared/duel.ts')
const MODELS = ['alpha-model:3b', 'bravo-model:8b', 'charlie-model:4b', 'delta-model:7b']
const tick = () => new Promise((resolve) => setImmediate(resolve))

async function waitFor(predicate, what) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return
    await tick()
  }
  assert.fail(`jamais arrivé : ${what}`)
}

function setup({ installed = [], failPull = [], category = 'conversation', profile: initialProfile, converseImpl, ttsFails = false } = {}) {
  const calls = { pulls: [], converse: [], generate: [], deleted: [], patches: [], speech: [] }
  const votes = []
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
        options.onProgress?.({ phase: 'writing', step: 1, totalSteps: 2, chars: 10, elapsedMs: 1000, idleMs: 0 })
        return { html: `<html><body>${options.model.length}</body></html>`, issues: [], dir: '' }
      }
    },
    './generatedAppPreview': { createGeneratedAppPreview: (html) => `jaris-preview://app/${html.length}/index.html` },
    './hardwareScan': {
      duelMachine: async () => ({ vramGb: 8, ramGb: 32 }),
      duelPrior: (category) => () => (category === 'code' ? 20 : 10),
      getDuelCandidates: async () =>
        MODELS.map((model, index) => ({ model, vramGb: index + 2, note: 10 - index, duels: 0, inUse: profile?.models && Object.values(profile.models).includes(model) })),
      pickModelsForDuelCategory: async () => ({ flash: 'charlie-model:4b', medium: 'charlie-model:4b', large: 'bravo-model:8b', code: 'delta-model:7b' })
    },
    './ollama': {
      deleteModel: async (model) => {
        calls.deleted.push(model)
        installedNow = installedNow.filter((m) => m !== model)
      },
      listInstalledModels: async () => [...installedNow],
      pullModelIfMissing: async (model, _onStatus, onProgress, signal) => {
        calls.pulls.push(model)
        if (pullGates.has(model)) await pullGates.get(model).promise
        if (signal?.aborted) throw new Error('arrêté')
        onProgress?.({ percent: 50 })
        if (failPull.includes(model)) throw new Error(`pull model manifest: ${model} introuvable`)
        installedNow.push(model)
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
    './systemResources': { DISK_SAFETY_MARGIN_GB: 5, detectFreeDiskGb: async () => 100 },
    './tools': { TOOLS: ['open_app', 'type_text', 'set_reminder', 'shutdown_pc', 'search_web'].map((name) => ({ function: { name } })) },
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
      saveDuelApp: async (id, side, html) => {
        apps.set(`${id}-${side}`, html)
      },
      readDuelApp: async (id, side) => apps.get(`${id}-${side}`) ?? null
    },
    '../../shared/duel': duelModule
  }
  const session = loadTsModule('electron/services/duelSession.ts', modules)
  session.setDuelEnvironment({ onReminderFire: () => {}, emit: (view) => emitted.push(JSON.parse(JSON.stringify(view))) })
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
  await waitFor(() => env.session.getDuelView().round.a.status === 'running', 'A tourne')
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
  assert.match(main, /count < 2 \|\| count > 6\) throw new Error/)
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
})
