import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { modelChoiceModule } from './load-model-choice.mjs'
import { systemPromptModule } from './load-system-prompt.mjs'

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

function setup(chat, execute, writeNote = async () => assert.fail('pas de document attendu'), { profile = null, installed = ['test'] } = {}) {
  const config = { ollama: { model: 'test', visionModel: 'vision', numCtx: 8192 } }
  const modules = {
    '../config': { config },
    './ollama': { chatWithOllama: chat, listInstalledModels: async () => installed },
    './systemPrompt': systemPromptModule,
    './memoryStore': { listMemoryTitles: async () => [] },
    './profileStore': { getProfile: async () => profile },
    './notepad': { requestedNotepadText: noteExports.requestedNotepadText, openNotepadText: writeNote },
    './appLauncher': { didAppLaunch: result => result.endsWith('a été lancé.') },
    './hardwareScan': { GPU_TEMP_LIMIT_C: 85 },
    './modelChoice': modelChoiceModule,
    './resourceMonitor': { checkOverloadWarning: async () => null },
    './tools': { TOOLS: [], createToolExecutor: () => execute }
  }
  const exports = {}
  vm.runInNewContext(source, { exports, Error, require: name => modules[name] })
  return exports.converse
}

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
    assert.equal(messages.at(-1).content, 'Ne cherche pas sur internet')
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
