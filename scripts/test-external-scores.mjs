import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const nodeRequire = createRequire(import.meta.url)

/**
 * Léo : "je ne sais pas pourquoi tu a pas mis ces scores mais sur le site il ya des models que tu a mis non
 * publier, mais au pire je le fait manuelement, fait moi un petit system pour que je note moi meme le score,
 * et ajoute speed (Artificial Analysis)" — externalScoresStore.ts écrit dans un fichier PROPRE à la machine
 * (userData, jamais commité comme verified-tool-scores.md), UN modèle -> DEUX champs indépendants
 * (intelligence, speed) qui doivent pouvoir être corrigés/effacés séparément sans se marcher dessus.
 *
 * Faux disque en mémoire (dictionnaire chemin -> contenu), même pattern que test-conversations.mjs : vérifie
 * le comportement RÉEL de lecture/écriture, pas seulement que les fonctions existent.
 */
const source = ts.transpileModule(readFileSync(new URL('../electron/services/externalScoresStore.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

const DATA_ROOT = '/fake/dataRoot'

function setup({ files = {} } = {}) {
  const disk = { ...files }
  const modules = {
    './dataLocation': { getDataRoot: () => DATA_ROOT },
    'fs/promises': {
      readFile: async (path) => {
        if (!(path in disk)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return disk[path]
      },
      writeFile: async (path, content) => {
        disk[path] = content
      },
      mkdir: async () => {}
    },
    path: { join: (...parts) => parts.join('/'), dirname: (p) => p.split('/').slice(0, -1).join('/') }
  }
  const exports = {}
  vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(
    exports,
    { exports },
    (name) => modules[name] ?? nodeRequire(name)
  )
  return { ...exports, disk }
}

test('getExternalScoreOverrides renvoie {} tant qu’aucun fichier n’existe (première utilisation)', async () => {
  const { getExternalScoreOverrides } = setup()
  assert.deepEqual(await getExternalScoreOverrides(), {})
})

test('setExternalScoreOverride écrit un premier champ sans rien inventer pour les autres modèles', async () => {
  const { setExternalScoreOverride, getExternalScoreOverrides } = setup()
  await setExternalScoreOverride('qwen3.5:27b', 'intelligence', 42)
  assert.deepEqual(await getExternalScoreOverrides(), { 'qwen3.5:27b': { intelligence: 42 } })
})

test('éditer speed n’efface PAS une correction d’intelligence déjà enregistrée pour le même modèle, et réciproquement', async () => {
  const { setExternalScoreOverride, getExternalScoreOverrides } = setup()
  await setExternalScoreOverride('qwen3.5:27b', 'intelligence', 42)
  await setExternalScoreOverride('qwen3.5:27b', 'speed', 77)
  assert.deepEqual(await getExternalScoreOverrides(), { 'qwen3.5:27b': { intelligence: 42, speed: 77 } })

  // Réciproque : corriger intelligence après coup ne doit pas non plus effacer speed.
  await setExternalScoreOverride('qwen3.5:27b', 'intelligence', 50)
  assert.deepEqual(await getExternalScoreOverrides(), { 'qwen3.5:27b': { intelligence: 50, speed: 77 } })
})

test('remettre un champ à null (champ vidé côté interface) l’efface SEUL, sans toucher à l’autre champ', async () => {
  const { setExternalScoreOverride, getExternalScoreOverrides } = setup()
  await setExternalScoreOverride('qwen3.5:27b', 'intelligence', 42)
  await setExternalScoreOverride('qwen3.5:27b', 'speed', 77)
  await setExternalScoreOverride('qwen3.5:27b', 'intelligence', null)
  assert.deepEqual(await getExternalScoreOverrides(), { 'qwen3.5:27b': { speed: 77 } })
})

test('vider le dernier champ restant d’un modèle retire le modèle entier (pas d’objet vide qui traîne)', async () => {
  const { setExternalScoreOverride, getExternalScoreOverrides } = setup()
  await setExternalScoreOverride('qwen3.5:27b', 'intelligence', 42)
  await setExternalScoreOverride('qwen3.5:27b', 'intelligence', null)
  assert.deepEqual(await getExternalScoreOverrides(), {})
})

test('deux modèles corrigés indépendamment ne se mélangent jamais', async () => {
  const { setExternalScoreOverride, getExternalScoreOverrides } = setup()
  await setExternalScoreOverride('qwen3.5:27b', 'intelligence', 42)
  await setExternalScoreOverride('gemma4:26b', 'speed', 12)
  assert.deepEqual(await getExternalScoreOverrides(), {
    'qwen3.5:27b': { intelligence: 42 },
    'gemma4:26b': { speed: 12 }
  })
})

test('la valeur écrite est vraiment relue depuis le disque (pas un simple cache en mémoire)', async () => {
  const setup1 = setup()
  await setup1.setExternalScoreOverride('qwen3.5:27b', 'intelligence', 42)
  // Une SECONDE instance du module, sur le même faux disque : simule un redémarrage de Jaris entre les deux
  // appels — rien ne doit dépendre d'un état gardé en mémoire par le premier chargement du module.
  const setup2 = setup({ files: setup1.disk })
  assert.deepEqual(await setup2.getExternalScoreOverrides(), { 'qwen3.5:27b': { intelligence: 42 } })
})
