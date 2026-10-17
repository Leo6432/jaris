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
const github = loadTsModule('electron/services/github.ts', {
  electron,
  'fs/promises': fsPromises,
  path: { join },
  './dataLocation': { getDataRoot: () => '/donnees-jaris' }
})

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
// Avec les autres données de Jaris (getDataRoot), plus dans le dossier de Chromium (`/donnees`), effacé après un
// « Déplacer ».
const TOKEN_FILE = join('/donnees-jaris', 'github-token.bin')

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

// Étape 297 (Léo : « ça déconnecte GitHub tous les jours ») : Jaris distingue un jeton absent d'un jeton illisible,
// et garde une trace de la connexion SANS le jeton, avec les données de Léo (pas dans le dossier du jeton).
test('jeton absent ≠ jeton illisible, et chiffrement indisponible signalé à l’enregistrement', async () => {
  assert.deepEqual({ ...(await github.readGithubToken()) }, { token: null, unreadable: false })
  assert.equal(await github.saveGithubToken(TOKEN), true)
  const realDecrypt = electron.safeStorage.decryptString
  electron.safeStorage.decryptString = () => {
    throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString')
  }
  try {
    assert.deepEqual({ ...(await github.readGithubToken()) }, { token: null, unreadable: true })
  } finally {
    electron.safeStorage.decryptString = realDecrypt
  }
  assert.deepEqual({ ...(await github.readGithubToken()) }, { token: TOKEN, unreadable: false })
  await github.clearGithubToken()
  electron.safeStorage.available = false
  assert.equal(await github.saveGithubToken(TOKEN), false)
  await github.clearGithubToken()
  electron.safeStorage.available = true
})

// Étape 311 (Léo : « je l'ai connecté hier soir… avec Claude ça ne me demande jamais une seule fois depuis 1 an ») :
// une application OAuth à jetons qui expirent donne un jeton de 8 h ET un jeton de renouvellement de 6 mois. Jaris
// jetait le second : connecté le soir, refusé le lendemain, sans rien dans le journal de sécurité de GitHub.
const REFRESH = 'ghr_renouvellement_secret_456'

test('jeton qui expire : la connexion garde le jeton de renouvellement et l’échéance', async () => {
  const poll = fakeFetch(() => ({
    body: { access_token: TOKEN, expires_in: 28_800, refresh_token: REFRESH, refresh_token_expires_in: 15_811_200, token_type: 'bearer' }
  }))
  const set = await github.pollDeviceTokenSet('c', { deviceCode: 'd', userCode: 'u', verificationUri: 'v', expiresAt: 1e12, intervalMs: 1 }, {
    fetchImpl: poll.fetchImpl,
    sleep: async () => {},
    now: () => 5_000
  })
  assert.deepEqual({ ...set }, { token: TOKEN, refreshToken: REFRESH, expiresAt: 5_000 + 28_800_000 })
  // Application dont les jetons n'expirent pas : rien à renouveler, comme avant.
  const plain = fakeFetch(() => ({ body: { access_token: TOKEN, token_type: 'bearer' } }))
  const once = await github.pollDeviceTokenSet('c', { deviceCode: 'd', userCode: 'u', verificationUri: 'v', expiresAt: 1e12, intervalMs: 1 }, {
    fetchImpl: plain.fetchImpl,
    sleep: async () => {},
    now: () => 0
  })
  assert.deepEqual({ ...once }, { token: TOKEN, refreshToken: null, expiresAt: null })
})

test('renouvellement : le bon formulaire, sans secret, et un refus de GitHub ≠ une panne', async () => {
  const ok = fakeFetch(() => ({ body: { access_token: 'gho_neuf', expires_in: 28_800, refresh_token: 'ghr_neuf' } }))
  const set = await github.refreshGithubToken('client-id', REFRESH, ok.fetchImpl, () => 10_000)
  assert.deepEqual({ ...set }, { token: 'gho_neuf', refreshToken: 'ghr_neuf', expiresAt: 10_000 + 28_800_000 })
  assert.equal(ok.calls[0].url, 'https://github.com/login/oauth/access_token')
  const params = new URLSearchParams(ok.calls[0].body)
  assert.equal(params.get('grant_type'), 'refresh_token')
  assert.equal(params.get('refresh_token'), REFRESH)
  assert.equal(params.get('client_id'), 'client-id')
  assert.equal(params.get('client_secret'), null, 'aucun secret ne doit être envoyé (ni embarqué)')

  // Jeton de renouvellement refusé (déjà servi, expiré après 6 mois, retiré) : vrai refus, la connexion est perdue.
  const refused = fakeFetch(() => ({ body: { error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' } }))
  await assert.rejects(github.refreshGithubToken('c', REFRESH, refused.fetchImpl), (err) => {
    assert.equal(err.reason, 'auth')
    assert.ok(!String(err.message).includes(REFRESH), 'le jeton de renouvellement est cité dans le message')
    return true
  })
  // Réseau coupé ou réponse incomplète : rien ne doit être effacé, ce n'est PAS un refus.
  const offline = { fetchImpl: async () => Promise.reject(new TypeError('fetch failed')) }
  await assert.rejects(github.refreshGithubToken('c', REFRESH, offline.fetchImpl), (err) => err.reason !== 'auth')
  const odd = fakeFetch(() => ({ body: {} }))
  await assert.rejects(github.refreshGithubToken('c', REFRESH, odd.fetchImpl), (err) => err.reason !== 'auth')
})

test('jeton qui expire : chiffré avec son renouvellement, et un ancien jeton seul se relit toujours', async () => {
  assert.equal(await github.saveGithubToken({ token: TOKEN, refreshToken: REFRESH, expiresAt: 123_456 }), true)
  const stored = files.get(TOKEN_FILE)
  assert.ok(!stored.toString().includes(TOKEN) && !stored.toString().includes(REFRESH), 'un jeton est écrit en clair')
  assert.deepEqual({ ...(await github.readGithubToken()) }, { token: TOKEN, unreadable: false, refreshToken: REFRESH, expiresAt: 123_456 })
  assert.equal(await github.loadGithubToken(), TOKEN)
  // Les connexions faites avant la mise à jour (jeton brut) restent lisibles telles quelles.
  await github.saveGithubToken(TOKEN)
  assert.deepEqual({ ...(await github.readGithubToken()) }, { token: TOKEN, unreadable: false })
  // Chiffrement indisponible : le renouvellement reste en mémoire seulement, jamais sur le disque.
  await github.clearGithubToken()
  electron.safeStorage.available = false
  assert.equal(await github.saveGithubToken({ token: TOKEN, refreshToken: REFRESH, expiresAt: 1 }), false)
  assert.equal(files.has(TOKEN_FILE), false)
  assert.equal((await github.readGithubToken()).refreshToken, REFRESH)
  await github.clearGithubToken()
  electron.safeStorage.available = true
})

test('la trace de connexion vit avec les données de Léo, sans jamais contenir le jeton', async () => {
  const recordFile = join('/donnees-jaris', github.GITHUB_RECORD_FILE)
  assert.equal(await github.readConnectionRecord(), null)
  await github.saveGithubToken(TOKEN)
  await github.writeConnectionRecord({ connectedAt: 1_000, login: 'leo', memoryOnly: false, rejectedAt: null })
  assert.ok(files.has(recordFile), 'trace écrite ailleurs que dans le dossier des données')
  assert.ok(!files.get(recordFile).toString().includes(TOKEN), 'le jeton ne doit jamais apparaître dans la trace')
  assert.deepEqual({ ...(await github.readConnectionRecord()) }, { connectedAt: 1_000, login: 'leo', memoryOnly: false, rejectedAt: null })
  // Une trace abîmée ne fait rien croire : elle est ignorée.
  files.set(recordFile, Buffer.from('{pas du json'))
  assert.equal(await github.readConnectionRecord(), null)
  await github.clearConnectionRecord()
  await github.clearGithubToken()
  assert.equal(files.has(recordFile), false)
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

test('dépôt tout neuf : il s’ouvre VIDE (étape 279) ; une branche disparue garde un message juste', async () => {
  let commitsStatus = 409
  const api = fakeFetch((call) => {
    if (call.url.endsWith('/repos/leo/projet')) return SNAPSHOT_ROUTES(call)
    if (call.url.includes('/commits?per_page=1')) return commitsStatus === 409 ? { status: 409, body: { message: 'Git Repository is empty.' } } : { body: [] }
    return { status: 404, body: { message: 'Branch not found' } }
  })
  const client = new github.GithubClient(TOKEN, api.fetchImpl)
  const empty = await client.openRepo('leo/projet')
  assert.equal(empty.commitSha, null)
  assert.equal(empty.branch, 'main')
  assert.deepEqual(empty.files, [])
  await assert.rejects(client.openRepo('leo/projet', 'vieille'), /« vieille » n'existe pas/)
  // Des commits existent mais la branche principale manque : ce n'est PAS un dépôt vide.
  commitsStatus = 200
  await assert.rejects(client.openRepo('leo/projet'), /branche principale « main » est introuvable/)
})

const EMPTY_SNAPSHOT = {
  owner: 'leo',
  repo: 'projet',
  fullName: 'leo/projet',
  branch: 'main',
  defaultBranch: 'main',
  private: true,
  htmlUrl: 'https://github.com/leo/projet',
  commitSha: null,
  treeSha: null,
  files: [],
  truncated: false
}

function emptyRepoApi() {
  return fakeFetch((call) => {
    if (call.method === 'PUT') {
      return { status: 201, body: { content: {}, commit: { sha: 'first', html_url: 'https://github.com/leo/projet/commit/first', tree: { sha: 'treeFirst' } } } }
    }
    if (call.url.endsWith('/git/trees')) return { status: 201, body: { sha: 'tree2' } }
    if (call.url.endsWith('/git/commits')) return { status: 201, body: { sha: 'second', html_url: 'https://github.com/leo/projet/commit/second' } }
    if (call.method === 'PATCH') return { body: {} }
    return { status: 500, body: {} }
  })
}

test('premier enregistrement dans un dépôt vide : un seul fichier = une seule création, en base64', async () => {
  const api = emptyRepoApi()
  const client = new github.GithubClient(TOKEN, api.fetchImpl)
  const result = await client.commit(EMPTY_SNAPSHOT, [{ path: 'docs/présentation.md', content: '# Projet é\n' }], 'Premier fichier')
  assert.deepEqual(result, { sha: 'first', url: 'https://github.com/leo/projet/commit/first' })
  assert.equal(api.calls.length, 1)
  assert.equal(api.calls[0].method, 'PUT')
  assert.ok(api.calls[0].url.endsWith('/repos/leo/projet/contents/docs/pr%C3%A9sentation.md'))
  const body = JSON.parse(api.calls[0].body)
  assert.equal(body.message, 'Premier fichier')
  assert.equal(Buffer.from(body.content, 'base64').toString('utf8'), '# Projet é\n')
  assert.equal(body.sha, undefined, 'création : aucun sha à fournir')
})

test('premier enregistrement avec plusieurs fichiers : les suivants posés SUR le premier, sans forcer', async () => {
  const api = emptyRepoApi()
  const client = new github.GithubClient(TOKEN, api.fetchImpl)
  const result = await client.commit(
    EMPTY_SNAPSHOT,
    [
      { path: 'index.html', content: '<h1>ok</h1>' },
      { path: 'style.css', content: 'h1{}' }
    ],
    'Site de départ'
  )
  assert.equal(result.sha, 'second')
  assert.deepEqual(api.calls.map((call) => call.method), ['PUT', 'POST', 'POST', 'PATCH'])
  const tree = JSON.parse(api.calls[1].body)
  assert.equal(tree.base_tree, 'treeFirst')
  assert.deepEqual(tree.tree, [{ path: 'style.css', mode: '100644', type: 'blob', content: 'h1{}' }])
  assert.deepEqual(JSON.parse(api.calls[2].body).parents, ['first'])
  assert.deepEqual(JSON.parse(api.calls[3].body), { sha: 'second', force: false })
  // Dépôt vide et rien à créer (que des suppressions) : refusé avant tout appel.
  const none = emptyRepoApi()
  await assert.rejects(new github.GithubClient(TOKEN, none.fetchImpl).commit(EMPTY_SNAPSHOT, [{ path: 'x', content: null }], 'm'), /aucun fichier à créer/)
  assert.equal(none.calls.length, 0)
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
