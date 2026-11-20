import { withI18n } from './i18n-test-module.mjs'
import { loadTsModule } from './load-ts-module.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Étape 234 (bêta de Jaris) : l'installation de Python passe par le téléchargeur commun (délai d'inactivité,
 * contrôle de taille) et explique un refus de GitHub au lieu d'afficher « HTTP 403 ».
 */
const source = readFileSync(new URL('../electron/services/pythonRuntime.ts', import.meta.url), 'utf8')

function load() {
  const out = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const stub = new Proxy(function () {}, { get: (_t, key) => (key === Symbol.toPrimitive ? () => '' : stub), apply: () => stub, construct: () => stub })
  const exports = {}
  // Étape 501 : le détail d'un échec vient du module partagé (le même que pour le test des modèles).
  const failureDetail = loadTsModule('shared/failureDetail.ts')
  vm.runInThisContext(`(function (exports, require, module) {\n${out}\n})`)(exports, withI18n((id) => (id === '../../shared/failureDetail' ? failureDetail : stub)), { exports })
  return exports
}

test('un refus de GitHub dit quoi faire (limite atteinte, pare-feu), jamais un simple « HTTP 403 »', () => {
  const { pythonListError } = load()
  assert.match(pythonListError(403, '0'), /réessaie dans une heure/)
  assert.match(pythonListError(429, '0'), /réessaie dans une heure/)
  assert.match(pythonListError(403, '42'), /pare-feu/)
  assert.match(pythonListError(500, null), /réessaie plus tard/)
})

test('Python se télécharge avec le téléchargeur commun (délai d’inactivité, taille vérifiée), plus avec une copie', () => {
  assert.match(source, /await downloadToFile\(await findPythonArchiveUrl\(\), archivePath, \{\s*onProgress:/)
  assert.ok(!/async function download\(/.test(source), 'l’ancienne copie sans délai a disparu')
})

test('étape 346 : sans internet, la liste des versions de Python dit pourquoi, jamais « fetch failed »', () => {
  const lookup = source.slice(source.indexOf('async function findPythonArchiveUrl'), source.indexOf('export function pythonListError'))
  assert.match(lookup, /catch \(err\) \{[\s\S]*describeDownloadFailure\(err/)
})

// Étape 497 (Léo, version Store : « installation des dépendances Python échouée (code 1) », rien d'autre) : la vraie
// raison de pip doit arriver jusqu'au message affiché.
test('échec de pip : ses lignes « ERROR » sont gardées dans le message, jamais un simple « code 1 »', () => {
  const { pipFailureDetail } = load()
  const output = [
    'Collecting numpy==2.4.6',
    '  Downloading numpy-2.4.6-cp312-cp312-win_amd64.whl (12.6 MB)',
    'Installing collected packages: numpy, scipy',
    "ERROR: Could not install packages due to an OSError: [WinError 5] Accès refusé: 'C:\\\\Users\\\\x\\\\Jaris\\\\python-runtime\\\\Scripts\\\\f2py.exe'",
    ''
  ]
  assert.match(pipFailureDetail(output), /^ERROR: Could not install packages due to an OSError: \[WinError 5\]/)
  // Sans ligne d'erreur reconnue : les dernières lignes, plutôt que rien.
  assert.equal(pipFailureDetail(['Collecting x', 'Processing y']), 'Collecting x / Processing y')
  assert.equal(pipFailureDetail([]), '')
  const unix = source.replace(/\r\n/g, '\n') // CI Windows en CRLF
  const install = unix.slice(unix.indexOf('async function installDependencies'))
  assert.match(install.slice(0, install.indexOf('\n}\n')), /pipFailureDetail\(output\)/, 'le détail part dans le message d’échec')
})

// Étape 501 (Léo : « Le test s'est arrêté avant la fin (code 1) », rien d'autre) : le test des modèles dit aussi
// POURQUOI il s'est arrêté, avec les dernières lignes d'erreur du script — jamais ses repères internes (##…##).
test('test des modèles arrêté : la vraie raison arrive dans le message, sans les repères internes', () => {
  const { failureDetail } = loadTsModule('shared/failureDetail.ts')
  const lines = ['##TEST_PROGRESS## 3 131', 'Téléchargement de lfm3:1.7b…', 'Error: pull model manifest: 412: this model requires Ollama 0.40.13 or newer', '##EXIT##']
  assert.equal(failureDetail(lines), 'Error: pull model manifest: 412: this model requires Ollama 0.40.13 or newer')
  const runner = readFileSync(new URL('../electron/services/benchmarkRunner.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  assert.match(runner, /failureDetail\(lastLines\)/, 'le runner garde les dernières lignes du script')
  assert.match(runner, /t\('bench\.testStoppedWhy', \{ code: code \?\? '\?', reason: detail \}\)/, 'et les met dans le message')
})
