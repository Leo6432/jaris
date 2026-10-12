import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * État GitHub du mode Code côté main (étape 277), avec un faux GitHub et un faux modèle. Verrouillé ici :
 *  - tout reste masqué tant qu'aucune application GitHub n'est configurée ;
 *  - un changement qui revient à l'état de GitHub disparaît de la liste (Léo ne relit pas un faux changement) ;
 *  - des changements en attente ne sont jamais jetés en silence (réouverture, changement de branche) ;
 *  - « Enregistrer » envoie EXACTEMENT les changements affichés, puis repart de la nouvelle version ;
 *  - une connexion retirée sur github.com déconnecte proprement, jeton effacé.
 */

const electron = { app: { getPath: () => '/donnees' }, safeStorage: { isEncryptionAvailable: () => false } }
const realGithub = loadTsModule('electron/services/github.ts', {
  electron,
  'fs/promises': { readFile: async () => Buffer.from(''), writeFile: async () => {}, rm: async () => {} },
  path: { join },
  './dataLocation': { getDataRoot: () => '/donnees' }
})
const lineDiff = loadTsModule('shared/lineDiff.ts')
const repoAgent = loadTsModule('electron/services/repoAgent.ts', { '../../shared/lineDiff': lineDiff })

class GenerationStoppedError extends Error {}

function setup({ clientId = 'cid', token = null, files = { 'README.md': '# Projet\nBonjour\n', 'src/a.js': 'let a = 1\n' }, replies = [] } = {}) {
  const state = { token, unreadable: false, memoryOnly: false, record: null, openCount: 0, commits: [], failAuth: false, files: { ...files }, cleared: 0 }
  class FakeClient {
    constructor(value) {
      this.token = value
    }
    async viewer() {
      if (state.failAuth) throw new realGithub.GithubError(401, 'retiré', 'auth')
      return state.login ?? 'leo'
    }
    async listRepos() {
      if (state.failAuth) throw new realGithub.GithubError(401, 'Reconnecte-toi', 'auth')
      return [{ fullName: 'leo/projet', private: true, description: null, defaultBranch: 'main', pushedAt: null }]
    }
    async listBranches() {
      return ['main', 'dev']
    }
    async openRepo(fullName, branch) {
      state.openCount += 1
      return {
        owner: 'leo',
        repo: 'projet',
        fullName: 'leo/projet',
        branch: branch ?? 'main',
        defaultBranch: 'main',
        private: true,
        htmlUrl: 'https://github.com/leo/projet',
        commitSha: `commit${state.commits.length}`,
        treeSha: `tree${state.commits.length}`,
        // Comme le vrai GitHub : l'empreinte (sha) change avec le contenu du fichier.
        files: Object.keys(state.files).map((path) => ({ path, sha: `${path}:${state.files[path]}`, size: 10, mode: '100644' })),
        truncated: false
      }
    }
    async readText(_snapshot, file) {
      // Étape 308 : un refus isolé (le jeton marche encore) ou un jeton vraiment retiré.
      if (state.failAuth) throw new realGithub.GithubError(401, 'Reconnecte-toi', 'auth')
      if (state.failReads > 0) {
        state.failReads -= 1
        throw new realGithub.GithubError(401, 'Reconnecte-toi', 'auth')
      }
      return state.files[file.path]
    }
    async readBytes(_snapshot, file) {
      state.byteReads = (state.byteReads ?? 0) + 1
      return Buffer.from(state.files[file.path])
    }
    async commit(snapshot, changes, message) {
      const after = { ...state.files }
      for (const change of changes) {
        if (change.content === null) delete after[change.path]
        else after[change.path] = change.content
      }
      // Comme le vrai GitHub (étape 306, essai réel sur une branche jetable) : une branche sans aucun fichier est
      // refusée par « 404 Not Found » à la création de l'arbre, et rien ne change sur GitHub.
      if (Object.keys(after).length === 0) throw new realGithub.GithubError(404, 'Introuvable sur GitHub')
      state.commits.push({ base: snapshot.commitSha, changes, message })
      state.files = after
      return { sha: `sha${state.commits.length}`, url: `https://github.com/leo/projet/commit/sha${state.commits.length}` }
    }
  }
  const config = { config: { github: { clientId }, ollama: { visionModel: 'vision-model' } } }
  const session = loadTsModule('electron/services/githubSession.ts', {
    '../config': config,
    '../../shared/effort': { chosenThink: () => undefined },
    './codeGenerator': {
      GenerationStoppedError,
      isAbortError: (err) => err?.name === 'AbortError',
      readModelMaxContext: async () => null,
      resolveCodeModel: async () => {
        state.order = [...(state.order ?? []), 'code']
        return 'code-model'
      },
      // Étape 298 : l'image d'un dépôt passe par la même lecture que celle d'une nouvelle application.
      describeImageForCode: async (base64, visionModel) => {
        state.order = [...(state.order ?? []), 'vision']
        state.described = [base64, visionModel]
        return 'DESCRIPTION DE LA CAPTURE'
      },
      withImageDescription: (base, description) => (description ? `${base}\n\n${description}` : base),
      createModelStepRunner: ({ signal }) => async (_label, messages, _chars, tools) => {
        state.prompts = [...(state.prompts ?? []), messages]
        // Étape 281 : jamais d'outils déclarés à Ollama (ils rendaient l'écriture muette pendant des minutes).
        if (tools !== undefined) throw new Error('des outils ont été déclarés à Ollama')
        if (signal?.aborted) throw Object.assign(new Error('stop'), { name: 'AbortError' })
        const next = replies.shift()
        if (!next) throw new Error('plus de réponse simulée')
        return typeof next === 'function' ? next() : next
      }
    },
    './github': {
      ...realGithub,
      GithubClient: FakeClient,
      readGithubToken: async () => ({ token: state.token, unreadable: !state.token && state.unreadable }),
      saveGithubToken: async (value) => {
        state.token = value
        return !state.memoryOnly
      },
      clearGithubToken: async () => {
        state.token = null
        state.cleared += 1
      },
      readConnectionRecord: async () => (state.record ? { ...state.record } : null),
      writeConnectionRecord: async (record) => {
        state.record = { ...record }
      },
      clearConnectionRecord: async () => {
        state.record = null
      },
      requestDeviceCode: async () => ({ deviceCode: 'd', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: Infinity, intervalMs: 1 }),
      pollDeviceToken: async () => 'gho_nouveau'
    },
    './ollama': { getModelThinking: async () => null },
    './profileStore': { getProfile: async () => ({}) },
    './repoAgent': repoAgent
  })
  return { session, state }
}

const call = (name, args) => ({ function: { name, arguments: args } })
const reply = (...calls) => ({ role: 'assistant', content: '', tool_calls: calls })

test('sans application GitHub configurée, tout est masqué', async () => {
  const { session } = setup({ clientId: '' })
  assert.deepEqual(await session.getGithubStatus(), { available: false, connected: false, login: null })
  await assert.rejects(session.startGithubLogin(), /pas encore configurée/)
})

test('connexion par code : le code est rendu à l’écran, puis le compte connecté est reconnu', async () => {
  const { session, state } = setup()
  assert.deepEqual(await session.getGithubStatus(), { available: true, connected: false, login: null, lost: null })
  const code = await session.startGithubLogin()
  assert.deepEqual(code, { userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' })
  assert.equal(Object.keys(code).includes('deviceCode'), false, 'le code interne ne doit jamais partir vers l’écran')
  assert.deepEqual(await session.finishGithubLogin(), { available: true, connected: true, login: 'leo' })
  assert.equal(state.token, 'gho_nouveau')
})

test('l’agent prépare des changements ; un fichier remis à l’identique disparaît de la liste', async () => {
  const { session, state } = setup({
    token: 't',
    replies: [
      reply(call('read_file', { path: 'README.md' }), call('read_file', { path: 'src/a.js' })),
      reply(call('edit_file', { path: 'README.md', old_text: 'Bonjour', new_text: 'Salut' })),
      reply(call('edit_file', { path: 'src/a.js', old_text: '1', new_text: '2' })),
      // Le modèle se ravise : src/a.js revient exactement à la version de GitHub.
      reply(call('edit_file', { path: 'src/a.js', old_text: '2', new_text: '1' })),
      reply(call('write_file', { path: 'docs/guide.md', content: '# Guide\n' })),
      reply(call('finish', { summary: 'README corrigé et guide ajouté.' }))
    ]
  })
  await session.openGithubRepo('leo/projet')
  const result = await session.runGithubAgent('leo/projet', 'Corrige', { onStatus: () => {} })
  assert.equal(result.summary, 'README corrigé et guide ajouté.')
  // Étape 303 : travail allé à son terme → l'écran peut l'enregistrer tout seul sur GitHub.
  assert.equal(result.finished, true)
  assert.deepEqual(
    result.view.changes.map((change) => [change.path, change.kind]),
    [
      ['docs/guide.md', 'added'],
      ['README.md', 'modified']
    ]
  )
  const readme = result.view.changes.find((change) => change.path === 'README.md')
  assert.equal(readme.before, '# Projet\nBonjour\n')
  assert.equal(readme.after, '# Projet\nSalut\n')
  assert.equal(result.view.fileCount, 3)
  assert.equal(state.commits.length, 0, 'rien ne doit partir sur GitHub sans le clic « Enregistrer »')
})

test('des changements en attente ne sont jamais jetés : réouverture identique, changement de branche refusé', async () => {
  const { session, state } = setup({
    token: 't',
    replies: [reply(call('write_file', { path: 'nouveau.txt', content: 'x' })), reply(call('finish', { summary: 'ok' }))]
  })
  await session.openGithubRepo('leo/projet')
  await session.runGithubAgent('leo/projet', 'Ajoute', { onStatus: () => {} })
  const opens = state.openCount
  const again = await session.openGithubRepo('LEO/projet')
  assert.equal(again.changes.length, 1)
  assert.equal(state.openCount, opens, 'le dépôt ne doit pas être relu (les changements seraient perdus)')
  await assert.rejects(session.openGithubRepo('leo/projet', 'dev'), /avant de changer de branche/)
})

test('« Enregistrer » envoie exactement les changements affichés, puis repart de la nouvelle version', async () => {
  const { session, state } = setup({
    token: 't',
    replies: [
      reply(call('read_file', { path: 'src/a.js' })),
      reply(call('delete_file', { path: 'src/a.js' }), call('write_file', { path: 'b.js', content: 'b' })),
      reply(call('finish', { summary: 'ok' }))
    ]
  })
  await session.openGithubRepo('leo/projet')
  const { view } = await session.runGithubAgent('leo/projet', 'Remplace a par b', { onStatus: () => {} })
  const result = await session.commitGithubChanges('leo/projet', '  Remplace a par b  ')
  assert.equal(state.commits.length, 1)
  assert.equal(state.commits[0].base, 'commit0')
  assert.equal(state.commits[0].message, 'Remplace a par b')
  assert.deepEqual(
    state.commits[0].changes.map((change) => change.path).sort(),
    view.changes.map((change) => change.path).sort()
  )
  assert.equal(result.url, 'https://github.com/leo/projet/commit/sha1')
  assert.equal(result.view.changes.length, 0)
  // Nouvelle base : le commit suivant partira bien de la version qui vient d'être enregistrée.
  assert.ok(state.openCount >= 2)
  await assert.rejects(session.commitGithubChanges('leo/projet', 'rien'), /aucun changement/)
})

// Étape 306, Léo : « je lui demande de tout supprimer… ça met Introuvable sur GitHub, et sur GitHub rien n'a changé ».
test('« tout supprimer » : un README.md reste, Jaris le dit, et l’enregistrement passe au lieu d’un 404', async () => {
  const { session, state } = setup({
    token: 't',
    replies: [
      reply(call('delete_file', { path: 'README.md' }), call('delete_file', { path: 'src/a.js' })),
      reply(call('finish', { summary: 'Tout est supprimé.' }))
    ]
  })
  await session.openGithubRepo('leo/projet')
  const { summary, view } = await session.runGithubAgent('leo/projet', 'Supprime tout', { onStatus: () => {} })
  assert.deepEqual(
    view.changes.map((change) => `${change.kind} ${change.path}`).sort(),
    ['deleted src/a.js', 'modified README.md'],
    'le README gardé doit apparaître dans les changements, pas être ajouté en cachette à l’envoi'
  )
  assert.match(summary, /Tout est supprimé\.\n\nGitHub n'accepte pas une branche sans aucun fichier/)
  await session.commitGithubChanges('leo/projet', 'Supprime tout')
  assert.deepEqual(state.files, { 'README.md': '# projet\n' })
})

test('« tout supprimer » puis annuler le README : l’enregistrement le remet quand même, jamais un 404', async () => {
  const { session, state } = setup({
    token: 't',
    files: { 'index.html': '<h1>Site</h1>' },
    replies: [reply(call('delete_file', { path: 'index.html' })), reply(call('finish', { summary: 'ok' }))]
  })
  await session.openGithubRepo('leo/projet')
  await session.runGithubAgent('leo/projet', 'Supprime tout', { onStatus: () => {} })
  session.discardGithubChanges('leo/projet', 'README.md')
  await session.commitGithubChanges('leo/projet', 'Supprime tout')
  assert.deepEqual(state.files, { 'README.md': '# projet\n' })
})

test('annuler un fichier, puis tout annuler', async () => {
  const { session } = setup({
    token: 't',
    replies: [reply(call('write_file', { path: 'a.txt', content: 'a' }), call('write_file', { path: 'b.txt', content: 'b' })), reply(call('finish', { summary: 'ok' }))]
  })
  await session.openGithubRepo('leo/projet')
  await session.runGithubAgent('leo/projet', 'x', { onStatus: () => {} })
  assert.deepEqual(
    session.discardGithubChanges('leo/projet', 'a.txt').changes.map((change) => change.path),
    ['b.txt']
  )
  assert.equal(session.discardGithubChanges('leo/projet').changes.length, 0)
})

test('« Arrêter » devient un arrêt voulu, et ce qui était préparé avant reste annulable', async () => {
  const controller = new AbortController()
  const { session } = setup({
    token: 't',
    replies: [
      () => {
        controller.abort()
        return reply(call('write_file', { path: 'a.txt', content: 'a' }))
      }
    ]
  })
  await session.openGithubRepo('leo/projet')
  await assert.rejects(session.runGithubAgent('leo/projet', 'x', { onStatus: () => {}, signal: controller.signal }), GenerationStoppedError)
  assert.equal((await session.openGithubRepo('leo/projet')).changes.length, 1)
})

test('une connexion retirée sur github.com déconnecte proprement et efface le jeton', async () => {
  const { session, state } = setup({ token: 't' })
  assert.equal((await session.getGithubStatus()).connected, true)
  state.failAuth = true
  await assert.rejects(session.listGithubRepos(), /Reconnecte-toi/)
  assert.equal(state.token, null)
  assert.equal(state.cleared, 1)
  assert.equal((await session.getGithubStatus()).connected, false)
})

// Étape 308, Léo : « ça met encore Ta connexion à GitHub n'est plus valable… pendant qu'il code ».
test('un refus isolé pendant le travail ne déconnecte plus : GitHub confirme le jeton, la lecture est refaite', async () => {
  const { session, state } = setup({
    token: 't',
    replies: [reply(call('read_file', { path: 'README.md' })), reply(call('finish', { summary: 'lu' }))]
  })
  await session.openGithubRepo('leo/projet')
  state.failReads = 1
  await session.runGithubAgent('leo/projet', 'Lis le README', { onStatus: () => {} })
  const results = state.prompts.at(-1).filter((m) => m.role === 'user' && m.content.startsWith('Résultat de read_file'))
  assert.match(results.at(-1).content, /# Projet/, 'la lecture refaite rend bien le fichier')
  assert.equal(state.cleared, 0, 'le jeton n’est jamais effacé pour un refus isolé')
  assert.equal(state.token, 't')
  assert.equal((await session.getGithubStatus()).connected, true)
})

test('jeton vraiment retiré en plein travail : le travail préparé est gardé et part après reconnexion au même compte', async () => {
  const { session, state } = setup({
    token: 't',
    replies: [
      reply(call('write_file', { path: 'jeu.js', content: 'let score = 0\n' })),
      reply(call('read_file', { path: 'README.md' })),
      reply(call('finish', { summary: 'fait' }))
    ]
  })
  // Comme après une vraie connexion : la trace existe, et /user y ajoute le nom du compte.
  state.record = { connectedAt: 1, login: null, memoryOnly: false, rejectedAt: null }
  await session.getGithubStatus()
  await session.openGithubRepo('leo/projet')
  // GitHub refuse désormais le jeton partout, /user compris : il est vraiment mort.
  state.failAuth = true
  await session.runGithubAgent('leo/projet', 'Ajoute le jeu', { onStatus: () => {} })
  assert.equal(state.token, null, 'un jeton refusé par /user aussi est bien effacé')
  assert.equal((await session.getGithubStatus()).lost?.reason, 'rejected')
  // Reconnexion au même compte : le fichier préparé n'a pas été jeté.
  state.failAuth = false
  await session.startGithubLogin()
  await session.finishGithubLogin()
  await session.commitGithubChanges('leo/projet', 'Ajoute le jeu')
  assert.deepEqual(state.commits[0].changes.map((change) => change.path), ['jeu.js'])
})

test('reconnexion avec un AUTRE compte : les changements préparés pour l’ancien ne sont jamais repris', async () => {
  const { session, state } = setup({
    token: 't',
    replies: [reply(call('write_file', { path: 'jeu.js', content: 'x\n' })), reply(call('read_file', { path: 'README.md' })), reply(call('finish', { summary: 'fait' }))]
  })
  state.record = { connectedAt: 1, login: null, memoryOnly: false, rejectedAt: null }
  await session.getGithubStatus()
  await session.openGithubRepo('leo/projet')
  state.failAuth = true
  await session.runGithubAgent('leo/projet', 'Ajoute le jeu', { onStatus: () => {} })
  state.failAuth = false
  state.login = 'quelquun-dautre'
  await session.startGithubLogin()
  await session.finishGithubLogin()
  await assert.rejects(session.commitGithubChanges('leo/projet', 'x'), /plus ouvert/)
})

// Étape 297 (Léo : « ça déconnecte GitHub tous les jours ») : la déconnexion suivante dit ce qui s'est passé.
test('déconnexion : la vraie raison est notée et rendue à l’écran', async () => {
  // GitHub refuse le jeton en cours d'usage.
  let { session, state } = setup()
  await session.startGithubLogin()
  await session.finishGithubLogin()
  assert.equal(state.record.login, 'leo', 'le compte est noté une fois connu')
  assert.equal(state.record.memoryOnly, false)
  state.failAuth = true
  await assert.rejects(session.listGithubRepos())
  let status = await session.getGithubStatus()
  assert.equal(status.connected, false)
  assert.equal(status.lost.reason, 'rejected')
  assert.equal(status.lost.login, 'leo')

  // Le fichier du jeton a disparu entre deux lancements.
  ;({ session, state } = setup())
  state.record = { connectedAt: 5, login: 'leo', memoryOnly: false, rejectedAt: null }
  assert.equal((await session.getGithubStatus()).lost.reason, 'missing')

  // Il est là, mais Windows n'a pas su le relire.
  ;({ session, state } = setup())
  state.record = { connectedAt: 5, login: 'leo', memoryOnly: false, rejectedAt: null }
  state.unreadable = true
  assert.equal((await session.getGithubStatus()).lost.reason, 'unreadable')

  // Il n'avait jamais pu être chiffré : noté à la connexion, puis perdu à la fermeture (relance simulée).
  ;({ session, state } = setup())
  state.memoryOnly = true
  await session.startGithubLogin()
  await session.finishGithubLogin()
  assert.equal(state.record.memoryOnly, true)
  const relaunched = setup()
  relaunched.state.record = state.record
  assert.equal((await relaunched.session.getGithubStatus()).lost.reason, 'memoryOnly')
})

test('se déconnecter soi-même efface la trace ; jamais connecté : rien à expliquer', async () => {
  const { session, state } = setup()
  assert.equal((await session.getGithubStatus()).lost, null)
  await session.startGithubLogin()
  await session.finishGithubLogin()
  await session.logoutGithub()
  assert.equal(state.record, null)
  assert.equal((await session.getGithubStatus()).lost, null)
})

// Étape 298 (Léo : « en plein chat, on n'a pas le bouton image ») : une capture jointe sur un dépôt ouvert.
test('dépôt ouvert : l’image est lue AVANT le modèle de code, et sa description part avec la demande', async () => {
  const { session, state } = setup({ token: 't', replies: [reply(call('finish', { summary: 'Fait.' }))] })
  await session.openGithubRepo('leo/projet')
  await session.runGithubAgent('leo/projet', 'Reproduis ce site', { onStatus: () => {}, imageBase64: 'QUJD' })
  assert.deepEqual(state.described, ['QUJD', 'vision-model'])
  assert.deepEqual(state.order, ['vision', 'code'], 'jamais deux modèles chargés à la fois')
  const sent = JSON.stringify(state.prompts[0])
  assert.match(sent, /Reproduis ce site/)
  assert.match(sent, /DESCRIPTION DE LA CAPTURE/)
  assert.doesNotMatch(sent, /QUJD/, 'le modèle de code ne reçoit jamais l’image elle-même')
})

test('dépôt ouvert sans image : rien n’est lu par le modèle de vision', async () => {
  const { session, state } = setup({ token: 't', replies: [reply(call('finish', { summary: 'Fait.' }))] })
  await session.openGithubRepo('leo/projet')
  await session.runGithubAgent('leo/projet', 'Corrige', { onStatus: () => {} })
  assert.equal(state.described, undefined)
})

test('le budget d’historique suit la mémoire du modèle, sans jamais tomber trop bas', () => {
  const { session } = setup()
  assert.equal(session.historyBudgetChars(null), 90_000)
  assert.equal(session.historyBudgetChars(32768), 40_960)
  assert.equal(session.historyBudgetChars(8192), 20_000)
})

/** Étape 287 (Léo : « pouvoir jouer directement et tester un vrai aperçu ») */
test('la page d’accueil du site : index.html à la racine, sinon un dossier de publication, sinon la moins profonde', () => {
  const { session } = setup()
  assert.equal(session.findPreviewEntry(['README.md', 'src/a.js']), null)
  assert.equal(session.findPreviewEntry(['jeu.html', 'index.html', 'docs/index.html']), 'index.html')
  assert.equal(session.findPreviewEntry(['src/index.html', 'docs/index.html', 'README.md']), 'docs/index.html')
  assert.equal(session.findPreviewEntry(['a/b/index.html', 'site/index.html']), 'site/index.html')
  // Même profondeur : le dossier de publication passe avant l'ordre alphabétique.
  assert.equal(session.findPreviewEntry(['assets/index.html', 'site/index.html']), 'site/index.html')
  assert.equal(session.findPreviewEntry(['jeux/snake/index.html', 'jeux/index.html']), 'jeux/index.html')
  assert.equal(session.findPreviewEntry(['b/page.html', 'jeu.html']), 'jeu.html')
  assert.equal(session.findPreviewEntry(['INDEX.HTML']), 'INDEX.HTML')
})

test('l’aperçu sert la version PRÉPARÉE par Jaris, sinon celle de GitHub (lue une seule fois)', async () => {
  const { session, state } = setup({
    token: 't',
    files: { 'README.md': '# Projet\n', 'style.css': 'body { color: red }\n', 'vieux.js': 'x\n' },
    replies: [
      reply(call('write_file', { path: 'index.html', content: '<h1>Snake</h1>' })),
      reply(call('delete_file', { path: 'vieux.js' })),
      reply(call('finish', { summary: 'Site créé.' }))
    ]
  })
  await session.openGithubRepo('leo/projet')
  // Pas encore de page : rien à afficher.
  assert.equal(session.githubPreviewEntry('leo/projet'), null)
  await session.runGithubAgent('leo/projet', 'Crée le site', { onStatus: () => {} })
  // La page créée par Jaris, pas encore enregistrée, est déjà jouable.
  assert.equal(session.githubPreviewEntry('leo/projet'), 'index.html')
  assert.equal(await session.readGithubPreviewFile('leo/projet', 'index.html'), '<h1>Snake</h1>')
  assert.equal(await session.readGithubPreviewFile('leo/projet', 'vieux.js'), undefined, 'un fichier supprimé est encore servi')
  assert.equal(await session.readGithubPreviewFile('leo/projet', 'absent.png'), undefined)
  // Les fichiers inchangés viennent de GitHub, en octets (images, polices), et une seule fois.
  assert.equal(String(await session.readGithubPreviewFile('leo/projet', 'style.css')), 'body { color: red }\n')
  await session.readGithubPreviewFile('leo/projet', 'style.css')
  assert.equal(state.byteReads, 1)
  // Un dépôt qui n'est plus ouvert ne sert rien.
  assert.equal(await session.readGithubPreviewFile('leo/autre', 'index.html'), undefined)
})

// Étape 304 (Léo : « l'aperçu montre toujours l'ancien site, et pas le nouveau — je viens de confirmer avec Vercel ») :
// l'aperçu avait déjà lu index.html AVANT le travail ; après l'enregistrement, ce cache le resservait sous le même nom.
test('après un enregistrement sur GitHub, l’aperçu montre la NOUVELLE version, jamais celle lue avant', async () => {
  const { session, state } = setup({
    token: 't',
    files: { 'index.html': '<h1>Ancien</h1>' },
    replies: [
      reply(call('read_file', { path: 'index.html' })),
      reply(call('edit_file', { path: 'index.html', old_text: 'Ancien', new_text: 'Nouveau' })),
      reply(call('finish', { summary: 'Titre changé.' }))
    ]
  })
  await session.openGithubRepo('leo/projet')
  // L'aperçu du site tel qu'il est sur GitHub, avant toute demande.
  assert.equal(String(await session.readGithubPreviewFile('leo/projet', 'index.html')), '<h1>Ancien</h1>')
  await session.runGithubAgent('leo/projet', 'Change le titre', { onStatus: () => {} })
  assert.equal(String(await session.readGithubPreviewFile('leo/projet', 'index.html')), '<h1>Nouveau</h1>')
  await session.commitGithubChanges('leo/projet', 'Change le titre')
  assert.equal(String(await session.readGithubPreviewFile('leo/projet', 'index.html')), '<h1>Nouveau</h1>', 'l’ancien site est revenu dans l’aperçu')
})

// Étape 303 : seul un travail TERMINÉ est enregistré tout seul — limite d'étapes ou échec répété le laissent en attente.
test('« terminé » vient du vrai résultat de l’agent : une limite atteinte ne compte jamais comme terminé', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../electron/services/githubSession.ts', import.meta.url), 'utf8')
  assert.match(source, /return \{ summary, view: viewOf\(session\), finished: !outcome\.limitReached \}/)
})
