import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Reproduit en usage réel (Léo, "si on relance jarvis, on a plus rien dans le code") : chaque application
 * générée était bien enregistrée sur le disque (generated-apps/<horodatage>-<slug>/index.html), mais rien
 * n'exposait la liste — listGeneratedApps()/loadGeneratedApp() (codeGenerator.ts) comblent ça. Mêmes mocks
 * no-op qu'ailleurs pour electron/ollama/hardwareScan/profileStore, non utilisés par ces deux fonctions.
 */
const source = ts.transpileModule(readFileSync(new URL('../electron/services/codeGenerator.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

function setup({ dirEntries = [], readdirError = null, files = {} } = {}) {
  const modules = {
    electron: { app: { getPath: () => '/fake/userData' } },
    'fs/promises': {
      readdir: async () => {
        if (readdirError) throw readdirError
        return dirEntries
      },
      readFile: async (path) => {
        if (!(path in files)) throw new Error(`fichier simulé introuvable : ${path}`)
        return files[path]
      },
      mkdir: async () => {},
      writeFile: async () => {}
    },
    path: { join: (...parts) => parts.join('/') },
    './ollama': {
      chatWithOllama: async () => ({ role: 'assistant', content: '' }),
      listInstalledModels: async () => [],
      pullModelIfMissing: async () => {},
      ModelTooLargeError: class extends Error {},
      DiskFullError: class extends Error {}
    },
    './hardwareScan': { pickBestCodeModel: async () => 'test-model' },
    './profileStore': { getProfile: async () => null }
  }
  const exports = {}
  vm.runInNewContext(source, { exports, require: (name) => modules[name], module: { exports } })
  return exports
}

test('liste les applications générées, les plus récentes en premier', async () => {
  const { listGeneratedApps } = setup({
    dirEntries: ['1000-jeu-snake', '3000-todo-list', '2000-calculatrice']
  })
  const apps = await listGeneratedApps()
  assert.equal(apps.length, 3)
  assert.deepEqual(
    apps.map((a) => a.label),
    ['todo list', 'calculatrice', 'jeu snake']
  )
  assert.deepEqual(
    apps.map((a) => a.timestamp),
    [3000, 2000, 1000]
  )
})

test('un dossier au nom inattendu (pas "horodatage-slug") est ignoré sans planter', async () => {
  const { listGeneratedApps } = setup({ dirEntries: ['1000-valide', '.DS_Store', 'sans-horodatage'] })
  const apps = await listGeneratedApps()
  assert.equal(apps.length, 1)
  assert.equal(apps[0].label, 'valide')
})

test('respecte la limite demandée', async () => {
  const { listGeneratedApps } = setup({
    dirEntries: ['1-a', '2-b', '3-c', '4-d']
  })
  const apps = await listGeneratedApps(2)
  assert.equal(apps.length, 2)
  assert.deepEqual(apps.map((a) => a.timestamp), [4, 3])
})

// deepEqual évité pour les tableaux/objets renvoyés par le module transpilé : vm.runInNewContext leur donne
// un Array/Object d'un autre "royaume" JS, ce qui fait échouer deepStrictEqual (assert/strict) malgré un
// contenu identique — voir le même commentaire dans test-chat-session-restore.mjs.
test("dossier 'generated-apps' pas encore créé (aucune génération) : liste vide, pas une erreur", async () => {
  const { listGeneratedApps } = setup({ readdirError: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) })
  const apps = await listGeneratedApps()
  assert.equal(apps.length, 0)
})

test('loadGeneratedApp relit le fichier index.html du dossier donné', async () => {
  const { loadGeneratedApp } = setup({
    files: { '/fake/userData/generated-apps/1000-jeu-snake/index.html': '<!DOCTYPE html><html></html>' }
  })
  const result = await loadGeneratedApp('/fake/userData/generated-apps/1000-jeu-snake')
  assert.equal(result.html, '<!DOCTYPE html><html></html>')
  assert.equal(result.path, '/fake/userData/generated-apps/1000-jeu-snake')
  assert.equal(result.issues.length, 0)
})
