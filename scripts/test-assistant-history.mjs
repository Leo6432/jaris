import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

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

function setup(chat, execute, writeNote = async () => assert.fail('pas de document attendu')) {
  const config = { ollama: { model: 'test', visionModel: 'vision', numCtx: 8192 } }
  const modules = {
    '../config': { config },
    './ollama': { chatWithOllama: chat, listInstalledModels: async () => ['test'] },
    './memoryStore': { listMemoryTitles: async () => [] },
    './profileStore': { getProfile: async () => null },
    './notepad': { requestedNotepadText: noteExports.requestedNotepadText, openNotepadText: writeNote },
    './appLauncher': { didAppLaunch: result => result.endsWith('a été lancé.') },
    './hardwareScan': { GPU_TEMP_LIMIT_C: 85 },
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
