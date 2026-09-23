import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const nodeRequire = createRequire(import.meta.url)

/**
 * dockerLocation.ts — étape 143. Docker ne se laisse pas rediriger par une jonction : installé dans le dossier
 * de Jaris avec ses indicateurs OFFICIELS, ou désinstallé pour y être réinstallé. Désinstaller efface tout ce
 * qu'il contient : Jaris ne le fait que si Docker ne contient RIEN d'autre que sa recherche web.
 */
const source = ts.transpileModule(readFileSync(new URL('../electron/services/dockerLocation.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const exports = {}
vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(exports, { exports }, nodeRequire)
const { isOnlyJarisDockerContent, dockerInstallFlags } = exports

const ANON = 'a'.repeat(64)

test('seulement la recherche web de Jaris : désinstallable sans rien perdre', () => {
  assert.equal(isOnlyJarisDockerContent({ containers: ['searxng/searxng:2026.9.8-3fdc6d753'], images: ['searxng/searxng'], volumes: [ANON] }), true)
  assert.equal(isOnlyJarisDockerContent({ containers: [], images: [], volumes: [] }), true, 'Docker vide')
})

test('le moindre projet de quelqu’un d’autre bloque (conteneur, image ou volume nommé)', () => {
  assert.equal(isOnlyJarisDockerContent({ containers: ['postgres:16'], images: ['searxng/searxng'], volumes: [] }), false)
  assert.equal(isOnlyJarisDockerContent({ containers: [], images: ['searxng/searxng', 'node'], volumes: [] }), false)
  assert.equal(isOnlyJarisDockerContent({ containers: [], images: [], volumes: ['mes-donnees'] }), false)
  assert.equal(isOnlyJarisDockerContent({ containers: ['searxng/searxng-fork:1'], images: [], volumes: [] }), false, 'un nom qui ressemble ne suffit pas')
})

test('installation dans le dossier de Jaris avec les indicateurs officiels, rien de plus sans dossier choisi', () => {
  assert.deepEqual([...dockerInstallFlags(null)], [])
  const flags = dockerInstallFlags('D:/Jaris-data')
  assert.equal(flags.length, 2)
  assert.match(flags[0], /^--installation-dir=D:[\\/]Jaris-data[\\/]docker$/)
  assert.match(flags[1], /^--wsl-default-data-root=D:[\\/]Jaris-data[\\/]docker-data$/)
})

test('l’installation de Docker par Jaris passe bien ces indicateurs', () => {
  const services = readFileSync(new URL('../electron/services/dependencyServices.ts', import.meta.url), 'utf8')
  assert.match(services, /'install', '--quiet', '--accept-license', \.\.\.dockerInstallFlags\(root\)/)
  assert.match(services, /const root = targetRoot \?\? getStorageRoot\(\)/)
})

test('la désinstallation ne passe aucun texte variable dans une commande PowerShell', () => {
  const src = readFileSync(new URL('../electron/services/dockerLocation.ts', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('export async function uninstallDockerForMove'))
  assert.match(fn, /\$env:JARIS_DOCKER_UNINSTALLER/)
  assert.doesNotMatch(fn, /EncodedCommand/)
  assert.doesNotMatch(fn.slice(0, fn.indexOf('const exitCode')), /\$\{installDir\}/, 'le chemin passe par une variable d’environnement, jamais dans le script')
})
