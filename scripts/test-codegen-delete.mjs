import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as nodePath from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * `deleteGeneratedApp` (codeGenerator.ts, étape 95) efface un dossier ENTIER, récursivement : c'est
 * l'opération la plus irréversible de tout le programme, et le chemin lui vient du renderer. Ces tests
 * portent donc sur le garde, pas sur le confort : tout ce qui n'est pas un enfant DIRECT du dossier des
 * applications générées doit être refusé AVANT le moindre effacement.
 *
 * Le VRAI module `path` de Node est injecté (pas le faux `join` des autres tests de ce fichier voisin) :
 * le garde repose entièrement sur resolve/relative/isAbsolute, un stub les rendrait inutiles et le test ne
 * prouverait plus rien.
 */
const source = ts.transpileModule(readFileSync(new URL('../electron/services/codeGenerator.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

const APPS_DIR = '/fake/userData/generated-apps'

function setup() {
  const removed = []
  const modules = {
    electron: { app: { getPath: () => '/fake/userData' } },
    'fs/promises': {
      readdir: async () => [],
      readFile: async () => '',
      mkdir: async () => {},
      writeFile: async () => {},
      rm: async (target, options) => {
        removed.push({ target, options })
      }
    },
    path: nodePath,
    './ollama': {
      chatWithOllama: async () => ({ role: 'assistant', content: '' }),
      listInstalledModels: async () => [],
      pullModelIfMissing: async () => {},
      ModelTooLargeError: class extends Error {},
      DiskFullError: class extends Error {}
    },
    './hardwareScan': { pickBestCodeModel: async () => 'test-model' },
    './profileStore': { getProfile: async () => null },
    './vision': { describeImage: async () => '', IMAGE_FOR_CODE_SYSTEM_PROMPT: '' },
    '../config': { config: { ollama: {} } }
  }
  const exports = {}
  vm.runInNewContext(source, { exports, require: (name) => modules[name], module: { exports } })
  return { ...exports, removed }
}

test("supprime le dossier d'une application générée, récursivement", async () => {
  const { deleteGeneratedApp, removed } = setup()
  await deleteGeneratedApp(`${APPS_DIR}/1000-jeu-snake`)
  assert.equal(removed.length, 1)
  // Comparé au chemin RÉSOLU par le vrai module path, jamais à la chaîne POSIX écrite plus haut : sous
  // Windows (le runner de la CI), "/fake/..." n'est pas un chemin absolu — resolve() le rend absolu sur le
  // disque courant ("C:\fake\...") et retourne des antislashs. Ce test échouait donc en CI, uniquement à
  // cause de son assertion : le garde testé juste en dessous, lui, était correct sur les deux systèmes.
  assert.equal(removed[0].target, nodePath.resolve(`${APPS_DIR}/1000-jeu-snake`))
  assert.equal(removed[0].options.recursive, true)
})

test('refuse le dossier des applications lui-même : ce serait tout effacer', async () => {
  const { deleteGeneratedApp, removed } = setup()
  await assert.rejects(() => deleteGeneratedApp(APPS_DIR), /pas une application générée/)
  assert.equal(removed.length, 0)
})

for (const [label, target] of [
  ['un dossier en dehors', '/fake/userData'],
  ['un dossier système', '/etc'],
  ['une remontée par ..', `${APPS_DIR}/../../etc`],
  ['une remontée déguisée', `${APPS_DIR}/1000-app/../../../autre`],
  ['un sous-dossier plus profond', `${APPS_DIR}/1000-app/src`],
  ['une chaîne vide', '']
]) {
  test(`refuse ${label} sans rien effacer`, async () => {
    const { deleteGeneratedApp, removed } = setup()
    await assert.rejects(() => deleteGeneratedApp(target), /pas une application générée/)
    assert.equal(removed.length, 0, `un effacement a été tenté sur ${target}`)
  })
}
