import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Mémoire automatique (memoryExtractor.ts) : trois défauts, dont deux vus en vrai avec qwen3.5:0.8b.
 *  1. `replace: "false"` en TEXTE effaçait la note existante (Boolean("false") vaut true).
 *  2. Après « Bonjour ! Tu peux te présenter en deux phrases ? », la RÉPONSE de Jaris a été enregistrée sous le titre
 *     « Conversation ». Garde-fou dans le code : contenu repris de la réponse refusé, titre qui désigne l'échange refusé
 *     — un vrai fait dit par l'utilisateur passe toujours, même reformulé à la troisième personne.
 *  3. L'extraction occupait Ollama devant la question suivante (environ une minute d'attente) : une nouvelle demande
 *     l'arrête, sans rien afficher, et l'échange est relu à la prochaine réponse.
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

/** Le VRAI toolFlag de tools.ts (tools.ts lui-même a trop de dépendances pour être chargé ici). */
function realToolFlag() {
  const source = read('electron/services/tools.ts').replace(/\r\n/g, '\n')
  const match = source.match(/export function toolFlag\(value: unknown\): boolean \{[\s\S]*?\n\}/)
  assert.ok(match, 'toolFlag introuvable dans tools.ts')
  const js = ts.transpileModule(match[0], { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  vm.runInThisContext(`(function (exports) {${js}\n})`)(exports)
  return exports.toolFlag
}
const toolFlag = realToolFlag()

const REMEMBER = { type: 'function', function: { name: 'remember', description: 'retenir', parameters: { type: 'object', properties: {} } } }

/**
 * Un module neuf par test (il garde son état : extraction en cours, échanges en attente). `respond(messages, signal)`
 * joue Ollama ; les notes écrites et les lignes affichées sont relevées.
 */
function load(respond) {
  const written = []
  const logs = []
  const calls = []
  const module = loadTsModule('electron/services/memoryExtractor.ts', {
    '../config': { config: { ollama: { model: 'modele-par-defaut', numCtx: 8192 } } },
    './ollama': {
      chatWithOllama: async (messages, tools, model, think, signal, numCtx) => {
        calls.push({ messages, tools, model, think, signal, numCtx })
        return respond(messages, signal)
      }
    },
    './tools': { TOOLS: [REMEMBER], toolFlag },
    './memoryStore': {
      listMemoryTitles: async () => ['Léo'],
      rememberNote: async (title, content, replace) => {
        written.push({ title, content, replace })
        return 'ok'
      }
    },
    './profileStore': { getProfile: async () => ({ name: 'Léo', models: { medium: 'granite4.2:8b' }, contextLength: 16384 }) }
  })
  return { ...module, written, logs, calls, onLog: (line) => logs.push(line) }
}

const remember = (args) => ({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'remember', arguments: args } }] })

/** Ollama qui ne répond qu'à l'arrêt : comme fetch, il rejette avec une AbortError quand le signal est coupé. */
const hangsUntilAborted = (_messages, signal) =>
  new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')))
  })

async function waitFor(condition, what) {
  const until = Date.now() + 3000
  while (!condition()) {
    if (Date.now() > until) throw new Error(`jamais arrivé : ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('replace: "false" en texte n’efface JAMAIS la note existante (toolFlag, pas Boolean)', async () => {
  for (const [replace, expected] of [
    ['false', false],
    ['False', false],
    [false, false],
    [undefined, false],
    ['true', true],
    [true, true]
  ]) {
    const m = load(() => remember({ title: 'Léo', content: 'Léo habite au 12 rue des Lilas.', replace }))
    await m.extractMemoryFromExchange("mon adresse c'est 12 rue des Lilas", "C'est noté.", m.onLog)
    assert.equal(m.written.length, 1)
    assert.equal(m.written[0].replace, expected, `replace = ${JSON.stringify(replace)}`)
  }
})

test('cas vu en vrai : la présentation de Jaris recopiée sous « Conversation » n’est pas enregistrée', async () => {
  const transcript = 'Bonjour ! Tu peux te présenter en deux phrases ?'
  const reply =
    "Bonjour Léo : je suis Jaris, un assistant personnel qui fonctionne entièrement sur ton ordinateur. Je peux t'aider " +
    'à chercher sur internet, ouvrir tes applications et retenir ce qui compte pour toi.'
  const m = load(() => remember({ title: 'Conversation', content: reply }))
  await m.extractMemoryFromExchange(transcript, reply, m.onLog)
  assert.deepEqual(m.written, [])
  assert.deepEqual(m.logs, [], 'rien d’annoncé à l’écran')
})

test('la réponse de Jaris recopiée est refusée même sous un titre de sujet, et même raccourcie ou reformulée', async () => {
  const cases = [
    {
      transcript: 'Bonjour ! Tu peux te présenter en deux phrases ?',
      reply: "Bonjour Léo : je suis Jaris, un assistant personnel local. Je t'aide à chercher, ouvrir tes applis et retenir l'essentiel.",
      note: { title: 'Jaris', content: 'Jaris est un assistant personnel local qui aide à chercher, ouvrir des applis et retenir l’essentiel.' }
    },
    {
      transcript: "C'est quoi la photosynthèse ?",
      reply: "La photosynthèse, c'est le processus par lequel les plantes transforment la lumière, l'eau et le gaz carbonique en sucre et en oxygène.",
      note: { title: 'Plantes', content: 'Les plantes transforment la lumière, l’eau et le gaz carbonique en sucre et en oxygène.' }
    },
    {
      transcript: 'Merci beaucoup !',
      reply: 'Avec plaisir, Léo ! N’hésite pas si tu as besoin d’autre chose, je reste disponible toute la journée.',
      note: { title: 'Léo', content: 'Jaris reste disponible toute la journée si Léo a besoin d’autre chose.' }
    },
    {
      transcript: 'Can you introduce yourself?',
      reply: 'Hi Léo! I am Jaris, a personal assistant that runs entirely on your computer and keeps your data private.',
      note: { title: 'Jaris', content: 'Jaris is a personal assistant that runs entirely on the computer and keeps data private.' }
    }
  ]
  for (const { transcript, reply, note } of cases) {
    const m = load(() => remember(note))
    await m.extractMemoryFromExchange(transcript, reply, m.onLog)
    assert.deepEqual(m.written, [], `refusée : « ${note.content} »`)
  }
})

test('les vrais faits dits par l’utilisateur passent, même reformulés à la troisième personne', async () => {
  const cases = [
    {
      transcript: "mon adresse c'est 12 rue des Lilas à Rennes",
      reply: "C'est noté, ton adresse est le 12 rue des Lilas à Rennes.",
      note: { title: 'Léo', content: 'Adresse de Léo : 12 rue des Lilas, Rennes.' }
    },
    {
      transcript: 'je bois du thé, pas du café',
      reply: 'D’accord, je retiens que tu préfères le thé au café.',
      note: { title: 'Boissons', content: 'Léo préfère le thé au café.' }
    },
    {
      transcript: "ma sœur s'appelle Emma",
      reply: 'Emma, c’est un joli prénom ! Elle est plus jeune ou plus âgée que toi ?',
      note: { title: 'Famille', content: 'La sœur de Léo s’appelle Emma.' }
    },
    {
      transcript: 'Ma soeur s’appelle Emma et elle vit à Lyon',
      reply: 'Noté ! Lyon est une très belle ville.',
      note: { title: 'Famille', content: 'Léo a une sœur prénommée Emma, qui habite à Lyon.' }
    },
    {
      transcript: 'En fait je ne bosse plus chez Renault, je suis chez Airbus depuis lundi',
      reply: 'Félicitations pour ce nouveau poste chez Airbus ! Tu travailles sur quoi ?',
      note: { title: 'Travail', content: 'Léo travaille chez Airbus depuis lundi (il a quitté Renault).', replace: true }
    },
    {
      transcript: 'Je pars au Japon en mars avec ma copine',
      reply: 'Super ! Mars, c’est la saison des cerisiers en fleurs, pense à réserver tes hôtels tôt.',
      note: { title: 'Voyages', content: 'Léo part au Japon en mars avec sa copine.' }
    },
    {
      transcript: 'je suis allergique aux arachides',
      reply: 'D’accord, j’éviterai de te proposer des recettes avec des cacahuètes ou du beurre de cacahuète.',
      note: { title: 'Santé', content: 'Léo a une allergie aux cacahuètes (arachides).' }
    },
    {
      transcript: "mon anniversaire c'est le 3 mai",
      reply: 'Je m’en souviendrai, joyeux anniversaire en avance !',
      note: { title: 'Léo', content: 'Anniversaire de Léo : 03/05.' }
    },
    {
      transcript: 'Présentation rapide : je m’appelle Léo, j’ai 19 ans et je suis développeur à Rennes',
      reply: 'Enchanté Léo ! Développeur, c’est un beau métier. Sur quoi travailles-tu en ce moment ?',
      note: { title: 'Présentation de Léo', content: 'Léo a 19 ans et il est développeur à Rennes.' }
    },
    {
      // Une autre langue que celle de la note : les mots ne correspondent pas, ça ne compte ni pour ni contre.
      transcript: 'Meine Schwester heißt Emma',
      reply: 'Notiert, deine Schwester heißt Emma.',
      note: { title: 'Famille', content: 'La sœur de Léo s’appelle Emma.' }
    },
    {
      transcript: 'I drink tea, never coffee',
      reply: 'Got it, I will remember that you prefer tea over coffee.',
      note: { title: 'Drinks', content: 'Léo drinks tea, never coffee.' }
    }
  ]
  for (const { transcript, reply, note } of cases) {
    const m = load(() => remember(note))
    await m.extractMemoryFromExchange(transcript, reply, m.onLog)
    assert.equal(m.written.length, 1, `acceptée : « ${note.content} » (après « ${transcript} »)`)
    assert.equal(m.written[0].content, note.content)
    assert.equal(m.written[0].replace, note.replace === true)
    assert.equal(m.logs.length, 1, 'la note enregistrée est annoncée comme avant')
  }
})

test('un titre qui désigne l’échange plutôt qu’un sujet est refusé, en français comme en anglais', async (t) => {
  const m = load(() => null)
  for (const title of [
    'Conversation',
    'Échange',
    'Échange avec Jaris',
    'Discussion du jour',
    'Réponse',
    'Question posée',
    'Présentation',
    'Présentation de Jaris',
    'Salutations',
    'Conversation avec l’utilisateur',
    'conversation',
    'Greeting',
    'Conversation with the user',
    'Small talk',
    'Answer'
  ]) {
    assert.equal(m.isExchangeTitle(title), true, `refusé : « ${title} »`)
  }
  for (const title of ['Léo', 'Famille', 'Voyage au Japon', 'Présentation de Léo', 'Conversation avec Marie', 'Questions de santé', 'Travail', 'Drinks']) {
    assert.equal(m.isExchangeTitle(title), false, `accepté : « ${title} »`)
  }
  await t.test('même avec un contenu venu de l’utilisateur, le titre générique est refusé de bout en bout', async () => {
    const e = load(() => remember({ title: 'Conversation', content: 'Léo habite à Rennes.' }))
    await e.extractMemoryFromExchange("j'habite à Rennes", 'Rennes, une belle ville !', e.onLog)
    assert.deepEqual(e.written, [])
  })
})

test('une nouvelle demande arrête l’extraction en cours : rien d’affiché, et l’échange est relu à la réponse suivante', async () => {
  let answer = hangsUntilAborted
  const m = load((messages, signal) => answer(messages, signal))
  const first = m.extractMemoryFromExchange("ma sœur s'appelle Emma", 'Joli prénom !', m.onLog)
  await waitFor(() => m.calls.length === 1, 'appel à Ollama')
  assert.equal(m.calls[0].numCtx, 16384, 'même fenêtre que la conversation')
  assert.ok(m.calls[0].signal, 'le signal d’arrêt est transmis à Ollama')

  m.cancelMemoryExtraction()
  await first
  assert.equal(m.calls[0].signal.aborted, true, 'la connexion à Ollama est coupée')
  assert.deepEqual(m.logs, [], 'une annulation n’est jamais annoncée comme un échec (memory.autoFailed)')
  assert.deepEqual(m.written, [])

  // Réponse suivante : les DEUX échanges partent ensemble, celui qui avait été arrêté n’est pas perdu.
  answer = () => remember({ title: 'Famille', content: 'La sœur de Léo s’appelle Emma.' })
  await m.extractMemoryFromExchange('Quelle heure est-il ?', 'Il est 15 h 20.', m.onLog)
  assert.equal(m.calls.length, 2)
  const sent = m.calls[1].messages.at(-1).content
  assert.match(sent, /ma sœur s'appelle Emma/)
  assert.match(sent, /Quelle heure est-il/)
  assert.deepEqual(m.written.map((note) => note.title), ['Famille'])

  // Une fois lus, ils ne repartent plus.
  answer = () => ({ role: 'assistant', content: '' })
  await m.extractMemoryFromExchange('Merci', 'Avec plaisir !', m.onLog)
  assert.doesNotMatch(m.calls[2].messages.at(-1).content, /Emma|Quelle heure/)
})

test('une annulation qui remonte sous un autre nom (« Impossible de joindre Ollama ») reste silencieuse', async () => {
  const m = load(
    (_messages, signal) =>
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Impossible de joindre Ollama'))))
  )
  const run = m.extractMemoryFromExchange('je bois du thé', 'Noté.', m.onLog)
  await waitFor(() => m.calls.length === 1, 'appel à Ollama')
  m.cancelMemoryExtraction()
  await run
  assert.deepEqual(m.logs, [])
})

test('une vraie erreur reste signalée, et l’échange en échec n’est pas retenté sans fin', async () => {
  let fail = true
  const m = load(() => {
    if (fail) throw new Error('Ollama a répondu 500 : boom')
    return { role: 'assistant', content: '' }
  })
  await m.extractMemoryFromExchange('je bois du thé', 'Noté.', m.onLog)
  assert.equal(m.logs.length, 1)
  assert.match(m.logs[0], /Ollama a répondu 500/)
  fail = false
  await m.extractMemoryFromExchange('Merci', 'Avec plaisir !', m.onLog)
  assert.doesNotMatch(m.calls[1].messages.at(-1).content, /thé/)
})

test('deux extractions ne tournent jamais en même temps : la nouvelle reprend l’échange de l’ancienne', async () => {
  let answer = hangsUntilAborted
  const m = load((messages, signal) => answer(messages, signal))
  const first = m.extractMemoryFromExchange("j'habite à Rennes", 'Belle ville !', m.onLog)
  await waitFor(() => m.calls.length === 1, 'premier appel')
  answer = () => remember({ title: 'Léo', content: 'Léo habite à Rennes.' })
  const second = m.extractMemoryFromExchange('Il fait beau ?', 'Oui, 21 °C.', m.onLog)
  await Promise.all([first, second])
  assert.equal(m.calls[0].signal.aborted, true, 'la première est arrêtée')
  assert.equal(m.calls.length, 2)
  assert.match(m.calls[1].messages.at(-1).content, /habite à Rennes[\s\S]*Il fait beau/)
  assert.equal(m.written.length, 1, 'une seule note, jamais en double')
  assert.deepEqual(m.logs.length, 1)
})

test('une réponse d’Ollama déjà en route n’est pas relue par l’extraction suivante (pas de note en double)', async () => {
  // Ollama a déjà répondu quand l’arrêt arrive : la note s’écrit quand même (plus rien n’occupe Ollama), et la
  // nouvelle extraction attend la fin de l’ancienne avant de partir — jamais deux appels à la fois, jamais relue.
  let firstDone = false
  let answer = () =>
    new Promise((resolve) =>
      setTimeout(() => {
        firstDone = true
        resolve(remember({ title: 'Famille', content: 'La sœur de Léo s’appelle Emma.' }))
      }, 30)
    )
  const m = load((messages, signal) => answer(messages, signal))
  const first = m.extractMemoryFromExchange("ma sœur s'appelle Emma", 'Joli prénom !', m.onLog)
  await waitFor(() => m.calls.length === 1, 'premier appel')
  let secondStartedAfterFirst = null
  answer = () => {
    secondStartedAfterFirst = firstDone
    return { role: 'assistant', content: '' }
  }
  const second = m.extractMemoryFromExchange('Il fait beau ?', 'Oui, 21 °C.', m.onLog)
  await Promise.all([first, second])
  assert.equal(secondStartedAfterFirst, true, 'la seconde part après la fin de la première')
  assert.doesNotMatch(m.calls[1].messages.at(-1).content, /Emma/, 'échange déjà lu : pas renvoyé')
  assert.equal(m.written.length, 1)
})

test('arrêter alors que rien ne tourne ne fait rien', async () => {
  const m = load(() => ({ role: 'assistant', content: '' }))
  m.cancelMemoryExtraction()
  await m.extractMemoryFromExchange('Salut', 'Salut Léo !', m.onLog)
  assert.equal(m.calls.length, 1)
  assert.equal(m.calls[0].signal.aborted, false)
})

test('la voix arrête la mémoire automatique au début de chaque demande, avant la correction et la réflexion', () => {
  const source = read('electron/services/voicePipeline.ts')
  const turn = source.slice(source.indexOf('private async runTranscript'), source.indexOf('private async speak'))
  const cancel = turn.indexOf('cancelMemoryExtraction()')
  assert.ok(cancel > -1, 'arrêtée dans runTranscript')
  assert.ok(cancel < turn.indexOf('correctTranscript('), 'avant la correction de la phrase entendue')
  assert.ok(cancel < turn.indexOf('await converse('), 'avant la réflexion')
  // Le téléphone passe par le Chat (chatSession.send), qui l’arrête aussi : voir test-chat-session-restore.mjs.
  assert.match(read('electron/main.ts'), /sendMessage: async \(text, onStatus, mode\) => \{\s*const message = await chatSession\.send\(/)
})
