import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { modelChoiceModule } from './load-model-choice.mjs'
import { systemPromptModule } from './load-system-prompt.mjs'
import { withI18n } from './i18n-test-module.mjs'
import { loadTsModule } from './load-ts-module.mjs'

// Exécute la vraie boucle de conversation sans Electron ni services externes.
const source = ts.transpileModule(readFileSync(new URL('../electron/services/assistant.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const oldError = "Échec de l'outil : ancien refus 403 SearXNG"
const history = [
  { role: 'user', content: 'Appelle-moi Léo' },
  { role: 'assistant', content: "D'accord Léo" },
  { role: 'user', content: 'Cherche sur internet' },
  { role: 'assistant', content: oldError }
]

const noteExports = {}
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../electron/services/notepad.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, { exports: noteExports, require: name => name === 'util' ? {promisify: () => {}} : {} })

const effortModule = loadTsModule('shared/effort.ts')

function setup(chat, execute, writeNote = async () => assert.fail('pas de document attendu'), { profile = null, installed = ['test'], overloadWarning = null, tools = [], thinking = null } = {}) {
  const config = { ollama: { model: 'test', visionModel: 'vision', numCtx: 8192 } }
  const modules = {
    '../config': { config },
    './ollama': { chatWithOllama: chat, listInstalledModels: async () => installed, getModelThinking: async () => thinking },
    './systemPrompt': systemPromptModule,
    './memoryStore': { listMemoryTitles: async () => [] },
    './profileStore': { getProfile: async () => profile },
    './notepad': { notepadRequest: noteExports.notepadRequest, requestedNotepadText: noteExports.requestedNotepadText, openNotepadText: writeNote },
    './appLauncher': { didAppLaunch: result => result.endsWith('a été lancé.'), launchedAppName: result => (result.endsWith(' a été lancé.') ? result.slice(0, -' a été lancé.'.length) : undefined) },
    './hardwareScan': { GPU_TEMP_LIMIT_C: 85 },
    './modelChoice': modelChoiceModule,
    // Le vrai module (étape 355) : un réglage de réflexion choisi pour un modèle doit pouvoir s'appliquer — ou pas.
    '../../shared/effort': effortModule,
    // Journal des demandes (étape 245) : rien n'est écrit sur le disque pendant les tests.
    // Recherche ouverte dans le navigateur (étape 248) : jamais déclenchée par les phrases de ces tests.
    './browserSearch': { directBrowserSearch: () => undefined, openBrowserSearch: async () => assert.fail('navigateur ouvert à tort') },
    './requestJournal': { startJournalEntry: () => ({ line() {}, timed() {}, end: async () => {} }), describeModelCall: () => '' },
    './resourceMonitor': { checkOverloadWarning: async () => overloadWarning },
    './tools': { TOOLS: tools, createToolExecutor: () => execute }
  }
  const exports = {}
  vm.runInNewContext(source, { exports, Error, require: withI18n(name => modules[name]) })
  return exports.converse
}

/** Étape 355 — les restrictions d'un tour de Duel, comme duelSession.ts les construit. */
const DUEL_TOOLS = ['open_app', 'type_text', 'shutdown_pc'].map((name) => ({ type: 'function', function: { name, description: '', parameters: {} } }))
const duelRestrictions = (model) => ({
  allowedTools: new Set(['open_app', 'type_text']),
  note: '',
  refusal: 'Éteindre le PC est bloqué pendant un duel.',
  model,
  modelOnly: true,
  journalLabel: 'duel'
})

test('Duel : « Salut » et « Ouvre le Bloc-notes » vont au modèle du duel, sans raccourci de Jaris, sans consigne en plus', async () => {
  for (const prompt of ['Salut', 'Ouvre le Bloc-notes', 'ouvre le bloc-notes et écris bonjour']) {
    const seen = []
    const converse = setup(
      async (messages, tools, model, think) => {
        seen.push({ system: messages[0].content, tools: tools.map((t) => t.function.name), model, think })
        return { role: 'assistant', content: 'Réponse du modèle' }
      },
      async () => assert.fail('aucun outil attendu'),
      async () => assert.fail('le raccourci Bloc-notes de Jaris ne doit pas répondre à la place du modèle'),
      {
        tools: DUEL_TOOLS,
        installed: ['test', 'duel-a:7b'],
        // Un réglage de réflexion choisi pour un autre modèle : jamais appliqué en duel.
        profile: { thinkChoices: { chat: { model: 'duel-a:7b', think: 'xhigh' } }, modelChoices: { chat: 'role:large' } },
        thinking: { canThink: true, values: ['low', 'medium', 'xhigh'], default: 'xhigh' }
      }
    )
    assert.equal(await converse(prompt, null, () => {}, undefined, [], undefined, undefined, 'chat', undefined, undefined, undefined, duelRestrictions('duel-a:7b')), 'Réponse du modèle', prompt)
    assert.equal(seen.length, 1, `${prompt} : le modèle doit répondre lui-même`)
    assert.equal(seen[0].model, 'duel-a:7b', 'le modèle du duel, jamais celui choisi pour le Chat')
    assert.notEqual(seen[0].think, 'xhigh')
    assert.deepEqual(seen[0].tools, ['open_app', 'type_text'], 'jamais l’extinction du PC')
    assert.doesNotMatch(seen[0].system, /\n\n$/, 'aucune consigne ajoutée aux consignes de Jaris')
  }
})

test('étape 365 : en duel, la réflexion imposée (la même pour les deux modèles) l’emporte sur le palier de la question', async () => {
  for (const imposed of ['medium', true, false]) {
    const seen = []
    const converse = setup(
      async (_messages, _tools, model, think) => {
        seen.push(think)
        return { role: 'assistant', content: 'Réponse du modèle' }
      },
      async () => assert.fail('aucun outil attendu'),
      undefined,
      { tools: DUEL_TOOLS, installed: ['test', 'duel-a:7b'], thinking: { canThink: true, values: ['low', 'medium', 'xhigh'], default: 'xhigh' } }
    )
    // Une question longue et complexe : sans réflexion imposée, le palier Élevé demanderait « high ».
    const prompt = 'Explique-moi en détail, étape par étape, comment fonctionne un moteur de voiture et compare-le à un moteur électrique.'
    await converse(prompt, null, () => {}, undefined, [], undefined, undefined, 'chat', undefined, undefined, undefined, { ...duelRestrictions('duel-a:7b'), think: imposed })
    assert.deepEqual(seen, [imposed], String(imposed))
  }
})

test('Duel : un modèle qui appelle quand même l’extinction du PC reçoit le refus, et rien n’est exécuté', async () => {
  const converse = setup(
    async () => ({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'shutdown_pc', arguments: {} } }] }),
    async () => assert.fail('l’outil ne doit jamais s’exécuter'),
    undefined,
    { tools: DUEL_TOOLS, installed: ['test', 'duel-b:4b'] }
  )
  assert.equal(
    await converse('Éteins le PC', null, () => {}, undefined, [], undefined, undefined, 'chat', undefined, undefined, undefined, duelRestrictions('duel-b:4b')),
    'Éteindre le PC est bloqué pendant un duel.'
  )
})

test('Duel : un outil qui échoue est signalé avec son erreur d’origine (le Duel sait que ce n’est pas la faute du modèle)', async () => {
  const failures = []
  const blocked = new Error('Recherche impossible : vérification anti-robot.')
  const tools = ['search_web'].map((name) => ({ type: 'function', function: { name, description: '', parameters: {} } }))
  const converse = setup(
    async () => ({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'search_web', arguments: { query: 'météo' } } }] }),
    async () => {
      throw blocked
    },
    undefined,
    { tools, installed: ['test', 'duel-a:7b'] }
  )
  const restrictions = { ...duelRestrictions('duel-a:7b'), allowedTools: new Set(['search_web']), onToolFailure: (tool, error) => failures.push([tool, error]) }
  const reply = await converse('Quel temps fera-t-il ?', null, () => {}, undefined, [], undefined, undefined, 'chat', undefined, undefined, undefined, restrictions)
  assert.match(reply, /anti-robot/)
  assert.equal(failures.length, 1)
  assert.equal(failures[0][0], 'search_web')
  assert.equal(failures[0][1], blocked, 'l’erreur elle-même, pour lire son nom (PageHttpError…)')
})

/**
 * Étape 366 (capture de Léo, duel sur un PC sans carte graphique) : un outil que ce PC ne peut pas faire tourner n'est
 * plus proposé. Le modèle peut quand même l'appeler (il le connaît par les consignes) : il est refusé sans être exécuté,
 * avec SON refus (pas « Éteindre le PC est bloqué »), et le Duel n'est jamais prévenu d'une « panne de Jaris ».
 */
test('Duel : un outil non proposé appelé quand même — refus de CET outil, jamais exécuté, jamais compté comme panne', async () => {
  const failures = []
  const tools = ['open_app', 'generate_image'].map((name) => ({ type: 'function', function: { name, description: '', parameters: {} } }))
  let offered = null
  const converse = setup(
    async (_messages, sent) => {
      offered = sent.map((t) => t.function.name)
      return { role: 'assistant', content: '', tool_calls: [{ function: { name: 'generate_image', arguments: { prompt: 'a slither.io board' } } }] }
    },
    async () => assert.fail('un outil non proposé ne doit jamais être exécuté'),
    undefined,
    { tools, installed: ['test', 'duel-a:7b'] }
  )
  const restrictions = {
    ...duelRestrictions('duel-a:7b'),
    allowedTools: new Set(['open_app']),
    refusalFor: (tool) => (tool === 'shutdown_pc' ? 'Éteindre le PC est bloqué pendant un duel.' : 'Cet outil n’est pas disponible sur ce PC.'),
    onToolFailure: (tool, error) => failures.push([tool, error])
  }
  const reply = await converse('Fais un jeu style slither.io', null, () => {}, undefined, [], undefined, undefined, 'chat', undefined, undefined, undefined, restrictions)
  assert.deepEqual(offered, ['open_app'], 'le dessin n’est même pas présenté au modèle')
  assert.equal(reply, 'Cet outil n’est pas disponible sur ce PC.')
  assert.equal(failures.length, 0, 'pas une panne de Jaris : le choix du modèle')
})

for (const channel of ['chat', 'voice']) {
  test(`${channel} : un ancien échec ne remplace pas une nouvelle recherche`, async () => {
    let toolCalls = 0
    const original = JSON.stringify(history)
    const converse = setup(async messages => {
      // Reproduit le comportement observé du modèle local avant le correctif.
      if (messages.some(m => m.content === oldError)) return { role: 'assistant', content: oldError }
      assert.equal(messages[1].content, 'Appelle-moi Léo')
      assert.equal(messages[2].content, "D'accord Léo")
      assert.ok(!messages.some(m => m.content === 'Cherche sur internet'))
      if (messages.at(-1).role === 'tool') return { role: 'assistant', content: 'Réponse issue de la nouvelle recherche' }
      return { role: 'assistant', content: '', tool_calls: [{ function: { name: 'search_web', arguments: { query: 'président' } } }] }
    }, async () => { toolCalls++; return 'Résultats actuels' })
    assert.equal(await converse('regarde sur internet le président', null, () => {}, undefined, history, undefined, undefined, channel), 'Réponse issue de la nouvelle recherche')
    assert.equal(toolCalls, 1)
    assert.equal(JSON.stringify(history), original, 'ne pas modifier l’historique conservé par la session')
  })
}

test('un véritable échec actuel reste transmis sans reformulation', async () => {
  let modelCalls = 0
  const converse = setup(async () => {
    modelCalls++
    return { role: 'assistant', content: '', tool_calls: [{ function: { name: 'search_web', arguments: {} } }] }
  }, async () => { throw new Error('service indisponible maintenant') })
  assert.equal(await converse('cherche sur internet', null, () => {}), "Échec de l'outil : service indisponible maintenant")
  assert.equal(modelCalls, 1)
})

test('une nouvelle demande sans recherche ne force aucun outil', async () => {
  const converse = setup(async messages => {
    // Étape 256 : la date est devant la demande, plus dans les consignes (cache d'Ollama) — et l'historique reste sans date.
    assert.match(messages.at(-1).content, /^\(Nous sommes le \S+ \d{1,2} \S+ \d{4}, il est \d{2}:\d{2}\.\) Ne cherche pas sur internet$/)
    assert.doesNotMatch(messages[0].content, /Nous sommes le/)
    assert.ok(messages.slice(1, -1).every((m) => !/Nous sommes le/.test(m.content)))
    return { role: 'assistant', content: "D'accord" }
  }, async () => { assert.fail('aucun outil demandé') })
  assert.equal(await converse('Ne cherche pas sur internet', null, () => {}, undefined, history), "D'accord")
})

for (const channel of ['chat', 'voice']) {
  test(`${channel}: un simple salut répond naturellement sans exposer /think`, async () => {
    const converse = setup(
      async () => assert.fail('un simple salut ne doit jamais atteindre le modèle'),
      async () => assert.fail('un simple salut ne doit appeler aucun outil')
    )
    assert.equal(
      await converse('Salut', null, () => {}, undefined, [], undefined, undefined, channel),
      "Salut ! Comment puis-je t'aider ?"
    )
  })
}

test("l'ancienne hallucination /think après un salut est retirée du contexte suivant", async () => {
  const pollutedHistory = [
    { role: 'user', content: 'salut' },
    { role: 'assistant', content: 'Vous avez utilisé le /think, une commande pour que je pensais.' },
    { role: 'user', content: 'Je préfère les réponses courtes.' },
    { role: 'assistant', content: "D'accord." }
  ]
  const converse = setup(async messages => {
    assert.ok(!messages.some(message => message.content.includes('/think')))
    assert.ok(!messages.some(message => message.role === 'user' && message.content === 'salut'))
    assert.ok(messages.some(message => message.content === 'Je préfère les réponses courtes.'))
    return { role: 'assistant', content: 'Compris.' }
  }, async () => assert.fail('aucun outil attendu'))
  assert.equal(await converse('Réponds brièvement', null, () => {}, undefined, pollutedHistory), 'Compris.')
})

test('une question factuelle ne streame jamais le brouillon avant la recherche web', async () => {
  let modelCalls = 0
  const streamed = []
  const finalAnswer = '**Dario&#x20;Amodei** dirige Anthropic. 😊'
  const converse = setup(async (...args) => {
    modelCalls++
    const onToken = args[6]
    if (modelCalls === 1) {
      onToken?.('Je ne sais pas, regarde sur Wikipédia.')
      return { role: 'assistant', content: 'Je ne sais pas, regarde sur Wikipédia.' }
    }
    if (modelCalls === 2) {
      return {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'search_web', arguments: { query: 'Dario Amodei' } } }]
      }
    }
    onToken?.(finalAnswer)
    return { role: 'assistant', content: finalAnswer }
  }, async (name, args) => {
    assert.equal(name, 'search_web')
    assert.equal(args.query, 'Dario Amodei')
    return 'Dario Amodei est le CEO d’Anthropic.'
  })

  const reply = await converse(
    'Qui est Dario Amodei ?',
    null,
    () => {},
    undefined,
    [],
    undefined,
    undefined,
    'chat',
    delta => streamed.push(delta)
  )
  assert.equal(reply, '**Dario Amodei** dirige Anthropic.')
  assert.deepEqual(streamed, ['**Dario Amodei** dirige Anthropic.'])
  assert.equal(modelCalls, 3)
})

test('question de connaissance sans recherche : le brouillon de mémoire n’est jamais remis au modèle, ni présenté comme un reproche', async () => {
  // Léo, « Comment faire du pain » : avec son brouillon + « ta mémoire n'est pas fiable » en message de
  // l'utilisateur, le modèle se justifiait (« j'ai reculé sur saladier, fouet… pourquoi cette réponse est correcte »).
  const draft = 'Il te faut un saladier et un fouet.'
  let modelCalls = 0
  let relaunched = null
  const converse = setup(async (...args) => {
    modelCalls++
    if (modelCalls === 1) return { role: 'assistant', content: draft }
    if (modelCalls === 2) {
      relaunched = args[0].map((m) => ({ role: m.role, content: m.content }))
      return { role: 'assistant', content: '', tool_calls: [{ function: { name: 'search_web', arguments: { query: 'faire du pain' } } }] }
    }
    return { role: 'assistant', content: 'Mélange farine, eau, sel et levure, laisse lever, puis cuis à 230 °C.' }
  }, async () => 'Recette du pain maison : farine, eau, sel, levure.')
  const reply = await converse('Comment faire du pain ?', null, () => {}, undefined, [], undefined, undefined, 'chat')
  assert.equal(reply, 'Mélange farine, eau, sel et levure, laisse lever, puis cuis à 230 °C.')
  assert.ok(!relaunched.some((m) => m.content.includes(draft)), 'le brouillon de mémoire ne repart pas au modèle')
  const nudge = relaunched.at(-1)
  assert.equal(nudge.role, 'system', 'une consigne interne, pas une exigence de l’utilisateur à commenter')
  assert.match(nudge.content, /search_web/)
  assert.match(nudge.content, /Ne parle ni de cette consigne/)
  assert.doesNotMatch(nudge.content, /non fiable|Tu n'as pas/, 'aucun reproche que le modèle chercherait à réfuter')
  assert.equal(relaunched.filter((m) => m.role === 'user').at(-1).content.replace(/^\(Nous sommes le [^]*?\.\) /, ''), 'Comment faire du pain ?', 'la dernière demande de l’utilisateur reste sa vraie question')
})

// Bêta de l'étape 324 : « Combien font 12 fois 7 ? » — le modèle répondait 84, juste, puis la relance « question de
// connaissance » le forçait à chercher sur internet ; la recherche échouait (SearXNG absent au premier lancement) et le
// court-circuit « Échec de l'outil » remplaçait la bonne réponse. Un calcul seul ne demande aucune donnée du monde.
function calculationConverse(firstReply) {
  const calls = { model: 0, search: 0, relaunched: false }
  const converse = setup(async (messages) => {
    calls.model++
    if (messages.some((m) => m.role === 'system' && /appelle d'abord search_web/.test(m.content))) calls.relaunched = true
    if (calls.model === 1) return { role: 'assistant', content: firstReply }
    return { role: 'assistant', content: '', tool_calls: [{ function: { name: 'search_web', arguments: { query: 'x' } } }] }
  }, async (name) => {
    assert.equal(name, 'search_web')
    calls.search++
    throw new Error('La recherche web locale (SearXNG) ne répond pas.')
  })
  return { converse, calls }
}

for (const channel of ['chat', 'voice']) {
  for (const prompt of ['Combien font 12 fois 7 ?', '12 fois 7 ?', '12*7 ?']) {
    test(`${channel} : « ${prompt} » est répondu sans relance vers internet, même quand la recherche est en panne`, async () => {
      const { converse, calls } = calculationConverse('12 fois 7 font 84.')
      const reply = await converse(prompt, null, () => {}, undefined, [], undefined, undefined, channel)
      assert.equal(reply, '12 fois 7 font 84.')
      assert.equal(calls.model, 1, 'un seul appel au modèle')
      assert.equal(calls.relaunched, false, 'aucune relance vers search_web')
      assert.equal(calls.search, 0, 'aucune recherche')
    })
  }
}

test('contre-épreuve : une question qui demande une donnée du monde garde sa relance (et un échec de recherche reste dit)', async () => {
  const { converse, calls } = calculationConverse('Environ 3 € le kilo.')
  const reply = await converse('Combien coûtent 2 kg de pommes ?', null, () => {}, undefined, [], undefined, undefined, 'chat')
  assert.equal(calls.relaunched, true)
  assert.equal(calls.search, 1)
  // Étape 346 : la réponse déjà donnée n'est plus remplacée par l'échec de la recherche imposée — elle est gardée, et
  // dite pour ce qu'elle est (non vérifiée).
  assert.equal(reply, "Je n'ai pas pu vérifier sur internet. De mémoire : Environ 3 € le kilo.")
})

for (const channel of ['voice', 'chat']) {
  for (const app of ['Steam', 'Blocnotes']) {
    test(`${channel}: ouverture explicite de ${app} sans fausse confirmation du modèle`, async () => {
      let calls = 0
      const converse = setup(async () => { assert.fail('aucun appel modèle nécessaire') }, async (name, args) => {
        calls++
        assert.equal(name, 'open_app')
        assert.equal(args.app_name, app)
        return `${app} a été lancé.`
      })
      assert.equal(await converse(`Ouvre l'application ${app}.`, null, () => {}, undefined, [], undefined, undefined, channel), `Demande d'ouverture transmise à Windows pour ${app}.`)
      assert.equal(calls, 1)
    })
  }
}
test('ouverture introuvable : conserver le véritable échec', async () => {
  const converse = setup(async () => assert.fail('pas de modèle'), async () => 'Application introuvable')
  assert.equal(await converse('Ouvre Inconnue', null, () => {}), 'Application introuvable')
})
for (const prompt of ['N’ouvre pas Steam', 'Comment ouvre-t-on Steam ?', 'Ouvre Steam et écris bonjour', 'Ouvre Steam puis ferme-le', 'Ouvre Steam sans lancer de jeu']) {
  test(`pas de routage direct pour ${prompt}`, async () => {
    const converse = setup(async () => ({role:'assistant',content:'Analyse normale'}), async () => assert.fail('pas de lancement direct'))
    assert.equal(await converse(prompt,null,()=>{}),'Analyse normale')
  })
}

// Étape 252 : journal de Léo — « Clique sur la première vidéo de la page » attendait 1 min la réflexion du modèle
// avant même de commencer le pilotage. Une action à l'écran explicite part directement au pilotage.
for (const channel of ['voice', 'chat']) {
  test(`${channel}: « clique sur… » part directement au pilotage, sans réflexion du modèle`, async () => {
    const logs = []
    let calls = 0
    const converse = setup(async () => assert.fail('aucun appel modèle'), async (name, args) => {
      calls++
      assert.equal(name, 'computer_use_task')
      assert.equal(args.goal, 'Clique sur la première vidéo de la page.')
      return 'La vidéo est lancée.'
    })
    assert.equal(await converse('  Clique sur la première   vidéo de la page.', null, () => {}, (m) => logs.push(m), [], undefined, undefined, channel), 'La vidéo est lancée.')
    assert.equal(calls, 1)
    assert.ok(logs.some((l) => /pilotage direct/.test(l)), 'la raison est écrite dans le journal')
  })
}
test('« Sur YouTube, clique sur… » (phrase réelle de Léo) part aussi directement au pilotage', async () => {
  const prompt = 'Sur YouTube, clique sur la barre de recherche et écris tuto guitare et lance la recherche.'
  let goal = null
  const converse = setup(async () => assert.fail('aucun appel modèle'), async (name, args) => { goal = args.goal; return 'Recherche lancée.' })
  assert.equal(await converse(prompt, null, () => {}), 'Recherche lancée.')
  assert.equal(goal, prompt)
})
test('« clique sur… » : un échec du pilotage est transmis tel quel', async () => {
  const converse = setup(async () => assert.fail('aucun appel modèle'), async () => { throw new Error('Je me suis arrêté après 20 étapes') })
  assert.equal(await converse('clique sur le bouton Jouer', null, () => {}), "Échec de l'outil : Je me suis arrêté après 20 étapes")
})
for (const prompt of ['Ne clique pas sur la vidéo', 'Clique pas sur la pub', 'Comment cliquer sur un lien ?', 'Où dois-je cliquer sur la page ?', 'Clique', 'Sur YouTube, ne clique pas sur la pub', 'Sur YouTube, comment cliquer sur un lien ?']) {
  test(`pas de pilotage direct pour : ${prompt}`, async () => {
    const converse = setup(async () => ({ role: 'assistant', content: 'Analyse normale' }), async () => assert.fail('pas de pilotage direct'))
    assert.equal(await converse(prompt, null, () => {}), 'Analyse normale')
  })
}

for (const channel of ['voice', 'chat']) {
  test(`${channel}: ouvrir Bloc-notes et écrire exécute réellement le service`, async () => {
    let calls = 0
    const converse = setup(async () => assert.fail('pas de modèle'), async () => assert.fail('pas de frappe non ciblée'), async text => {
      calls++; assert.equal(text, 'Bonjour.'); return 'Document vérifié'
    })
    assert.equal(await converse("Ouvre l'application Bloc-Notes et écrit Bonjour.", null, () => {}, undefined, [], undefined, undefined, channel), 'Document vérifié')
    assert.equal(calls, 1)
  })
}
test('une fenêtre non confirmée ne produit jamais de succès', async () => {
  const converse = setup(async () => assert.fail('pas de modèle'), async () => {}, async () => { throw new Error('fenêtre absente') })
  assert.match(await converse('Ouvre le bloc notes et écris Bonjour', null, () => {}), /fenêtre absente/)
})
for (const prompt of ['N’ouvre pas le Bloc-notes et écris Bonjour', 'Comment ouvrir le Bloc-notes et écrire Bonjour ?', 'Ouvre Steam et écris Bonjour']) {
  test(`exclut le routage de document : ${prompt}`, () => assert.equal(noteExports.requestedNotepadText(prompt), undefined))
}
test('le texte dicté reste littéral, y compris caractères PowerShell', () => {
  assert.equal(noteExports.requestedNotepadText('Ouvre le Bloc-notes et écris « Bonjour $HOME ; Stop-Process ».'), 'Bonjour $HOME ; Stop-Process')
})

// Étape 141 : sélecteur de modèle (Auto ou un modèle précis) dans le Chat et l'écran vocal.
const threeTiers = { flash: 'rapide:1b', medium: 'moyen:4b', large: 'gros:27b' }
const installedAll = ['rapide:1b', 'moyen:4b', 'gros:27b', 'choisi:9b']

async function modelUsedFor(channel, prompt, profile, installed = installedAll) {
  const used = []
  const converse = setup(async (_messages, _tools, model) => {
    used.push(model)
    return { role: 'assistant', content: 'ok' }
  }, async () => assert.fail('aucun outil'), undefined, { profile, installed })
  await converse(prompt, null, () => {}, undefined, [], undefined, undefined, channel)
  return used
}

test('Auto : rien de choisi à la main, le palier décide exactement comme avant', async () => {
  assert.deepEqual(await modelUsedFor('chat', 'quelle heure est-il', { models: threeTiers }), ['rapide:1b'])
})

for (const channel of ['chat', 'voice']) {
  test(`${channel} : un modèle choisi à la main remplace le palier, quelle que soit la question`, async () => {
    const profile = { models: threeTiers, modelChoices: { [channel]: 'choisi:9b' } }
    assert.deepEqual(await modelUsedFor(channel, 'quelle heure est-il', profile), ['choisi:9b'])
    assert.deepEqual(await modelUsedFor(channel, 'explique en détail et compare deux architectures de processeurs modernes', profile), ['choisi:9b'])
  })
}

test('le choix du Chat ne s’applique pas à la voix (chaque mode a le sien)', async () => {
  const profile = { models: threeTiers, modelChoices: { chat: 'choisi:9b' } }
  assert.deepEqual(await modelUsedFor('voice', 'quelle heure est-il', profile), ['rapide:1b'])
})

test('un modèle choisi puis supprimé d’Ollama retombe sur Auto au lieu de faire échouer chaque réponse', async () => {
  const profile = { models: threeTiers, modelChoices: { chat: 'choisi:9b' } }
  assert.deepEqual(await modelUsedFor('chat', 'quelle heure est-il', profile, ['rapide:1b', 'moyen:4b', 'gros:27b']), ['rapide:1b'])
})

test('un appel d’outil garde le modèle choisi à la main (pas de bascule vers le palier médium)', async () => {
  const used = []
  const converse = setup(async (messages, _tools, model) => {
    used.push(model)
    if (messages.at(-1).role === 'tool') return { role: 'assistant', content: 'fini' }
    return { role: 'assistant', content: '', tool_calls: [{ function: { name: 'search_web', arguments: { query: 'x' } } }] }
  }, async () => 'résultat', undefined, { profile: { models: threeTiers, modelChoices: { chat: 'choisi:9b' } }, installed: installedAll })
  await converse('cherche la météo', null, () => {}, undefined, [], undefined, undefined, 'chat')
  assert.deepEqual(used, ['choisi:9b', 'choisi:9b'])
})

// Étape 234 (bêta) : collé d'un espace à la réponse écrite, l'avertissement se mêlait au texte et cassait un bloc
// de code placé en tête (« ``` » n'est reconnu qu'en début de ligne). À voix haute, un espace suffit.
test('machine chargée : un paragraphe à part à l’écrit, une simple pause à voix haute', async () => {
  const warning = 'Attention, ta machine est assez chargée en ce moment.'
  const answer = '```js\nconsole.log(1)\n```'
  const reply = async (channel) =>
    setup(async () => ({ role: 'assistant', content: answer }), async () => assert.fail('aucun outil'), undefined, { overloadWarning: warning })(
      'montre un exemple de code', null, () => {}, undefined, [], undefined, undefined, channel
    )
  assert.equal(await reply('chat'), `${warning}\n\n${answer}`)
  assert.ok((await reply('voice')).startsWith(`${warning} `))
})

// Campagne de Léo (04/10/2026) : après avoir lu la mémoire, Jaris relançait quand même vers une recherche web, et
// une bonne réponse (« le 14 mars ») devenait « aucun résultat sur internet ». Lire la mémoire ou l'état du PC
// compte comme vérifier : plus de relance.
for (const tool of ['recall_memory', 'get_system_stats']) {
  test(`question de connaissance : aucune relance vers internet après ${tool}`, async () => {
    let modelCalls = 0
    const converse = setup(async (messages) => {
      modelCalls++
      assert.ok(!messages.some((m) => m.role === 'system' && /appelle d'abord search_web/.test(m.content)), 'aucune relance')
      if (messages.at(-1).role === 'tool') return { role: 'assistant', content: "C'est le 14 mars." }
      return { role: 'assistant', content: '', tool_calls: [{ function: { name: tool, arguments: { title: 'Anniversaire de maman' } } }] }
    }, async () => 'Maman est née le 14 mars 1962.')
    assert.equal(await converse("C'est quand déjà l'anniversaire de ma mère ?", null, () => {}), "C'est le 14 mars.")
    assert.equal(modelCalls, 2)
  })
}


// Étape 261 (démo mail de Léo) : « Reformule ce mail : … » était pris pour une demande d'ENVOI — après le mail réécrit,
// Jaris relançait le modèle vers l'envoi par le pilote, et la réponse affichée était celle d'après cette relance.
for (const channel of ['chat', 'voice']) {
  test(`${channel} : réécrire un mail n'est pas l'envoyer — le mail reformulé est la réponse, sans relance`, async () => {
    const seen = []
    const converse = setup(async (messages) => {
      seen.push(messages.at(-1).content)
      return { role: 'assistant', content: 'Bonjour, sauf erreur de notre part, la facture n°2024-118 reste impayée.' }
    }, async () => assert.fail('aucun outil attendu'))
    const reply = await converse("Reformule ce mail pour qu'il soit professionnel : Bonjour, la facture n°2024-118 devait etre payer, merci de m'envoyer le reglement", null, () => {}, undefined, [], undefined, undefined, channel)
    assert.equal(reply, 'Bonjour, sauf erreur de notre part, la facture n°2024-118 reste impayée.')
    assert.equal(seen.length, 1, 'aucune relance vers un envoi')
  })
}

test('une vraie demande d’envoi garde sa relance vers le pilote', async () => {
  const seen = []
  const converse = setup(async (messages) => {
    seen.push(messages.at(-1).content)
    return { role: 'assistant', content: 'Voici le mail.' }
  }, async () => 'ok')
  await converse('Envoie un mail à paul.morel@example.fr pour lui dire que je serai en retard', null, () => {}, undefined, [], undefined, undefined, 'chat')
  assert.ok(seen.some((c) => /n'as pas encore appelé computer_use_task/.test(c)))
})


// Étape 262 : un mail RÉDIGÉ peut finir par « Je vais… » sans que ce soit une action de Jaris (vérifié avec le vrai
// détecteur) — la relance « promesse sans action » faisait répondre une justification à la place du mail.
const DRAFT = 'Bonjour,\n\nVotre commande est partie hier, numéro de suivi FR4589221. Je vais personnellement suivre son acheminement.\n\nCordialement,\nMarc'
for (const channel of ['chat', 'voice']) {
  test(`${channel} : un mail rédigé qui contient « je vais… » est rendu tel quel, sans relance`, async () => {
    let calls = 0
    const converse = setup(async () => { calls++; return { role: 'assistant', content: DRAFT } }, async () => assert.fail('aucun outil attendu'))
    const reply = await converse('Aide moi a repondre a ce client mecontent, voici son message : « toujours rien recu »', null, () => {}, undefined, [], undefined, undefined, channel)
    assert.match(reply, /FR4589221/)
    assert.equal(calls, 1)
  })
}

test('une vraie action annoncée sans outil garde sa relance', async () => {
  let calls = 0
  const converse = setup(async () => { calls++; return { role: 'assistant', content: 'Je vais monter le volume.' } }, async () => 'ok')
  await converse('Mets le volume plus fort', null, () => {}, undefined, [], undefined, undefined, 'chat')
  assert.equal(calls, 2)
})

// --- Étape 346 ---------------------------------------------------------------------------------------------------
import { i18nModule } from './i18n-test-module.mjs'

test('étape 346 : après une action réussie (ouvrir une application), aucune relance vers une recherche web', async () => {
  let model = 0
  let relaunched = false
  const converse = setup(async (messages) => {
    model++
    if (messages.some((m) => m.role === 'system' && /appelle d'abord search_web/.test(m.content))) relaunched = true
    if (model === 1) return { role: 'assistant', content: '', tool_calls: [{ function: { name: 'media_control', arguments: { action: 'volume_up' } } }] }
    return { role: 'assistant', content: 'Le son est monté.' }
  }, async (name) => (name === 'media_control' ? 'Action "volume_up" effectuée.' : assert.fail(`outil inattendu : ${name}`)))
  assert.equal(await converse('Tu peux monter le son ?', null, () => {}, undefined, [], undefined, undefined, 'chat'), 'Le son est monté.')
  assert.equal(relaunched, false)
  assert.equal(model, 2)
})

test('étape 346 : dans une autre langue que le français, les filets français (recherche, mail) ne relancent pas', async () => {
  const before = i18nModule.currentLanguage()
  i18nModule.setLanguage('en')
  try {
    let model = 0
    const converse = setup(async () => {
      model++
      return { role: 'assistant', content: 'Paris.' }
    }, async () => assert.fail('aucun outil'))
    assert.equal(await converse('Quelle est la capitale de la France ?', null, () => {}, undefined, [], undefined, undefined, 'chat'), 'Paris.')
    assert.equal(model, 1)
  } finally {
    i18nModule.setLanguage(before)
  }
})

for (const prompt of [
  "Rappelle-moi d'envoyer un mail à Paul dans une heure",
  "Je viens d'envoyer un mail à Paul",
  'Comment envoyer un mail avec Gmail ?',
  'Envoie-moi un rappel dans 10 minutes',
  'Retiens que je dois envoyer un mail à Paul',
  "Programme l'envoi d'un mail à Paul pour dans une heure, rappel compris"
]) {
  test(`étape 346 : pas de relance « envoie le mail » pour : ${prompt}`, async () => {
    let model = 0
    const converse = setup(async (messages) => {
      model++
      assert.ok(!messages.some((m) => /appelé computer_use_task alors qu'un envoi de mail/.test(m.content)), 'relance mail inattendue')
      if (model === 1 && /rappel/i.test(prompt)) return { role: 'assistant', content: '', tool_calls: [{ function: { name: 'set_reminder', arguments: { message: 'Mail', delay_minutes: 10 } } }] }
      if (model === 1 && /retiens/i.test(prompt)) return { role: 'assistant', content: '', tool_calls: [{ function: { name: 'remember', arguments: { title: 'Paul', content: 'mail' } } }] }
      return { role: 'assistant', content: "D'accord." }
    }, async () => 'Fait.')
    assert.equal(await converse(prompt, null, () => {}, undefined, [], undefined, undefined, 'chat'), "D'accord.")
  })
}

test('étape 346 : une vraie demande d’envoi garde sa relance, même avec « tu sais » plus loin', async () => {
  let relaunched = false
  let model = 0
  const converse = setup(async (messages) => {
    model++
    if (messages.some((m) => /appelé computer_use_task alors qu'un envoi de mail/.test(m.content))) relaunched = true
    return { role: 'assistant', content: model === 1 ? 'Quel est son adresse ?' : 'Il me faut son adresse.' }
  }, async () => assert.fail('aucun outil'))
  await converse('Envoie un mail à Paul, tu sais celui de la compta', null, () => {}, undefined, [], undefined, undefined, 'chat')
  assert.equal(relaunched, true)
})

for (const [prompt, text] of [
  ['Ouvre un bloc-notes et écris bonjour', 'bonjour'],
  ['Ouvre le bloc note, écris bonjour', 'bonjour'],
  ['Ouvre le blocknote. Écris bonjour', 'bonjour'],
  ['Ouvre-moi le bloc-notes et écris-moi : une liste de courses', 'une liste de courses'],
  ['Écris bonjour dans le bloc-notes', 'bonjour'],
  ['Lance un nouveau bloc-notes et tape « salut »', 'salut']
]) {
  test(`étape 346 : Bloc-notes reconnu : ${prompt}`, () => {
    assert.deepEqual(JSON.parse(JSON.stringify(noteExports.notepadRequest(prompt))), { kind: 'literal', text })
  })
}

for (const prompt of ['Ouvre le bloc-notes et écris bonjour puis enregistre-le', 'Ouvre le bloc-notes et écris bonjour et ferme-le']) {
  test(`étape 346 : une autre action après le texte reste au modèle : ${prompt}`, () => {
    assert.equal(noteExports.notepadRequest(prompt), undefined)
  })
}

test('étape 346 : « écris un poème sur la mer » fait rédiger le texte, puis l’ouvre par le chemin sûr', async () => {
  assert.equal(noteExports.notepadRequest('Ouvre le bloc-notes et écris un poème sur la mer').kind, 'compose')
  assert.equal(noteExports.notepadRequest('Ouvre le bloc-notes et écris une lettre à ma mère').kind, 'compose')
  let written = null
  const converse = setup(async (messages, tools) => {
    assert.equal(tools, undefined, 'aucun outil pour rédiger')
    assert.equal(messages.at(-1).content, 'un poème sur la mer')
    return { role: 'assistant', content: 'La mer chante\nsous la lune.' }
  }, async () => assert.fail('aucune frappe'), async (text) => {
    written = text
    return 'Document ouvert'
  })
  assert.equal(await converse('Ouvre le bloc-notes et écris un poème sur la mer', null, () => {}), 'Document ouvert')
  assert.equal(written, 'La mer chante\nsous la lune.')
})

// Étape 346 : « Arrêter » ou une nouvelle phrase n'interrompaient pas un outil en cours (regarder l'écran, chercher sur
// internet) — Jaris restait bloqué jusqu'à la fin de l'outil, parfois des minutes.
test('un outil qui ne s’arrête pas tout seul est quand même interrompu tout de suite par l’annulation', async () => {
  let toolStarted
  const started = new Promise((resolve) => (toolStarted = resolve))
  const converse = setup(
    async () => ({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'look_at_screen', arguments: {} } }] }),
    () => {
      toolStarted()
      return new Promise(() => {}) // ne répond jamais
    }
  )
  const controller = new AbortController()
  const reply = converse('regarde mon écran', null, () => {}, undefined, [], controller.signal)
  await started
  const before = Date.now()
  controller.abort()
  await assert.rejects(reply, { name: 'AbortError' })
  assert.ok(Date.now() - before < 1000, 'sans attendre la fin de l’outil')
})

test('sans annulation, un outil lent va jusqu’au bout comme avant', async () => {
  const converse = setup(
    async (messages) =>
      messages.at(-1).role === 'tool'
        ? { role: 'assistant', content: 'C’est noté, je te le rappelle dans 5 minutes.' }
        : { role: 'assistant', content: '', tool_calls: [{ function: { name: 'set_reminder', arguments: { message: 'thé', delay_minutes: 5 } } }] },
    () => new Promise((resolve) => setTimeout(() => resolve('Rappel programmé.'), 30))
  )
  const controller = new AbortController()
  const reply = await converse('rappelle-moi le thé dans 5 minutes', null, () => {}, undefined, [], controller.signal)
  assert.equal(reply, 'C’est noté, je te le rappelle dans 5 minutes.')
})
