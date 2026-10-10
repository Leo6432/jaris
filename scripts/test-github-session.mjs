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
  path: { join }
})
const lineDiff = loadTsModule('shared/lineDiff.ts')
const repoAgent = loadTsModule('electron/services/repoAgent.ts', { '../../shared/lineDiff': lineDiff })

class GenerationStoppedError extends Error {}

function setup({ clientId = 'cid', token = null, files = { 'README.md': '# Projet\nBonjour\n', 'src/a.js': 'let a = 1\n' }, replies = [] } = {}) {
  const state = { token, openCount: 0, commits: [], failAuth: false, files: { ...files }, cleared: 0 }
  class FakeClient {
    constructor(value) {
      this.token = value
    }
    async viewer() {
      if (state.failAuth) throw new realGithub.GithubError(401, 'retiré', 'auth')
      return 'leo'
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
        files: Object.keys(state.files).map((path) => ({ path, sha: path, size: 10, mode: '100644' })),
        truncated: false
      }
    }
    async readText(_snapshot, file) {
      return state.files[file.path]
    }
    async commit(snapshot, changes, message) {
      state.commits.push({ base: snapshot.commitSha, changes, message })
      for (const change of changes) {
        if (change.content === null) delete state.files[change.path]
        else state.files[change.path] = change.content
      }
      return { sha: `sha${state.commits.length}`, url: `https://github.com/leo/projet/commit/sha${state.commits.length}` }
    }
  }
  const config = { config: { github: { clientId } } }
  const session = loadTsModule('electron/services/githubSession.ts', {
    '../config': config,
    '../../shared/effort': { chosenThink: () => undefined },
    './codeGenerator': {
      GenerationStoppedError,
      isAbortError: (err) => err?.name === 'AbortError',
      readModelMaxContext: async () => null,
      resolveCodeModel: async () => 'code-model',
      createModelStepRunner: ({ signal }) => async () => {
        if (signal?.aborted) throw Object.assign(new Error('stop'), { name: 'AbortError' })
        const next = replies.shift()
        if (!next) throw new Error('plus de réponse simulée')
        return typeof next === 'function' ? next() : next
      }
    },
    './github': {
      ...realGithub,
      GithubClient: FakeClient,
      loadGithubToken: async () => state.token,
      saveGithubToken: async (value) => {
        state.token = value
      },
      clearGithubToken: async () => {
        state.token = null
        state.cleared += 1
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
  assert.deepEqual(await session.getGithubStatus(), { available: true, connected: false, login: null })
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

test('le budget d’historique suit la mémoire du modèle, sans jamais tomber trop bas', () => {
  const { session } = setup()
  assert.equal(session.historyBudgetChars(null), 90_000)
  assert.equal(session.historyBudgetChars(32768), 40_960)
  assert.equal(session.historyBudgetChars(8192), 20_000)
})
