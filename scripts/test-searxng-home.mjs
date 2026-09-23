import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { promisify } from 'node:util'
import ts from 'typescript'

/**
 * Étape 153, Léo : la mise à jour échouait avec « Échec de désinstallation des anciens fichiers
 * d'application… : 2 ». Dans l'installeur d'electron-builder, ce code veut dire qu'un fichier du dossier du
 * PROGRAMME est resté occupé. Le conteneur SearXNG était créé depuis ce dossier et en montait un
 * sous-dossier, en permanence (relancé avec Docker, même Jaris fermé).
 *
 * Vérifié ici : SearXNG vit dans le dossier de DONNÉES (jamais le programme), l'ancien conteneur est retiré
 * pour être recréé au bon endroit, un conteneur déjà bien placé n'est jamais recréé pour rien, et
 * l'installeur fait le ménage AVANT de lancer l'ancien désinstalleur.
 */
const nodeRequire = createRequire(import.meta.url)
const projectRoot = new URL('..', import.meta.url)
const compile = (file) =>
  ts.transpileModule(readFileSync(new URL(file, projectRoot), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText

function load(file, modules, globals = {}) {
  const exports = {}
  vm.runInNewContext(compile(file), {
    exports,
    module: { exports },
    require: (name) => modules[name] ?? nodeRequire(name),
    ...globals
  })
  return exports
}

/** Un faux dossier de programme (avec ses deux fichiers modèles) et un faux dossier de données. */
function makeDirs() {
  const base = mkdtempSync(join(tmpdir(), 'jaris-searxng-'))
  const resources = join(base, 'Jaris', 'resources')
  const data = join(base, 'Jaris-data', 'jaris-data')
  mkdirSync(join(resources, 'searxng'), { recursive: true })
  writeFileSync(join(resources, 'docker-compose.yml'), 'services: {}\n')
  writeFileSync(join(resources, 'searxng', 'settings.yml'), 'search:\n  formats: [html, json]\n')
  return { base, resources, data }
}

function loadHome(dirs) {
  return load('electron/services/searxngHome.ts', {
    '../paths': { resourcesRoot: () => dirs.resources },
    './dataLocation': { getDataRoot: () => dirs.data }
  })
}

/**
 * Faux Docker : `containers` = les conteneurs SearXNG existants ({ id, project, workingDir }). Un
 * conteneur retiré disparaît ; `up -d` en crée un pour le projet de Jaris, depuis le dossier où il est lancé.
 */
function setup({ containers = [] } = {}) {
  const dirs = makeDirs()
  const home = loadHome(dirs)
  const state = { containers: [...containers], commands: [] }
  const serving = () => state.containers.length > 0
  const run = (command, opts = {}) => {
    state.commands.push({ command, cwd: opts.cwd })
    const ps = command.match(/^docker ps -aq --filter label=com\.docker\.compose\.project=(\S+)/)
    if (ps) return { stdout: state.containers.filter((c) => c.project === ps[1]).map((c) => c.id).join('\n') + '\n', stderr: '' }
    const inspect = command.match(/^docker inspect .* ([0-9a-f]+)$/)
    if (inspect) {
      const c = state.containers.find((x) => x.id === inspect[1])
      return { stdout: JSON.stringify({ 'com.docker.compose.project.working_dir': c.workingDir }) + '\n', stderr: '' }
    }
    const rm = command.match(/^docker rm -f (.+)$/)
    if (rm) {
      const ids = rm[1].split(' ')
      state.containers = state.containers.filter((c) => !ids.includes(c.id))
      return { stdout: '', stderr: '' }
    }
    if (/ up -d/.test(command)) {
      state.containers = state.containers.filter((c) => c.project !== 'jaris-searxng')
      state.containers.push({ id: 'bbbbbbbbbbbb', project: 'jaris-searxng', workingDir: opts.cwd })
    }
    if (command.includes(' port searxng 8080')) return { stdout: '127.0.0.1:8091\n', stderr: '' }
    return { stdout: '', stderr: '' }
  }
  const exec = (command, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb
    const result = run(command, typeof opts === 'object' ? opts : {})
    callback(null, result.stdout, result.stderr)
  }
  // Même marque que le vrai child_process.exec : sans elle, promisify(exec) résoudrait vers un tableau.
  exec[promisify.custom] = (command, opts) => Promise.resolve(run(command, opts))

  const deps = load(
    'electron/services/dependencyServices.ts',
    {
      child_process: { exec, execSync: () => '', spawn: () => ({ on: () => {} }) },
      fs: { existsSync: () => false },
      'fs/promises': nodeRequire('fs/promises'), // vrai disque (dossiers temporaires) : l'effacement de l'ancien dossier est vérifié
      '../config': { config: { searxng: { host: 'http://127.0.0.1:8091' }, ollama: { host: 'http://127.0.0.1:11434' } } },
      './appLauncher': { didAppLaunch: () => true, openApp: async () => 'a été lancé.' },
      './download': { downloadToFile: async () => 0 },
      './storageRoot': { downloadsDir: () => '/tmp', getStorageRoot: () => null },
      './dockerLocation': { dockerInstallFlags: () => [] },
      './searxngHome': home,
      '../../shared/formatBytes': { formatBytes: (n) => `${n} o` }
    },
    {
      fetch: async () => {
        if (!serving()) throw new Error('ECONNREFUSED')
        return { status: 200 }
      },
      URL,
      AbortController,
      setTimeout,
      clearTimeout,
      console
    }
  )
  const logs = []
  return { dirs, home, deps, state, logs, log: (m) => logs.push(m), cleanup: () => rmSync(dirs.base, { recursive: true, force: true }) }
}

test('SearXNG est lancé depuis le dossier de données, jamais depuis le dossier du programme', async () => {
  const t = setup()
  try {
    await t.deps.ensureSearxngRunning(t.log)
    const up = t.state.commands.find((c) => / up -d/.test(c.command))
    assert.ok(up, `aucun démarrage : ${JSON.stringify(t.state.commands)}`)
    assert.equal(up.cwd, join(t.dirs.data, 'searxng-docker'))
    assert.match(up.command, /-p jaris-searxng/)
    assert.ok(!t.state.commands.some((c) => c.cwd && c.cwd.startsWith(t.dirs.resources)), 'une commande Docker est lancée depuis le programme')
    // Les deux fichiers modèles sont bien recopiés à côté du docker-compose.yml utilisé.
    assert.equal(readFileSync(join(t.dirs.data, 'searxng-docker', 'searxng', 'settings.yml'), 'utf8'), 'search:\n  formats: [html, json]\n')
    assert.ok(existsSync(join(t.dirs.data, 'searxng-docker', 'docker-compose.yml')))
  } finally {
    t.cleanup()
  }
})

test('l’ancien conteneur, monté depuis le programme, est retiré puis recréé dans le dossier de données', async () => {
  const t = setup({ containers: [{ id: 'aaaaaaaaaaaa', project: 'resources', workingDir: 'D:\\Jaris\\resources' }] })
  try {
    await t.deps.ensureSearxngRunning(t.log)
    assert.ok(t.state.commands.some((c) => c.command === 'docker rm -f aaaaaaaaaaaa'), JSON.stringify(t.state.commands))
    assert.deepEqual(
      t.state.containers.map((c) => [c.project, c.workingDir]),
      [['jaris-searxng', join(t.dirs.data, 'searxng-docker')]]
    )
    assert.match(t.logs.join('\n'), /ne dépend plus du dossier du programme/)
  } finally {
    t.cleanup()
  }
})

test('un conteneur déjà dans le bon dossier n’est ni retiré ni recréé (à la casse près, Windows)', async () => {
  const t = setup()
  try {
    const dir = join(t.dirs.data, 'searxng-docker')
    t.state.containers.push({ id: 'cccccccccccc', project: 'jaris-searxng', workingDir: dir.toUpperCase() + '/' })
    await t.deps.ensureSearxngRunning(t.log)
    assert.ok(!t.state.commands.some((c) => /docker rm|up -d/.test(c.command)), JSON.stringify(t.state.commands))
    assert.deepEqual(t.logs, [])
  } finally {
    t.cleanup()
  }
})

test('après un « Déplacer », le conteneur monté depuis l’ancien dossier est recréé, et l’ancien dossier effacé', async () => {
  const t = setup()
  try {
    // L'ancien dossier (C:, avant le « Déplacer ») : le conteneur le retenait, il n'avait pas pu être effacé.
    const oldParent = join(t.dirs.base, 'ancien', 'jaris-data')
    const oldDir = join(oldParent, 'searxng-docker')
    mkdirSync(join(oldDir, 'searxng'), { recursive: true })
    writeFileSync(join(oldDir, 'searxng', 'settings.yml'), 'x')
    t.state.containers.push({ id: 'dddddddddddd', project: 'jaris-searxng', workingDir: oldDir })
    await t.deps.ensureSearxngRunning(t.log)
    assert.ok(t.state.commands.some((c) => c.command === 'docker rm -f dddddddddddd'))
    assert.equal(t.state.containers[0].workingDir, join(t.dirs.data, 'searxng-docker'))
    assert.ok(!existsSync(oldDir), 'ancien dossier de SearXNG laissé derrière')
    assert.ok(!existsSync(oldParent), 'ancien dossier de données vide laissé derrière')
  } finally {
    t.cleanup()
  }
})

test('seuls des identifiants de conteneur sont réinjectés dans « docker rm »', () => {
  const t = setup()
  try {
    // Tableaux créés dans un autre contexte vm : comparés en JSON (deepEqual exige le même prototype).
    assert.equal(JSON.stringify(t.home.parseContainerIds('aaaaaaaaaaaa\r\nbbbbbbbbbbbb\n')), '["aaaaaaaaaaaa","bbbbbbbbbbbb"]')
    assert.equal(t.home.parseContainerIds('Cannot connect to the Docker daemon & del C:\\x').length, 0)
    assert.equal(t.home.composeWorkingDir('pas du json'), null)
    assert.equal(t.home.composeWorkingDir('null'), null)
  } finally {
    t.cleanup()
  }
})

test('le fichier de configuration n’est pas réécrit quand il n’a pas changé', () => {
  const t = setup()
  try {
    const target = join(t.home.prepareSearxngComposeDir(), 'searxng', 'settings.yml')
    const before = readFileSync(target)
    writeFileSync(target, before) // même contenu
    const old = new Date(Date.now() - 60_000)
    utimesSync(target, old, old)
    t.home.prepareSearxngComposeDir()
    assert.ok(Math.abs(statSync(target).mtimeMs - old.getTime()) < 2000, 'fichier réécrit alors qu’il était identique')
    writeFileSync(join(t.dirs.resources, 'searxng', 'settings.yml'), 'search: {}\n')
    t.home.prepareSearxngComposeDir()
    assert.equal(readFileSync(target, 'utf8'), 'search: {}\n', 'une nouvelle configuration du programme doit être recopiée')
  } finally {
    t.cleanup()
  }
})

// --- Installeur -------------------------------------------------------------------------------------------

const nsh = readFileSync(new URL('installer/jaris.nsh', projectRoot), 'utf8')
const builderConfig = readFileSync(new URL('electron-builder.yml', projectRoot), 'utf8')
/** Les commandes PowerShell telles que Windows les recevra (`$$` d'NSIS devient `$`). */
const psCommands = [...nsh.matchAll(/-Command "(.+)"`/g)].map((m) => m[1].replace(/\$\$/g, '$'))

test('l’installeur inclut bien le nettoyage, AVANT la désinstallation de l’ancienne version', () => {
  assert.match(builderConfig, /^\s+include: installer\/jaris\.nsh\s*$/m)
  // customInit s'exécute dans .onInit, avant la section d'installation qui lance l'ancien désinstalleur.
  assert.match(nsh, /!macro customInit/)
  assert.equal(psCommands.length, 2)
})

test('le nettoyage de l’installeur ne vise que ce qui appartient à Jaris', () => {
  const [docker, python] = psCommands
  assert.match(docker, /label=com\.docker\.compose\.project=resources --filter label=com\.docker\.compose\.service=searxng/)
  assert.doesNotMatch(docker, /docker (system|volume|image)|prune/, 'jamais de ménage Docker général')
  assert.match(python, /Get-Process -Name Jaris/, 'les Python ne sont arrêtés que si Jaris est déjà fermé')
  assert.match(python, /\(voice\|tts\)_server\\\.py/)
  assert.doesNotMatch(nsh, /RunAs|EncodedCommand|-enc\b/i, 'rien d’élevé ni d’opaque')
})

test('les deux commandes PowerShell de l’installeur sont syntaxiquement valides', { skip: process.platform === 'win32' ? false : 'PowerShell seulement sur Windows (vérifié par la CI)' }, () => {
  for (const command of psCommands) {
    const check = `$e = $null; [System.Management.Automation.Language.Parser]::ParseInput($env:JARIS_PS, [ref]$null, [ref]$e) | Out-Null; if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }`
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', check], { env: { ...process.env, JARIS_PS: command }, stdio: 'pipe' })
  }
})

test('le dossier d’installation est aussi écrit là où Windows le lit pour ranger Jaris par disque (étape 154)', () => {
  // Sans InstallLocation dans la clé « Uninstall », Paramètres → Applications range Jaris sur C même installé sur D.
  const block = nsh.replace(/\r\n/g, '\n').match(/!macro customInstall\n([\s\S]*?)!macroend/)
  assert.ok(block, 'macro customInstall absente')
  assert.match(block[1], /WriteRegStr SHELL_CONTEXT "\$\{UNINSTALL_REGISTRY_KEY\}" InstallLocation "\$INSTDIR"/)
})
