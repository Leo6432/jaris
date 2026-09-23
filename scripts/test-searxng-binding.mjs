import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { promisify } from 'node:util'
import ts from 'typescript'

/**
 * Étape 103, demande de Léo après avoir demandé si le dépôt public contenait des données sensibles :
 * "règle pour pas pouvoir prendre la machine dans le même wifi".
 *
 * `ports: - '8091:8080'` (docker-compose.yml) publiait SearXNG sur toutes les interfaces réseau de la
 * machine (0.0.0.0), pas seulement sur l'ordinateur lui-même : n'importe qui sur le même Wi-Fi pouvait
 * atteindre http://<ip-de-la-machine>:8091 et faire ses recherches à travers la connexion de Léo, avec en
 * prime une clé de signature publique (dépôt public).
 *
 * Corriger le fichier ne suffit PAS : un conteneur garde la publication décidée à sa CRÉATION, et
 * `ensureSearxngRunning` ressortait immédiatement quand SearXNG répondait déjà (`restart: unless-stopped`,
 * donc relancé tout seul à chaque démarrage de Docker). Sans le contrôle vérifié ici, le correctif ne serait
 * jamais arrivé jusqu'à la machine de Léo — exactement le piège du check WSL placé dans une branche jamais
 * atteinte, et de la touche "+" gatée d'un seul côté sur deux.
 */
const nodeRequire = createRequire(import.meta.url)
const projectRoot = new URL('..', import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('electron/services/dependencyServices.ts', projectRoot), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

/**
 * `binding` = ce que `docker compose port searxng 8080` répond pour le conteneur DÉJÀ lancé ; `jsonStatus`
 * = le code renvoyé à la recherche en format JSON (403 = la panne déjà connue, v0.3.x). Une recréation
 * réussie remet la publication sur 127.0.0.1, comme le ferait le vrai Docker avec le fichier corrigé.
 */
function setup({ binding = '0.0.0.0:8091', jsonStatus = 200 } = {}) {
  const commands = []
  let currentBinding = binding
  let currentJsonStatus = jsonStatus
  const run = (command) => {
    commands.push(command)
    if (command.includes(' port searxng 8080')) return { stdout: `${currentBinding}\n`, stderr: '' }
    // Une recréation réussie repart du fichier corrigé : port refermé ET settings.yml relu (c'est ce que
    // la v0.3.7 avait établi). Sans cette remise en état, le test resterait 30 s dans waitUntil.
    if (command.includes('--force-recreate')) {
      currentBinding = '127.0.0.1:8091'
      currentJsonStatus = 200
    }
    return { stdout: '', stderr: '' }
  }
  // Même marque [util.promisify.custom] que le vrai child_process.exec de Node : sans elle, promisify(exec)
  // résout vers un TABLEAU positionnel et `const { stdout } = await execAsync(...)` recevrait undefined,
  // donc readSearxngPortBinding retomberait silencieusement sur null (piège déjà rencontré à l'étape 66).
  const exec = (command, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb
    const result = run(command)
    callback(null, result.stdout, result.stderr)
  }
  exec[promisify.custom] = (command) => Promise.resolve(run(command))

  const modules = {
    child_process: { exec, execSync: () => '', spawn: () => ({ on: () => {} }) },
    fs: { existsSync: () => false },
    'fs/promises': { rm: async () => {} },
    '../config': { config: { searxng: { host: 'http://127.0.0.1:8091' }, ollama: { host: 'http://127.0.0.1:11434' } } },
    './appLauncher': { didAppLaunch: () => true, openApp: async () => 'a été lancé.' },
    './download': { downloadToFile: async () => 0 },
    './storageRoot': { downloadsDir: () => '/tmp', getStorageRoot: () => null },
    './dockerLocation': { dockerInstallFlags: () => [] },
    // Étape 153 : SearXNG vit dans le dossier de données (searxngHome.ts, testé à part dans
    // test-searxng-home.mjs) ; ici, aucun conteneur mal placé à retirer.
    './searxngHome': {
      LEGACY_SEARXNG_PROJECT: 'resources',
      SEARXNG_PROJECT: 'jaris-searxng',
      composeCommand: (args) => `docker compose -p jaris-searxng ${args}`,
      composeWorkingDir: () => null,
      parseContainerIds: () => [],
      prepareSearxngComposeDir: () => '/fake/data/searxng-docker',
      sameDir: (a, b) => a === b,
      searxngComposeDir: () => '/fake/data/searxng-docker'
    },
    '../../shared/formatBytes': { formatBytes: (n) => `${n} o` }
  }
  const exports = {}
  vm.runInNewContext(source, {
    exports,
    module: { exports },
    require: (name) => modules[name] ?? nodeRequire(name),
    // Globaux absents d'un contexte vm neuf : sans eux, isUp() planterait sur "fetch is not defined" et le
    // test échouerait pour une raison sans rapport avec ce qu'il vérifie.
    fetch: async (url) => ({ status: String(url).includes('format=json') ? currentJsonStatus : 200 }),
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    console
  })
  const logs = []
  return { ...exports, commands, logs, log: (message) => logs.push(message) }
}

test('un conteneur déjà lancé mais ouvert sur le réseau est recréé', async () => {
  const { ensureSearxngRunning, commands, logs, log } = setup({ binding: '0.0.0.0:8091' })
  await ensureSearxngRunning(log)
  assert.ok(
    commands.some((command) => command.includes('--force-recreate')),
    `aucune recréation demandée alors que le port était ouvert : ${JSON.stringify(commands)}`
  )
  assert.match(logs.join('\n'), /réseau local/)
  assert.match(logs.join('\n'), /plus joignable que depuis cet ordinateur/)
})

test('la publication IPv6 ouverte compte aussi, même si l’IPv4 est déjà limitée', async () => {
  // Docker publie parfois sur les deux piles, une ligne chacune : une seule ligne ouverte suffit à rendre
  // la machine joignable depuis le Wi-Fi.
  const { ensureSearxngRunning, commands, log } = setup({ binding: '127.0.0.1:8091\n[::]:8091' })
  await ensureSearxngRunning(log)
  assert.ok(commands.some((command) => command.includes('--force-recreate')))
})

test("un conteneur déjà limité à la machine n'est PAS recréé à chaque lancement", async () => {
  // Recréer le conteneur à chaque démarrage de Jaris coûterait plusieurs secondes et couperait une
  // recherche en cours pour rien.
  const { ensureSearxngRunning, commands, logs, log } = setup({ binding: '127.0.0.1:8091' })
  await ensureSearxngRunning(log)
  assert.ok(
    !commands.some((command) => command.includes('--force-recreate')),
    `recréation inutile : ${JSON.stringify(commands)}`
  )
  assert.deepEqual(logs, [])
})

test('le refus du format JSON déclenche toujours la recréation (comportement v0.3.7 conservé)', async () => {
  const { ensureSearxngRunning, commands, logs, log } = setup({ binding: '127.0.0.1:8091', jsonStatus: 403 })
  await ensureSearxngRunning(log)
  assert.ok(commands.some((command) => command.includes('--force-recreate')))
  assert.match(logs.join('\n'), /format JSON/)
})

test('un diagnostic indisponible ne recrée rien', () => {
  // `docker compose port` peut échouer (Docker en cours de démarrage...) : "je ne sais pas" ne doit jamais
  // être traité comme "c'est ouvert", sinon Jaris recréerait le conteneur de quelqu'un pour rien.
  const { isLocalOnlyBinding } = setup()
  assert.equal(isLocalOnlyBinding(null), true)
  assert.equal(isLocalOnlyBinding(''), true)
  assert.equal(isLocalOnlyBinding('   \n  '), true)
})

test('les publications sont reconnues une par une', () => {
  const { isLocalOnlyBinding } = setup()
  assert.equal(isLocalOnlyBinding('127.0.0.1:8091'), true)
  assert.equal(isLocalOnlyBinding('[::1]:8091'), true)
  // \r : sortie d'une commande Windows, la plateforme de Léo.
  assert.equal(isLocalOnlyBinding('127.0.0.1:8091\r'), true)
  assert.equal(isLocalOnlyBinding('0.0.0.0:8091'), false)
  assert.equal(isLocalOnlyBinding('[::]:8091'), false)
  assert.equal(isLocalOnlyBinding('192.168.1.42:8091'), false)
})

test('docker-compose.yml ne publie SearXNG que sur cet ordinateur', () => {
  // Le contrôle ci-dessus répare une machine déjà installée ; cette assertion garantit qu'une NOUVELLE
  // installation ne repart jamais d'un port ouvert.
  const compose = readFileSync(new URL('docker-compose.yml', projectRoot), 'utf8')
  const ports = /^\s*ports:\s*$((?:\s*-\s*.*$)+)/m.exec(compose)
  assert.ok(ports, 'aucune section ports: trouvée dans docker-compose.yml')
  const published = [...ports[1].matchAll(/-\s*'([^']+)'/g)].map((match) => match[1])
  assert.ok(published.length > 0, 'section ports: vide : ce test ne vérifie plus rien')
  for (const mapping of published) {
    assert.ok(
      mapping.startsWith('127.0.0.1:'),
      `le port ${mapping} est publié sur toutes les interfaces : joignable depuis le Wi-Fi`
    )
  }
})
