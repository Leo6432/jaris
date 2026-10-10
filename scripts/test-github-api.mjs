import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * GitHub dans le mode Code (étape 277) : la connexion par code (device flow) et l'API REST, avec un faux
 * GitHub. Ce qui est verrouillé ici :
 *  - la connexion respecte l'attente imposée par GitHub (et l'allonge sur « slow_down ») et traduit chaque refus ;
 *  - le jeton est chiffré par Windows avant d'être écrit, et n'apparaît dans AUCUN message d'erreur ;
 *  - un enregistrement fait UN commit sur la bonne base, supprime par `sha: null`, et ne force JAMAIS la branche ;
 *  - un refus de GitHub devient une phrase lisible (conflit, protection, jeton retiré).
 */

const files = new Map()
const electron = {
  app: { getPath: () => '/donnees' },
  safeStorage: {
    available: true,
    isEncryptionAvailable() {
      return this.available
    },
    encryptString: (text) => Buffer.from(`CHIFFRE:${Buffer.from(text).toString('base64')}`),
    decryptString: (buffer) => Buffer.from(buffer.toString().replace(/^CHIFFRE:/, ''), 'base64').toString()
  }
}
const fsPromises = {
  readFile: async (path) => {
    if (!files.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return files.get(path)
  },
  writeFile: async (path, data) => files.set(path, Buffer.from(data)),
  rm: async (path) => files.delete(path)
}
const github = loadTsModule('electron/services/github.ts', { electron, 'fs/promises': fsPromises, path: { join } })

/** Faux fetch : chaque appel est noté, la réponse vient d'une fonction de routage. */
function fakeFetch(route) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const call = { url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body }
    calls.push(call)
    const reply = await route(call, calls.length)
    const status = reply.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => reply.headers?.[name.toLowerCase()] ?? null },
      text: async () => (typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? null))
    }
  }
  return { fetchImpl, calls }
}

const TOKEN = 'gho_jeton_secret_123'
// Calculé comme le module le calcule : sous Windows (la CI), `join` donne « \\donnees\\github-token.bin » —
// un chemin écrit en dur avec des « / » ne s'y retrouvait jamais.
const TOKEN_FILE = join('/donnees', 'github-token.bin')

test('connexion par code : le code demandé avec le seul droit « repo », puis attente polie de la validation', async () => {
  const start = fakeFetch(() => ({
    body: { device_code: 'dev123', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }
  }))
  const login = await github.requestDeviceCode('client-id', start.fetchImpl, () => 1000)
  assert.equal(login.userCode, 'ABCD-1234')
  assert.equal(login.intervalMs, 5000)
  assert.equal(login.expiresAt, 1000 + 900_000)
  const params = new URLSearchParams(start.calls[0].body)
  assert.equal(params.get('client_id'), 'client-id')
  assert.equal(params.get('scope'), 'repo')
  assert.equal(start.calls[0].url, 'https://github.com/login/device/code')

  const answers = [{ error: 'authorization_pending' }, { error: 'slow_down', interval: 10 }, { error: 'authorization_pending' }, { access_token: TOKEN }]
  const poll = fakeFetch(() => ({ body: answers.shift() }))
  const waits = []
  const token = await github.pollDeviceToken('client-id', login, {
    fetchImpl: poll.fetchImpl,
    sleep: async (ms) => waits.push(ms),
    now: () => 2000
  })
  assert.equal(token, TOKEN)
  // 5 s imposées, puis 10 s pour toutes les demandes suivantes dès que GitHub demande de ralentir.
  assert.deepEqual(waits, [5000, 5000, 10000, 10000])
  const pollParams = new URLSearchParams(poll.calls[0].body)
  assert.equal(pollParams.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code')
  assert.equal(pollParams.get('device_code'), 'dev123')
  assert.equal(pollParams.get('client_secret'), null, 'aucun secret ne doit être envoyé (ni embarqué)')
})

test('slow_down sans intervalle fourni : +5 s, comme la documentation de GitHub l’exige', async () => {
  const answers = [{ error: 'slow_down' }, { access_token: TOKEN }]
  const poll = fakeFetch(() => ({ body: answers.shift() }))
  const waits = []
  await github.pollDeviceToken('c', { deviceCode: 'd', userCode: 'u', verificationUri: 'v', expiresAt: 10_000, intervalMs: 5000 }, {
    fetchImpl: poll.fetchImpl,
    sleep: async (ms) => waits.push(ms),
    now: () => 0
  })
  assert.deepEqual(waits, [5000, 10000])
})

test('chaque refus de la connexion devient une phrase qui dit quoi faire', async () => {
  const cases = [
    ['access_denied', /refusée/],
    ['expired_token', /expiré/],
    ['device_flow_disabled', /Enable Device Flow/]
  ]
  for (const [code, pattern] of cases) {
    const poll = fakeFetch(() => ({ body: { error: code } }))
    await assert.rejects(
      github.pollDeviceToken('c', { deviceCode: 'd', userCode: 'u', verificationUri: 'v', expiresAt: 10_000, intervalMs: 1 }, {
        fetchImpl: poll.fetchImpl,
        sleep: async () => {},
        now: () => 0
      }),
      pattern
    )
  }
  // Code expiré pendant l'attente, sans même redemander à GitHub.
  const poll = fakeFetch(() => ({ body: { error: 'authorization_pending' } }))
  let clock = 0
  await assert.rejects(
    github.pollDeviceToken('c', { deviceCode: 'd', userCode: 'u', verificationUri: 'v', expiresAt: 100, intervalMs: 60 }, {
      fetchImpl: poll.fetchImpl,
      sleep: async (ms) => {
        clock += ms
      },
      now: () => clock
    }),
    /expiré/
  )
})

test('« Annuler » interrompt l’attente tout de suite', async () => {
  const controller = new AbortController()
  const pending = github.pollDeviceToken('c', { deviceCode: 'd', userCode: 'u', verificationUri: 'v', expiresAt: Date.now() + 60_000, intervalMs: 30_000 }, {
    fetchImpl: fakeFetch(() => ({ body: { error: 'authorization_pending' } })).fetchImpl,
    signal: controller.signal
  })
  setTimeout(() => controller.abort(), 20)
  const started = Date.now()
  await assert.rejects(pending, (err) => err.name === 'AbortError')
  assert.ok(Date.now() - started < 1000)
})

test('une coupure réseau passagère ne fait pas échouer l’attente', async () => {
  let n = 0
  const fetchImpl = async () => {
    n += 1
    if (n === 1) throw new Error('ECONNRESET')
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ access_token: TOKEN }) }
  }
  const token = await github.pollDeviceToken('c', { deviceCode: 'd', userCode: 'u', verificationUri: 'v', expiresAt: 10_000, intervalMs: 1 }, {
    fetchImpl,
    sleep: async () => {},
    now: () => 0
  })
  assert.equal(token, TOKEN)
})

test('le jeton est chiffré avant d’être écrit, relu, puis effacé à la déconnexion', async () => {
  await github.saveGithubToken(TOKEN)
  const stored = files.get(TOKEN_FILE)
  assert.ok(stored, 'jeton non enregistré')
  assert.ok(!stored.toString().includes(TOKEN), 'le jeton est écrit en clair')
  assert.equal(await github.loadGithubToken(), TOKEN)
  await github.clearGithubToken()
  assert.equal(await github.loadGithubToken(), null)

  // Chiffrement indisponible : gardé en mémoire seulement, JAMAIS écrit en clair.
  electron.safeStorage.available = false
  await github.saveGithubToken(TOKEN)
  assert.equal(files.has(TOKEN_FILE), false)
  assert.equal(await github.loadGithubToken(), TOKEN)
  await github.clearGithubToken()
  electron.safeStorage.available = true
})

const SNAPSHOT_ROUTES = (call) => {
  if (call.url.endsWith('/repos/leo/projet')) return { body: { full_name: 'leo/projet', default_branch: 'main', private: true, html_url: 'https://github.com/leo/projet' } }
  if (call.url.includes('/branches/main')) return { body: { commit: { sha: 'commit0', commit: { tree: { sha: 'tree0' } } } } }
  if (call.url.includes('/git/trees/tree0')) {
    return {
      body: {
        truncated: false,
        tree: [
          { path: 'src', type: 'tree', sha: 't1', mode: '040000' },
          { path: 'src/app.js', type: 'blob', sha: 'b1', size: 20, mode: '100644' },
          { path: 'run.sh', type: 'blob', sha: 'b2', size: 10, mode: '100755' },
          { path: 'lien', type: 'blob', sha: 'b3', size: 5, mode: '120000' }
        ]
      }
    }
  }
  return null
}

test('ouvrir un dépôt : la branche par défaut photographiée, seuls les vrais fichiers listés', async () => {
  const api = fakeFetch((call) => SNAPSHOT_ROUTES(call) ?? { status: 500, body: {} })
  const client = new github.GithubClient(TOKEN, api.fetchImpl)
  const snapshot = await client.openRepo('leo/projet')
  assert.equal(snapshot.branch, 'main')
  assert.equal(snapshot.commitSha, 'commit0')
  assert.deepEqual(
    snapshot.files.map((file) => file.path),
    ['src/app.js', 'run.sh']
  )
  assert.equal(api.calls[0].headers.Authorization, `Bearer ${TOKEN}`)
  assert.ok(api.calls.every((call) => !call.url.includes(TOKEN)), 'le jeton ne doit jamais apparaître dans une URL')
})

test('enregistrer : un seul commit sur la bonne base, suppression par sha null, branche JAMAIS forcée', async () => {
  const api = fakeFetch((call) => {
    const known = SNAPSHOT_ROUTES(call)
    if (known) return known
    if (call.url.endsWith('/git/trees') && call.method === 'POST') return { status: 201, body: { sha: 'tree1' } }
    if (call.url.endsWith('/git/commits')) return { status: 201, body: { sha: 'commit1', html_url: 'https://github.com/leo/projet/commit/commit1' } }
    if (call.method === 'PATCH') return { body: {} }
    return { status: 500, body: {} }
  })
  const client = new github.GithubClient(TOKEN, api.fetchImpl)
  const snapshot = await client.openRepo('leo/projet')
  const result = await client.commit(
    snapshot,
    [
      { path: 'src/app.js', content: 'nouveau' },
      { path: 'run.sh', content: null },
      { path: 'docs/nouveau.md', content: '# Titre' }
    ],
    'Corrige le titre'
  )
  assert.deepEqual(result, { sha: 'commit1', url: 'https://github.com/leo/projet/commit/commit1' })

  const tree = JSON.parse(api.calls.find((call) => call.url.endsWith('/git/trees')).body)
  assert.equal(tree.base_tree, 'tree0')
  assert.deepEqual(tree.tree, [
    { path: 'src/app.js', mode: '100644', type: 'blob', content: 'nouveau' },
    // Le mode d'origine est gardé (un script exécutable reste exécutable), la suppression passe par sha: null.
    { path: 'run.sh', mode: '100755', type: 'blob', sha: null },
    { path: 'docs/nouveau.md', mode: '100644', type: 'blob', content: '# Titre' }
  ])
  const commit = JSON.parse(api.calls.find((call) => call.url.endsWith('/git/commits')).body)
  assert.deepEqual(commit, { message: 'Corrige le titre', tree: 'tree1', parents: ['commit0'] })
  const patch = api.calls.find((call) => call.method === 'PATCH')
  assert.ok(patch.url.endsWith('/repos/leo/projet/git/refs/heads/main'))
  assert.deepEqual(JSON.parse(patch.body), { sha: 'commit1', force: false })
})

test('une branche avec « / » garde son chemin, et un nom de dépôt douteux est refusé', async () => {
  const api = fakeFetch((call) => {
    if (call.url.endsWith('/repos/leo/projet')) return SNAPSHOT_ROUTES(call)
    if (call.url.includes('/branches/claude/ma-branche')) return { body: { commit: { sha: 'c', commit: { tree: { sha: 'tree0' } } } } }
    return SNAPSHOT_ROUTES(call) ?? { status: 404, body: {} }
  })
  const client = new github.GithubClient(TOKEN, api.fetchImpl)
  const snapshot = await client.openRepo('leo/projet', 'claude/ma-branche')
  assert.equal(snapshot.branch, 'claude/ma-branche')
  assert.throws(() => github.parseFullName('leo/../../user'), /invalide/)
  assert.throws(() => github.parseFullName('leo'), /invalide/)
})

test('dépôt tout neuf (aucune branche) ou branche disparue : un message juste, pas « sans accès »', async () => {
  const api = fakeFetch((call) => {
    if (call.url.endsWith('/repos/leo/projet')) return SNAPSHOT_ROUTES(call)
    return { status: 404, body: { message: 'Branch not found' } }
  })
  const client = new github.GithubClient(TOKEN, api.fetchImpl)
  await assert.rejects(client.openRepo('leo/projet'), /dépôt est vide/)
  await assert.rejects(client.openRepo('leo/projet', 'vieille'), /« vieille » n'existe pas/)
})

test('la page ouverte dans le navigateur est toujours une page de github.com', async () => {
  const start = fakeFetch(() => ({ body: { device_code: 'd', user_code: 'ABCD-1234', verification_uri: 'https://exemple.test/piege', expires_in: 900, interval: 5 } }))
  const login = await github.requestDeviceCode('c', start.fetchImpl)
  assert.equal(login.verificationUri, 'https://github.com/login/device')
})

test('les refus de GitHub deviennent des phrases lisibles, sans jamais citer le jeton', async () => {
  const cases = [
    [{ status: 401, body: { message: 'Bad credentials' } }, /Reconnecte-toi/, 'auth'],
    [{ status: 422, body: { message: 'Update is not a fast forward' } }, /a changé sur GitHub/, 'conflict'],
    [{ status: 422, body: { message: 'Protected branch update failed' } }, /protégée/, 'other'],
    [{ status: 404, body: { message: 'refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope' } }, /workflows/, 'other'],
    [{ status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0' } }, /quelques minutes/, 'other'],
    [{ status: 404, body: { message: 'Not Found' } }, /Introuvable/, 'other']
  ]
  for (const [reply, pattern, reason] of cases) {
    const client = new github.GithubClient(TOKEN, fakeFetch(() => reply).fetchImpl)
    await assert.rejects(client.viewer(), (err) => {
      assert.match(err.message, pattern)
      assert.equal(err.reason, reason)
      assert.ok(!err.message.includes(TOKEN))
      return true
    })
  }
  // Réseau coupé : message clair, pas l'erreur brute de fetch.
  const offline = new github.GithubClient(TOKEN, async () => {
    throw new TypeError('fetch failed')
  })
  await assert.rejects(offline.viewer(), /connexion internet/)
})

test('un fichier binaire ou trop lourd n’est jamais confié au modèle', async () => {
  const blobs = {
    texte: Buffer.from('bonjour é').toString('base64'),
    binaire: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]).toString('base64')
  }
  const api = fakeFetch((call) => ({ body: { content: blobs[call.url.split('/').pop()], encoding: 'base64' } }))
  const client = new github.GithubClient(TOKEN, api.fetchImpl)
  const snapshot = { owner: 'leo', repo: 'projet' }
  assert.equal(await client.readText(snapshot, { path: 'a.txt', sha: 'texte', size: 10, mode: '100644' }), 'bonjour é')
  assert.equal(await client.readText(snapshot, { path: 'a.png', sha: 'binaire', size: 6, mode: '100644' }), null)
  const before = api.calls.length
  assert.equal(await client.readText(snapshot, { path: 'gros.json', sha: 'texte', size: 5_000_000, mode: '100644' }), null)
  assert.equal(api.calls.length, before, 'un fichier trop lourd ne doit même pas être téléchargé')
})
