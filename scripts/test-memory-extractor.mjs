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
 *     « Conversation ». Garde-fou dans le code : contenu repris de la réponse refusé ; un titre qui désigne l'échange
 *     ne garde la note que si son contenu dit clairement un fait de l'utilisateur (sous son prénom). Un vrai fait dit
 *     par l'utilisateur passe toujours, même reformulé, même complété par les mots de Jaris, même sous « Chat ».
 *  3. L'extraction occupait Ollama devant la question suivante (environ une minute d'attente) : une nouvelle demande
 *     (voix, Chat, téléphone, Code, Image, Vidéo) l'arrête, sans rien afficher, et l'échange est relu à la prochaine
 *     réponse — sans en perdre un seul, même après plusieurs arrêts de suite. Effacer l'historique vide cette file.
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
function load(respond, { name = 'Léo' } = {}) {
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
    './profileStore': { getProfile: async () => (name === null ? null : { name, models: { medium: 'granite4.2:8b' }, contextLength: 16384 }) }
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
  // Le garde du CONTENU suffit à lui seul (le titre n'y est pour rien), y compris sans point d'interrogation :
  // « bonjour », dit par l'utilisateur et répété par Jaris, ne prouve pas que la note vient de lui.
  for (const [said, title] of [
    [transcript, 'Léo'],
    ['Bonjour ! Présente-toi en deux phrases.', 'Léo'],
    ['Bonjour ! Présente-toi en deux phrases.', 'Jaris']
  ]) {
    const r = load(() => remember({ title, content: reply }))
    await r.extractMemoryFromExchange(said, reply, r.onLog)
    assert.deepEqual(r.written, [], `refusée sous « ${title} » après « ${said} »`)
  }
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
      // Un mot de la QUESTION repris, tout le reste vient de l'explication de Jaris : du savoir de Jaris, pas un fait.
      transcript: "C'est quoi la photosynthèse ?",
      reply: "La photosynthèse, c'est le processus par lequel les plantes transforment la lumière, l'eau et le gaz carbonique en sucre et en oxygène.",
      note: { title: 'Sciences', content: 'La photosynthèse transforme la lumière, l’eau et le gaz carbonique en sucre et en oxygène.' }
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
      // Titres à double sens en français : « Chat » (l'animal), « Entretien » (d'embauche).
      transcript: "mon chat s'appelle Moustache",
      reply: 'Moustache, trop mignon !',
      note: { title: 'Chat', content: 'Le chat de Léo s’appelle Moustache.' }
    },
    {
      transcript: "j'ai un entretien d'embauche chez Airbus mardi à 10h",
      reply: 'Bonne chance pour mardi, tu vas assurer !',
      note: { title: 'Entretien', content: 'Léo a un entretien d’embauche chez Airbus mardi à 10h.' }
    },
    {
      // Jaris confirme avec SES mots, le modèle les reprend : le fait vient quand même de l'utilisateur.
      transcript: 'je suis végétarien',
      reply: 'D’accord, je retiendrai que tu ne manges pas de viande.',
      note: { title: 'Léo', content: 'Léo est végétarien et ne mange pas de viande.' }
    },
    {
      transcript: 'je suis végétarien',
      reply: 'D’accord, je retiens que tu es végétarien : pas de viande ni de poisson dans mes idées de recettes.',
      note: { title: 'Alimentation', content: 'Léo est végétarien : il ne mange ni viande ni poisson.' }
    },
    {
      transcript: 'je déteste la coriandre',
      reply: 'Beaucoup de gens trouvent que la coriandre a un goût de savon !',
      note: { title: 'Goûts', content: 'Léo n’aime pas la coriandre (goût de savon).' }
    },
    {
      transcript: "je travaille de nuit à l'hôpital",
      reply: 'Travailler de nuit en milieu hospitalier, ça doit être fatigant ! Tu es infirmier ?',
      note: { title: 'Travail', content: 'Léo est infirmier de nuit en milieu hospitalier.' }
    },
    {
      // Un fait dit dans une question : ses mots comptent pour l'utilisateur.
      transcript: 'Je pars au Japon en mars avec ma copine, tu as des conseils ?',
      reply: 'Le Japon en mars, c’est la saison des cerisiers ! Réserve tes hôtels tôt.',
      note: { title: 'Voyages', content: 'Léo part au Japon en mars avec sa copine.' }
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

test('un titre qui désigne l’échange est reconnu, en français comme en anglais — mais pas « Chat » ni « Entretien »', () => {
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
    assert.equal(m.isExchangeTitle(title), true, `titre d'échange : « ${title} »`)
  }
  for (const title of ['Léo', 'Famille', 'Voyage au Japon', 'Présentation de Léo', 'Conversation avec Marie', 'Questions de santé', 'Travail', 'Drinks', 'Chat', 'Le chat', 'Entretien', 'Entretien d’embauche']) {
    assert.equal(m.isExchangeTitle(title), false, `sujet : « ${title} »`)
  }
})

test('un titre d’échange ne jette jamais un vrai fait : la note est gardée sous le prénom, sans rien remplacer', async () => {
  const cases = [
    { transcript: "j'habite à Rennes", reply: 'Rennes, une belle ville !', note: { title: 'Conversation', content: 'Léo habite à Rennes.' } },
    {
      transcript: "je fais une présentation devant mon patron lundi",
      reply: 'Tu vas assurer !',
      note: { title: 'Présentation', content: 'Léo fait une présentation devant son patron lundi.' }
    },
    {
      transcript: 'Je me présente : Léo, 34 ans, développeur à Rennes',
      reply: 'Enchanté Léo ! Développeur, c’est un beau métier.',
      note: { title: 'Présentation de l’utilisateur', content: 'Léo a 34 ans, il est développeur à Rennes.' }
    },
    {
      // replace: true sous un titre changé effacerait la note « Léo » entière (son adresse, ses goûts…) : jamais.
      transcript: 'en fait mon adresse a changé, c’est 8 avenue Foch',
      reply: 'C’est noté : 8 avenue Foch.',
      note: { title: 'Réponse', content: 'Adresse de Léo : 8 avenue Foch.', replace: true }
    }
  ]
  for (const { transcript, reply, note } of cases) {
    const m = load(() => remember(note))
    await m.extractMemoryFromExchange(transcript, reply, m.onLog)
    assert.equal(m.written.length, 1, `gardée : « ${note.content} » (titre « ${note.title} »)`)
    assert.deepEqual({ ...m.written[0] }, { title: 'Léo', content: note.content, replace: false })
    assert.equal(m.logs.length, 1)
    assert.match(m.logs[0], /Léo/, 'annoncée sous son vrai titre')
  }
  // Sans prénom connu : le fait reste, sous le titre du modèle.
  const nameless = load(() => remember({ title: 'Conversation', content: 'L’utilisateur habite à Rennes.' }), { name: null })
  await nameless.extractMemoryFromExchange("j'habite à Rennes", 'Belle ville !', nameless.onLog)
  assert.deepEqual(nameless.written.map((note) => note.title), ['Conversation'])
})

test('sous un titre d’échange, une note qui RACONTE l’échange ou ne reprend pas l’utilisateur est écartée', async () => {
  const transcript = 'Bonjour ! Tu peux te présenter en deux phrases ?'
  const reply = 'Bonjour Léo : je suis Jaris, ton assistant personnel. Je t’aide au quotidien.'
  for (const content of [
    'L’utilisateur a salué Jaris et lui a demandé de se présenter en deux phrases.',
    'Léo veut que Jaris se présente en deux phrases.',
    'Léo est quelqu’un de poli et curieux.'
  ]) {
    const m = load(() => remember({ title: 'Conversation', content }))
    await m.extractMemoryFromExchange(transcript, reply, m.onLog)
    assert.deepEqual(m.written, [], `écartée : « ${content} »`)
    assert.deepEqual(m.logs, [])
  }
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

test('cinq extractions arrêtées de suite, puis une qui aboutit : la phrase du 1er échange est encore lue', async () => {
  // Machine de Léo : environ une minute par extraction, une question toutes les 30 s — aucune ne finit. Avec 3
  // échanges gardés, « ma sœur s'appelle Emma » (1er message) était perdu au 5e sans jamais avoir été lu.
  let answer = hangsUntilAborted
  const m = load((messages, signal) => answer(messages, signal))
  const said = ["ma sœur s'appelle Emma", 'Quel temps fait-il ?', 'Et demain ?', 'Mets de la musique', 'Merci']
  for (const [index, transcript] of said.entries()) {
    const run = m.extractMemoryFromExchange(transcript, `Réponse ${index + 1} de Jaris.`, m.onLog)
    await waitFor(() => m.calls.length === index + 1, `appel ${index + 1}`)
    m.cancelMemoryExtraction()
    await run
  }
  answer = () => remember({ title: 'Famille', content: 'La sœur de Léo s’appelle Emma.' })
  await m.extractMemoryFromExchange('Quelle heure est-il ?', 'Il est 15 h 20.', m.onLog)
  const sent = m.calls.at(-1).messages.at(-1).content
  for (const transcript of [...said, 'Quelle heure est-il ?']) assert.ok(sent.includes(transcript), `encore lu : « ${transcript} »`)
  assert.deepEqual(m.written.map((note) => note.title), ['Famille'])
  assert.deepEqual(m.logs.length, 1, 'aucun arrêt annoncé, seule la note l’est')
})

test('au-delà du plafond, un échange jamais lu n’est pas retiré en silence', async (t) => {
  const infos = []
  const original = console.info
  console.info = (line) => infos.push(String(line))
  t.after(() => {
    console.info = original
  })
  const m = load(hangsUntilAborted)
  for (let index = 0; index < 13; index += 1) {
    const run = m.extractMemoryFromExchange(`phrase ${index + 1}`, 'ok', m.onLog)
    await waitFor(() => m.calls.length === index + 1, `appel ${index + 1}`)
    m.cancelMemoryExtraction()
    await run
  }
  const sent = m.calls.at(-1).messages.at(-1).content
  assert.ok(sent.includes('phrase 2\n') && sent.includes('phrase 13'), '12 échanges gardés')
  assert.ok(!sent.includes('phrase 1\n'), 'le plus ancien est sorti')
  assert.equal(infos.filter((line) => /retiré\(s\) de la file sans avoir été lu/.test(line)).length, 1, 'et c’est dit dans le journal')
  assert.deepEqual(m.logs, [], 'rien à l’écran')
})

test('dans la demande au modèle, les phrases de l’utilisateur restent, les réponses de Jaris sont raccourcies', () => {
  const m = load(() => null)
  const long = (letter, n) => letter.repeat(n)
  const text = m.exchangesForPrompt([
    { transcript: 'ancienne phrase', reply: long('a', 2000) },
    { transcript: 'dernière phrase', reply: long('b', 2000) }
  ])
  assert.match(text, /Utilisateur : ancienne phrase\nJaris : a{300}…\n\nUtilisateur : dernière phrase\nJaris : b{600}…$/)
  // Un très long texte collé dans un vieil échange (un mail à reformuler) ne fait pas déborder la demande.
  assert.ok(m.exchangesForPrompt([{ transcript: long('x', 10000), reply: '' }, { transcript: 'ok', reply: '' }]).length < 1000)
})

test('effacer l’historique vide la file : une info effacée n’est jamais retenue ensuite', async () => {
  let answer = hangsUntilAborted
  const m = load((messages, signal) => answer(messages, signal))
  const run = m.extractMemoryFromExchange("mon code de carte bleue c'est 4821", 'Je ne retiens jamais ce genre de code.', m.onLog)
  await waitFor(() => m.calls.length === 1, 'appel à Ollama')
  m.clearPendingMemoryExchanges()
  await run
  assert.equal(m.calls[0].signal.aborted, true, 'l’extraction en cours est arrêtée')
  answer = () => ({ role: 'assistant', content: '' })
  await m.extractMemoryFromExchange('Quelle heure est-il ?', 'Il est 15 h 20.', m.onLog)
  assert.doesNotMatch(m.calls[1].messages.at(-1).content, /4821/)
  assert.deepEqual(m.logs, [])
})

test('historique effacé alors qu’Ollama avait déjà répondu : la note n’est pas écrite', async () => {
  let release
  const m = load(() => new Promise((resolve) => (release = () => resolve(remember({ title: 'Famille', content: 'La sœur de Léo s’appelle Emma.' })))))
  const run = m.extractMemoryFromExchange("ma sœur s'appelle Emma", 'Joli prénom !', m.onLog)
  await waitFor(() => m.calls.length === 1, 'appel à Ollama')
  // La réponse est en route (le modèle a déjà fini) quand l'utilisateur efface : elle n'est plus lue.
  m.clearPendingMemoryExchanges()
  release()
  await run
  assert.deepEqual(m.written, [])
  assert.deepEqual(m.logs, [])
})

test('Code, Image, Vidéo (écran et téléphone) arrêtent aussi la mémoire ; effacer l’historique ou une conversation vide sa file', () => {
  const main = read('electron/main.ts').replace(/\r\n/g, '\n')
  const before = (start, call) => {
    const from = main.indexOf(start)
    assert.ok(from > -1, `introuvable : ${start}`)
    const body = main.slice(from, main.indexOf(call, from))
    assert.ok(main.indexOf(call, from) > -1, `${call} introuvable après ${start}`)
    return body
  }
  for (const [start, call] of [
    ['IPC_CHANNELS.generateApp,', 'await generateApp('],
    ['IPC_CHANNELS.githubRunAgent,', 'await runGithubAgent('],
    ['IPC_CHANNELS.generateStudioImage,', 'await generateImage('],
    ['IPC_CHANNELS.generateStudioVideo,', 'await generateVideo('],
    ['generateImage: async (prompt, onStatus, signal) => {', 'await generateImage('],
    ['generateVideo: async (prompt, seconds, quality, onStatus, signal) => {', 'await generateVideo(']
  ]) {
    assert.match(before(start, call), /cancelMemoryExtraction\(\)/, `arrêtée avant ${call} (${start})`)
  }
  assert.match(before('IPC_CHANNELS.clearConversationHistory,', 'await clearConversationHistory()'), /clearPendingMemoryExchanges\(\)/)
  assert.match(before('IPC_CHANNELS.deleteConversation,', 'await deleteConversation(id)'), /clearPendingMemoryExchanges\(\)/)
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
