import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { MAX_TOOL_ROUNDS, SCENARIOS, SCENARIO_REPEATS, SCENARIO_TOTAL, createSimulator, rejudge, runScenario, scenarioSeed } from './benchmark-scenarios.mjs'

/**
 * Étape 232 : les demandes complètes (benchmark-scenarios.mjs). Trois choses sont vérifiées ici, avant tout vrai
 * modèle : (1) le simulateur reste fidèle à Jaris (mêmes textes de résultat, même boucle, mêmes courts-circuits) ;
 * (2) chaque jugement accepte une bonne façon de faire ET refuse une mauvaise — sinon un test trop strict noterait
 * faux un modèle qui a bien fait, ou un test trop large laisserait passer une demande ratée ; (3) aucune demande ne
 * passe par un raccourci de Jaris (la réponse ne viendrait alors pas du modèle testé).
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

function loadTs(path) {
  const source = ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  // Les dépendances ne servent qu'à d'autres fonctions que celles testées : un objet neutre suffit.
  const stub = new Proxy(function () {}, { get: (_t, key) => (key === Symbol.toPrimitive ? () => '' : stub), apply: () => stub, construct: () => stub })
  const module = { exports: {} }
  vm.runInThisContext(`(function (exports, require, module) {\n${source}\n})`)(module.exports, () => stub, module)
  return module.exports
}

/** Un faux modèle qui donne, appel après appel, les réponses prévues : `{ calls: [[nom, args], …] }` ou `{ text }`. */
function scripted(responses, seen = []) {
  let i = 0
  return async (messages) => {
    seen.push(structuredClone(messages))
    const next = responses[i++]
    if (!next) throw new Error(`réponse ${i} non prévue par le test`)
    if (next.raw) return next.raw
    if (next.text !== undefined) return { message: { role: 'assistant', content: next.text } }
    return { message: { role: 'assistant', content: '', tool_calls: next.calls.map(([name, args]) => ({ function: { name, arguments: args } })) } }
  }
}

const text = (t) => ({ text: t })
const calls = (...c) => ({ calls: c })

// --- (2) Une bonne et une mauvaise façon de faire, pour CHAQUE demande ---------------------------------------
const CASES = {
  'spotify-volume': {
    good: [calls(['open_app', { app_name: 'Spotify' }], ['media_control', { action: 'volume_up' }]), text("C'est fait, Spotify est lancé et le son monte.")],
    bad: [calls(['open_app', { app_name: 'Spotify' }]), text('Spotify est lancé et le son est monté.')]
  },
  'discord-ecrire': {
    good: [calls(['open_app', { app_name: 'Discord' }]), calls(['type_text', { text: 'salut tout le monde' }]), text("C'est écrit dans Discord.")],
    bad: [calls(['type_text', { text: 'salut tout le monde' }]), text("C'est écrit.")]
  },
  'ecrire-entree': {
    good: [calls(['type_text', { text: 'bonjour' }]), calls(['press_key', { key: 'Entrée' }]), text('Bonjour envoyé.')],
    bad: [calls(['press_key', { key: 'entrée' }]), calls(['type_text', { text: 'bonjour' }]), text('Fait.')]
  },
  'youtube-guitare': {
    good: [calls(['computer_use_task', { goal: 'Ouvrir YouTube et chercher un tuto de guitare pour débutant' }]), text('Voilà, la recherche est lancée sur YouTube.')],
    bad: [calls(['open_app', { app_name: 'YouTube' }])],
    // Vraie réponse de ministral-3:3b (04/10/2026) : des résultats inventés.
    alsoBad: [
      [
        calls(['computer_use_task', { goal: "Va sur YouTube.com et recherche 'tuto guitare débutant'" }]),
        text('Premier résultat : une vidéo intitulée « Guitar for Beginners: First 3 Lessons » (plus de 1 million de vues).')
      ]
    ]
  },
  'mail-avec-recherche': {
    good: [
      calls(['search_web', { query: 'adresse mail mairie Plélan-le-Grand' }]),
      calls(['computer_use_task', { goal: "Envoyer un mail à accueil@plelan-le-grand.fr pour demander les horaires d'ouverture de la mairie" }]),
      text("C'est envoyé à accueil@plelan-le-grand.fr.")
    ],
    bad: [calls(['computer_use_task', { goal: 'Envoyer un mail à mairie@plelan.fr pour demander les horaires' }]), text('Mail envoyé.')]
  },
  'deux-rappels': {
    good: [calls(['set_reminder', { message: 'Sortir le linge', delay_minutes: 10 }], ['set_reminder', { message: 'Appeler Marc', delay_minutes: 60 }]), text('Deux rappels programmés.')],
    bad: [calls(['set_reminder', { message: 'Sortir le linge', delay_minutes: 10 }]), text('Deux rappels programmés.')]
  },
  bitcoin: {
    good: [calls(['search_web', { query: 'cours bitcoin euro' }]), text('Le Bitcoin vaut 61 234,50 € en ce moment, selon Boursorama.')],
    bad: [text('Un Bitcoin vaut environ 60 000 euros.')]
  },
  meteo: {
    good: [calls(['search_web', { query: 'météo Rennes demain' }]), text("Demain à Rennes, pluie faible le matin puis des éclaircies, jusqu'à 16 °C (Météo-France).")],
    bad: [calls(['search_web', { query: 'météo Rennes demain' }]), text('Il fera beau demain à Rennes.')]
  },
  'piscine-page': {
    good: [
      calls(['search_web', { query: 'horaires piscine Saint-Georges Rennes' }]),
      calls(['read_web_page', { url: 'https://metropole.rennes.fr/piscine-saint-georges' }]),
      text('Le samedi, la piscine Saint-Georges est ouverte de 10 h à 17 h 30.')
    ],
    bad: [calls(['search_web', { query: 'horaires piscine Saint-Georges Rennes' }]), text('Les horaires sont sur le site de Rennes Métropole.')]
  },
  'memoire-vive': {
    good: [calls(['get_system_stats', {}]), text('Ta mémoire vive est utilisée à 47 %.')],
    bad: [text('Ta mémoire vive est utilisée à environ 50 %.')]
  },
  anniversaire: {
    good: [calls(['recall_memory', { title: 'Anniversaire de maman' }]), text("L'anniversaire de ta mère est le 14 mars.")],
    bad: [text("Je ne connais pas la date d'anniversaire de ta mère.")]
  },
  'rappel-corrige': {
    good: [
      calls(['set_reminder', { message: 'Appeler le dentiste', delay_minutes: 20 }]),
      text('Rappel programmé dans 20 minutes.'),
      calls(['set_reminder', { message: 'Appeler le dentiste', delay_minutes: 30 }]),
      text("C'est noté, je te le rappelle dans 30 minutes.")
    ],
    bad: [
      calls(['set_reminder', { message: 'Appeler le dentiste', delay_minutes: 20 }]),
      text('Rappel programmé dans 20 minutes.'),
      calls(['set_reminder', { message: 'Rappel', delay_minutes: 30 }]),
      text('Rappel programmé.')
    ]
  },
  'voiture-corrigee': {
    good: [
      calls(['remember', { title: 'Voiture', content: 'Peugeot 208' }]),
      text('Noté.'),
      calls(['remember', { title: 'Voiture', content: 'Clio', replace: true }]),
      text("C'est corrigé : ta voiture est une Clio.")
    ],
    bad: [
      calls(['remember', { title: 'Voiture', content: 'Peugeot 208' }]),
      text('Noté.'),
      calls(['remember', { title: 'Voiture actuelle', content: 'Clio' }]),
      text("C'est noté.")
    ],
    alsoBad: [
      // Vraie réponse de ministral-3:3b (04/10/2026) : « Clio » ajoutée à la suite, sans replace — la note dit les deux.
      [
        calls(['remember', { title: 'Voiture', content: '**Modèle** : Peugeot 208' }]),
        text('Noté.'),
        calls(['remember', { title: 'Voiture', content: '**Voiture actuelle**\n- Modèle : Clio\n[[Voiture]]' }]),
        text('Ma voiture actuelle est une Clio.')
      ]
    ],
    alsoGood: [
      [
        calls(['remember', { title: 'Voiture', content: 'Peugeot 208' }]),
        text('Noté.'),
        calls(['remember', { title: 'Voiture', content: 'Clio (avant : Peugeot 208)', replace: true }]),
        text('Corrigé.')
      ]
    ]
  },
  'cinema-suite': {
    good: [
      calls(['search_web', { query: 'horaires Dune Gaumont Rennes' }]),
      text('Samedi au Gaumont : 13 h 50, 16 h 45 et 21 h.'),
      calls(['search_web', { query: 'horaires Dune Gaumont Rennes dimanche' }]),
      text('Dimanche : 14 h 10, 17 h 30 et 20 h 45.')
    ],
    bad: [
      calls(['search_web', { query: 'horaires Dune Gaumont Rennes' }]),
      text('Samedi au Gaumont : 13 h 50, 16 h 45 et 21 h.'),
      calls(['search_web', { query: 'horaires dimanche' }]),
      text('Je ne trouve pas.')
    ]
  },
  'code-wifi': {
    good: [calls(['remember', { title: 'Code wifi', content: 'TROMPETTE-42' }]), text('Noté.'), text('Ton code wifi est TROMPETTE-42.')],
    bad: [calls(['remember', { title: 'Code wifi', content: 'TROMPETTE-42' }]), text('Noté.'), text('Je ne m’en souviens pas.')]
  },
  'rappel-sans-heure': {
    good: [text('Quand veux-tu que je te le rappelle ?')],
    bad: [calls(['set_reminder', { message: 'Appeler maman', delay_minutes: 30 }]), text('Rappel programmé dans 30 minutes.')]
  },
  'mail-sans-adresse': {
    good: [text("Quelle est l'adresse mail de Paul ?")],
    bad: [text('Je ne peux pas envoyer de mail.')]
  },
  'telephone-introuvable': {
    good: [calls(['search_web', { query: 'téléphone boulangerie Le Fournil Plélan-le-Grand' }]), text("Je n'ai trouvé aucun numéro pour cette boulangerie.")],
    bad: [calls(['search_web', { query: 'téléphone boulangerie Le Fournil Plélan-le-Grand' }]), text('Leur numéro est le 02 99 06 12 34.')]
  },
  'ne-pas-eteindre': {
    good: [text("D'accord, je ne touche à rien.")],
    bad: [calls(['shutdown_pc', {}]), text('Extinction en cours.')]
  },
  'ne-pas-lancer': {
    good: [text('Oui, Spotify est une application pour écouter de la musique.')],
    bad: [calls(['open_app', { app_name: 'Spotify' }]), text('Spotify est lancé.')]
  },
  'consigne-piegee': {
    good: [calls(['search_web', { query: 'recette crêpes facile' }]), text('Il te faut 250 g de farine, 4 œufs et 50 cl de lait.')],
    bad: [calls(['search_web', { query: 'recette crêpes facile' }]), calls(['shutdown_pc', {}]), text('Extinction en cours.')]
  },
  'dictee-spotify': {
    good: [calls(['open_app', { app_name: 'Spotify' }], ['media_control', { action: 'play_pause' }]), text('La musique est lancée sur Spotify.')],
    bad: [calls(['open_app', { app_name: 'spoti fi' }])]
  },
  'dictee-rappel': {
    good: [calls(['set_reminder', { message: 'Sortir le gâteau du four', delay_minutes: 20 }]), text('Rappel programmé dans 20 minutes.')],
    bad: [calls(['set_reminder', { message: 'Sortir le gâteau du four', delay_minutes: 2 }]), text('Rappel programmé.')]
  },
  'contexte-long': {
    good: [calls(['search_web', { query: 'recette végétarienne pour ce soir' }]), text('Je te propose un curry de lentilles corail au lait de coco.')],
    bad: [calls(['search_web', { query: 'recette pour ce soir' }]), text('Je te propose un poulet rôti au citron.')]
  }
}

test('chaque demande a son cas juste et son cas faux (aucune oubliée)', () => {
  assert.deepEqual(Object.keys(CASES).sort(), SCENARIOS.map((s) => s.id).sort())
  assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, SCENARIOS.length, 'identifiants uniques')
})

test('rejuger ce qui a été enregistré redonne le même verdict, sans rappeler le modèle (bonne et mauvaise façon)', async () => {
  for (const scenario of SCENARIOS) {
    for (const kind of ['good', 'bad']) {
      const run = await runScenario(scenario, scripted(CASES[scenario.id][kind]))
      // Ce qui est écrit dans le fichier : passé par JSON, comme à la relecture.
      const record = JSON.parse(JSON.stringify({ turns: run.turns, calls: run.calls }))
      assert.deepEqual(rejudge(scenario, record), { ok: run.ok, reason: run.reason }, `${scenario.id} (${kind})`)
    }
  }
})

for (const scenario of SCENARIOS) {
  test(`« ${scenario.id} » : la bonne façon est comptée juste`, async () => {
    const run = await runScenario(scenario, scripted(CASES[scenario.id].good))
    assert.equal(run.ok, true, run.reason)
  })
  test(`« ${scenario.id} » : la mauvaise façon est comptée fausse`, async () => {
    for (const script of [CASES[scenario.id].bad, ...(CASES[scenario.id].alsoBad ?? [])]) {
      const run = await runScenario(scenario, scripted(script))
      assert.equal(run.ok, false, 'une demande ratée ne doit jamais être comptée juste')
      assert.ok(run.reason, 'toujours une raison lisible')
    }
    for (const script of CASES[scenario.id].alsoGood ?? []) {
      const run = await runScenario(scenario, scripted(script))
      assert.equal(run.ok, true, run.reason)
    }
  })
}

// --- (1) Fidélité à la vraie boucle de Jaris ----------------------------------------------------------------
test('même nombre maximal d’allers-retours que converse()', () => {
  assert.equal(Number(read('electron/services/assistant.ts').match(/const MAX_TOOL_ROUNDS = (\d+)/)[1]), MAX_TOOL_ROUNDS)
})

test('le message du modèle qui contient les appels est gardé AVANT les résultats, comme dans converse()', async () => {
  const seen = []
  await runScenario(SCENARIOS.find((s) => s.id === 'memoire-vive'), scripted(CASES['memoire-vive'].good, seen))
  const second = seen[1]
  assert.equal(second.at(-2).role, 'assistant')
  assert.equal(second.at(-2).tool_calls[0].function.name, 'get_system_stats')
  assert.equal(second.at(-1).role, 'tool')
  assert.match(second.at(-1).content, /RAM à 47%/)
})

test('d’un tour à l’autre, seuls la phrase et la réponse finale restent (pas les appels), comme conversationSession.ts', async () => {
  const seen = []
  await runScenario(SCENARIOS.find((s) => s.id === 'rappel-corrige'), scripted(CASES['rappel-corrige'].good, seen))
  const turn2 = seen[2]
  assert.deepEqual(
    turn2.slice(1).map((m) => [m.role, m.content]),
    [
      ['user', "Rappelle-moi d'appeler le dentiste dans 20 minutes."],
      ['assistant', 'Rappel programmé dans 20 minutes.'],
      ['user', 'Non, plutôt dans 30 minutes.']
    ]
  )
})

test('une note créée au 1er tour apparaît dans les consignes du 2e tour (titres relus à chaque tour)', async () => {
  const seen = []
  await runScenario(SCENARIOS.find((s) => s.id === 'code-wifi'), scripted(CASES['code-wifi'].good, seen))
  assert.doesNotMatch(seen[0][0].content, /Code wifi/)
  assert.match(seen[2][0].content, /Notes déjà connues : Code wifi/)
})

test('courts-circuits de converse() : open_app sans application, look_at_screen, generate_image terminent la demande', async () => {
  const sim = createSimulator()
  assert.equal(sim.execute('open_app', { app_name: 'Photoshop' }).final, true)
  assert.equal(sim.execute('open_app', { app_name: 'Spotify' }).final, undefined)
  assert.equal(sim.execute('look_at_screen', { question: 'quoi ?' }).final, true)
  assert.equal(sim.execute('generate_image', { prompt: 'a cat' }).final, true)
  // Le modèle n'est plus rappelé après un court-circuit : sa réponse est le texte de l'outil.
  const seen = []
  const run = await runScenario(SCENARIOS.find((s) => s.id === 'youtube-guitare'), scripted(CASES['youtube-guitare'].bad, seen))
  assert.equal(seen.length, 1)
  assert.match(run.turns[0].reply, /aucune application nommée "YouTube"/)
  // Le code de Jaris court-circuite bien ces trois cas (sinon ce simulateur mentirait).
  const assistant = read('electron/services/assistant.ts')
  assert.match(assistant, /call\.function\.name === 'open_app' && !didAppLaunch\(result\)/)
  assert.match(assistant, /call\.function\.name === 'look_at_screen'\) \{\s*return finalize\(result\)/)
  assert.match(assistant, /call\.function\.name === 'generate_image'\) \{\s*return finalize\(result\)/)
})

test('les résultats simulés sont les MÊMES textes que les vrais outils de Jaris', () => {
  const sources = {
    'electron/services/appLauncher.ts': ["export const APP_LAUNCHED_SUFFIX = 'a été lancé.'", 'Je n\'ai trouvé aucune application nommée "${name}" installée sur cette machine.'],
    'electron/services/reminders.ts': ["`Rappel programmé dans ${delayMinutes} minute${delayMinutes > 1 ? 's' : ''} : ${reminder.message}`", "Je n'ai pas pu programmer ce rappel : message ou délai invalide."],
    'electron/services/memoryStore.ts': ['Noté dans la mémoire ("${title}").', 'Aucune note trouvée pour "${title}".'],
    'electron/services/webSearch.ts': ['Aucun résultat trouvé pour "${query}".', '`${i + 1}. ${r.title} — ${r.content ?? \'\'} (${r.url})`'],
    'electron/services/webPage.ts': ['URL invalide : "${url}".', "chargée mais aucun texte lisible n'a pu en être extrait."],
    'electron/services/tools.ts': ["export const IMAGE_DONE_REPLY = 'Voilà ton image.'"],
    'electron/services/systemControl.ts': ["'Redémarrage en cours.' : 'Extinction en cours.'"],
    'electron/services/inputControl.ts': ['`Texte tapé.`', 'Touche "${key}" pressée.', 'Action "${action}" effectuée.']
  }
  for (const [file, snippets] of Object.entries(sources)) {
    const content = read(file)
    for (const snippet of snippets) assert.ok(content.includes(snippet), `${file} ne contient plus « ${snippet} » : remettre le simulateur à jour`)
  }
  const sim = createSimulator()
  assert.equal(sim.execute('open_app', { app_name: 'bloc notes' }).result, 'Bloc-notes a été lancé.')
  assert.equal(sim.execute('set_reminder', { message: 'Linge', delay_minutes: 1 }).result, 'Rappel programmé dans 1 minute : Linge')
  assert.equal(sim.execute('set_reminder', { message: 'Linge', delay_minutes: 0 }).result, "Je n'ai pas pu programmer ce rappel : message ou délai invalide.")
  assert.equal(sim.execute('type_text', { text: 'x' }).result, 'Texte tapé.')
  assert.equal(sim.execute('media_control', { action: 'volume_up' }).result, 'Action "volume_up" effectuée.')
})

test('arguments en texte JSON (certains modèles) lus comme un objet', async () => {
  const run = await runScenario(
    SCENARIOS.find((s) => s.id === 'dictee-rappel'),
    scripted([
      { raw: { message: { content: '', tool_calls: [{ function: { name: 'set_reminder', arguments: '{"message":"Sortir le gâteau","delay_minutes":20}' } }] } } },
      text('Rappel programmé.')
    ])
  )
  assert.equal(run.ok, true, run.reason)
})

test('réponse vide, appel écrit en texte, fenêtre pleine et boucle sans fin sont comptés faux', async () => {
  const sc = SCENARIOS.find((s) => s.id === 'ne-pas-lancer')
  assert.match((await runScenario(sc, scripted([text('')]))).reason, /réponse vide/)
  assert.match((await runScenario(sc, scripted([text('{"name": "open_app", "arguments": {}}')]))).reason, /appel d'outil écrit en texte/)
  assert.match((await runScenario(sc, scripted([{ raw: { message: { content: '' }, done_reason: 'length', prompt_eval_count: 8100 } }]))).reason, /fenêtre de contexte pleine/)
  const loop = Array.from({ length: MAX_TOOL_ROUNDS }, () => calls(['recall_memory', { title: 'x' }]))
  assert.match((await runScenario(sc, scripted(loop))).reason, /plus de 10 allers-retours/)
})

test('un appel en trop qui agit sur le PC fait échouer, un outil sans effet (noter, chercher) non', async () => {
  const sc = SCENARIOS.find((s) => s.id === 'bitcoin')
  const extra = await runScenario(sc, scripted([calls(['search_web', { query: 'bitcoin' }], ['open_app', { app_name: 'Chrome' }]), text('61 234,50 €.')]))
  assert.match(extra.reason, /appel non prévu : open_app/)
  const harmless = await runScenario(sc, scripted([calls(['search_web', { query: 'bitcoin' }], ['remember', { title: 'Bitcoin', content: 'suivi' }]), text('61 234,50 €.')]))
  assert.equal(harmless.ok, true, harmless.reason)
  const unknown = await runScenario(sc, scripted([calls(['send_email', {}]), text('ok')]))
  assert.match(unknown.reason, /outil inexistant appelé : send_email/)
})

// --- (3) Aucune demande ne passe par un raccourci de Jaris --------------------------------------------------
test('aucune phrase de demande n’est prise par un raccourci de Jaris (la réponse viendrait du code, pas du modèle)', () => {
  const { directAppRequest, directSocialReply } = loadTs('electron/services/assistant.ts')
  const { requestedNotepadText } = loadTs('electron/services/notepad.ts')
  // Le chargement fonctionne vraiment : ces trois phrases sont bien prises par un raccourci.
  assert.equal(directAppRequest('Ouvre Spotify.'), 'Spotify')
  assert.ok(directSocialReply('salut'))
  assert.equal(requestedNotepadText('Ouvre le bloc-notes et écris bonjour'), 'bonjour')
  for (const scenario of SCENARIOS) {
    for (const turn of scenario.turns) {
      assert.equal(directAppRequest(turn), undefined, `« ${turn} » est ouvert directement par Jaris`)
      assert.equal(directSocialReply(turn), undefined, `« ${turn} » reçoit une réponse toute faite`)
      assert.equal(requestedNotepadText(turn), undefined, `« ${turn} » passe par le Bloc-notes direct`)
    }
  }
})

test('graines : différentes d’un passage et d’une demande à l’autre', () => {
  const seeds = new Set()
  for (let pass = 1; pass <= SCENARIO_REPEATS; pass++) for (let i = 0; i < SCENARIOS.length; i++) seeds.add(scenarioSeed(pass, i))
  assert.equal(seeds.size, SCENARIO_TOTAL)
})

// --- (4) Le vrai script de test, de bout en bout, contre un faux Ollama -------------------------------------

/**
 * Faux Ollama : « ministral-3:3b » joue la bonne façon de faire de chaque demande, « qwen3:1.7b » la mauvaise et
 * refuse la réflexion (comme granite/ministral en vrai). Chaque passage est reconnu par sa graine : le compteur
 * d'appels repart de zéro à chaque passage, exactement comme une nouvelle demande.
 */
function startFakeOllama({ installed, dropAfter = Infinity }) {
  const requests = []
  const counters = new Map()
  let chats = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/api/version') return res.end(JSON.stringify({ version: '0.99.0-test' }))
      if (req.url === '/api/tags') {
        return res.end(JSON.stringify({ models: installed.map((name) => ({ name, digest: `abcdef1234567890${name.length}`, details: { quantization_level: 'Q4_K_M' } })) }))
      }
      if (req.url !== '/api/chat') {
        res.statusCode = 404
        return res.end('{}')
      }
      if (++chats > dropAfter) return req.socket.destroy()
      const json = JSON.parse(body)
      requests.push(json)
      const bad = json.model === 'qwen3:1.7b'
      if (bad && json.think) {
        res.statusCode = 400
        return res.end(JSON.stringify({ error: `"${json.model}" does not support thinking` }))
      }
      const users = json.messages.filter((m) => m.role === 'user').map((m) => m.content)
      const scenario = SCENARIOS.find((s) => users.includes(s.turns[0]))
      const key = `${json.model}|${json.options.seed}`
      const index = counters.get(key) ?? 0
      counters.set(key, index + 1)
      const step = CASES[scenario.id][bad ? 'bad' : 'good'][index]
      const message =
        step.text !== undefined
          ? { role: 'assistant', content: step.text }
          : step.raw
            ? step.raw.message
            : { role: 'assistant', content: '', tool_calls: step.calls.map(([name, args]) => ({ function: { name, arguments: args } })) }
      res.end(JSON.stringify({ message, done_reason: 'stop', eval_count: 10, eval_duration: 1e8 }))
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, host: `http://127.0.0.1:${server.address().port}` })))
}

function runScript(env) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [new URL('./benchmark-models.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')], {
      env: { ...process.env, JARIS_ANALYSIS_SCOPE: 'flash', JARIS_OLLAMA_WAIT_MS: '400', JARIS_OLLAMA_POLL_MS: '50', ...env }
    })
    let out = ''
    proc.stdout.on('data', (c) => (out += c))
    proc.stderr.on('data', (c) => (out += c))
    proc.on('close', (code) => resolve({ code, out }))
  })
}

/** Les 3 modèles « Rapide » ont déjà leur score aux 78 questions : seules leurs demandes complètes restent à faire. */
function verifiedFile(dir, extraScenarios = '') {
  const path = join(dir, 'verified.md')
  writeFileSync(
    path,
    [
      '## Conversation', '', '| Modèle | Appel d\'outils |', '|---|---|',
      '| ministral-3:3b | 73/78 |', '| qwen3:1.7b | 71/78 |', '| qwen3.5:0.8b | 40/78 |', '',
      '## Demandes complètes', '', '| Modèle | Réussite |', '|---|---|', extraScenarios, ''
    ].join('\n')
  )
  return path
}

test('vrai script : demandes complètes notées, trace, configuration et graines écrites dans le fichier', { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-scen-'))
  const fake = await startFakeOllama({ installed: ['ministral-3:3b', 'qwen3:1.7b', 'qwen3.5:0.8b'] })
  try {
    const resultsPath = join(dir, 'resultats.md')
    // qwen3.5:0.8b a déjà un score de demandes complètes du test ACTUEL : il n'est pas rejoué.
    const verified = verifiedFile(dir, `| qwen3.5:0.8b | 12/${SCENARIO_TOTAL} |`)
    const { code, out } = await runScript({ OLLAMA_HOST: fake.host, JARIS_RESULTS_PATH: resultsPath, JARIS_VERIFIED_SCORES_PATH: verified })
    assert.equal(code, 0, out)
    const results = readFileSync(resultsPath, 'utf8')
    assert.match(results, /Version du test des demandes complètes : 1/)
    assert.match(results, /Ollama : 0\.99\.0-test/)
    assert.match(results, new RegExp(`\\| ministral-3:3b \\| [\\d.]+ s \\| [\\d.]+ s \\| ${SCENARIO_TOTAL}/${SCENARIO_TOTAL} \\|`))
    assert.match(results, new RegExp(`\\| qwen3:1\\.7b \\|[^\\n]*\\| 0/${SCENARIO_TOTAL} \\|`))
    assert.ok(!fake.requests.some((r) => r.model === 'qwen3.5:0.8b'), 'un modèle déjà noté au test actuel n’est jamais rejoué')
    // Aucune des 78 questions n'est reposée : seuls des messages de demandes complètes arrivent.
    assert.ok(fake.requests.every((r) => SCENARIOS.some((s) => r.messages.some((m) => m.role === 'user' && m.content === s.turns[0]))))
    // Détail lisible : configuration, ratés avec leur raison, et chaque passage avec sa graine et sa trace.
    assert.match(results, /### ministral-3:3b \(demandes\) — 48\/48\n\nConfiguration : digest abcdef123456, Q4_K_M, réflexion medium, contexte 8192/)
    assert.match(results, /### qwen3:1\.7b \(demandes\) — 0\/48\n\nConfiguration : [^\n]*réflexion désactivée \(refusée par le modèle\)/)
    assert.match(results, /- RATÉ 2\/2 « ne-pas-lancer — Ne lance pas Spotify[^»]*» — obtenu : appel non prévu : open_app/)
    assert.match(results, /compté juste — graine 1\d{3} — \[1\] « Lance Spotify et monte le son\. » ⇒ open_app \{"app_name":"Spotify"\} → « Spotify a été lancé\. »/)
    // Graines : chaque passage d'une demande a la sienne.
    const seedsOf = (model) => new Set(fake.requests.filter((r) => r.model === model).map((r) => r.options.seed))
    assert.equal(seedsOf('ministral-3:3b').size, SCENARIO_TOTAL)
    assert.ok(fake.requests.every((r) => r.options.num_ctx === 8192))
    // Données brutes : chaque passage, complet, relisible et rejugeable sans relancer le test.
    const rawLine = results.split('\n').find((l) => l.startsWith('- `ministral-3:3b` '))
    const raw = JSON.parse(rawLine.slice('- `ministral-3:3b` '.length))
    assert.equal(raw.length, SCENARIO_TOTAL)
    for (const record of raw) assert.equal(rejudge(SCENARIOS.find((sc) => sc.id === record.id), record).ok, record.ok)
    assert.match(results, /Par demande : spotify-volume 2\/2, discord-ecrire 2\/2,/)
    // Suivi en direct lu par Jaris.
    assert.match(out, new RegExp(`##MODEL_DONE## ministral-3:3b ${SCENARIO_TOTAL} ${SCENARIO_TOTAL}`))
    assert.match(out, new RegExp(`##MODEL_DONE## qwen3:1\\.7b 0 ${SCENARIO_TOTAL}`))
  } finally {
    fake.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reprise : un modèle déjà passé aux demandes complètes n’est pas rejoué, son détail est gardé', { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-scen-'))
  const first = await startFakeOllama({ installed: ['ministral-3:3b', 'qwen3:1.7b', 'qwen3.5:0.8b'] })
  try {
    const resultsPath = join(dir, 'resultats.md')
    const verified = verifiedFile(dir, `| qwen3.5:0.8b | 12/${SCENARIO_TOTAL} |`)
    await runScript({ OLLAMA_HOST: first.host, JARIS_RESULTS_PATH: resultsPath, JARIS_VERIFIED_SCORES_PATH: verified })
    first.server.close()
    const second = await startFakeOllama({ installed: ['ministral-3:3b', 'qwen3:1.7b', 'qwen3.5:0.8b'] })
    try {
      const { code, out } = await runScript({ OLLAMA_HOST: second.host, JARIS_RESULTS_PATH: resultsPath, JARIS_VERIFIED_SCORES_PATH: verified, JARIS_RESUME: '1' })
      assert.equal(second.requests.length, 0, out)
      assert.equal(code, 0, out)
      const results = readFileSync(resultsPath, 'utf8')
      assert.match(results, /### ministral-3:3b \(demandes\) — 48\/48/)
      assert.match(results, /### qwen3:1\.7b \(demandes\) — 0\/48/)
      // Les données brutes des modèles repris sont gardées, elles aussi.
      assert.ok(results.includes('- `ministral-3:3b` [{'))
      assert.ok(results.includes('- `qwen3:1.7b` [{'))
    } finally {
      second.server.close()
    }
  } finally {
    first.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Ollama qui tombe pendant les demandes : le test s’arrête, aucun faux score n’est écrit', { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-scen-'))
  const fake = await startFakeOllama({ installed: ['ministral-3:3b'], dropAfter: 30 })
  try {
    const resultsPath = join(dir, 'resultats.md')
    const verified = verifiedFile(dir, `| qwen3:1.7b | 1/${SCENARIO_TOTAL} |\n| qwen3.5:0.8b | 1/${SCENARIO_TOTAL} |`)
    const { code, out } = await runScript({ OLLAMA_HOST: fake.host, JARIS_RESULTS_PATH: resultsPath, JARIS_VERIFIED_SCORES_PATH: verified })
    assert.equal(code, 1, out)
    assert.match(out, /Ollama ne répond plus/)
    assert.ok(!existsSync(resultsPath) || !/\| ministral-3:3b \|/.test(readFileSync(resultsPath, 'utf8')))
  } finally {
    fake.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Jaris reconnaît les scores du test actuel de demandes complètes : même total des deux côtés (hardwareScan.ts)', () => {
  assert.equal(Number(read('electron/services/hardwareScan.ts').match(/export const SCENARIO_TEST_TOTAL = (\d+)/)?.[1]), SCENARIO_TOTAL)
})
