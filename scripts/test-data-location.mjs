import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const nodeRequire = createRequire(import.meta.url)

/**
 * "Déplacer" ne bougeait que les trois briques lourdes (modèles Ollama, environnement Python, cache
 * HuggingFace). Léo, étape 121 : "le fichier jaris avec conversation cache ne change pas quand on clique sur
 * déplacer", puis, quand je lui ai demandé pourquoi déplacer quelques Ko de JSON alors que la fonctionnalité
 * vise des dizaines de Go : "sa doit déplacer tout".
 *
 * Mécanisme volontairement DIFFÉRENT des trois autres briques (voir dataLocation.ts) : pas de jonction NTFS
 * sur userData, qui héberge aussi les fichiers internes de Chromium ouverts en permanence par Electron —
 * seulement une copie des fichiers que Jaris écrit lui-même, plus un marqueur laissé dans userData (l'ancrage
 * fixe) qui dit où ils vivent désormais. Les originaux ne sont JAMAIS supprimés : ce sont les seules données
 * irremplaçables de Jaris (les modèles, eux, se retéléchargent).
 */
function loadDataLocation(userDataDir) {
  const source = ts.transpileModule(readFileSync(new URL('../electron/services/dataLocation.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText

  const modules = {
    electron: { app: { getPath: (name) => (name === 'userData' ? userDataDir : userDataDir) } },
    fs: nodeRequire('fs'),
    'fs/promises': nodeRequire('fs/promises'),
    path: nodeRequire('path')
  }
  const exports = {}
  vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(
    exports,
    { exports },
    (name) => modules[name] ?? nodeRequire(name)
  )
  return exports
}

function setupUserData() {
  const root = mkdtempSync(join(tmpdir(), 'jaris-data-location-'))
  const userData = join(root, 'AppData', 'Jaris')
  mkdirSync(userData, { recursive: true })
  return { root, userData }
}

/** Les vraies données de Jaris, telles qu'elles existent sur une installation utilisée. */
function fillUserData(userData) {
  mkdirSync(join(userData, 'conversations'), { recursive: true })
  writeFileSync(join(userData, 'conversations', 'index.json'), '{"activeId":"abc","conversations":[]}')
  writeFileSync(join(userData, 'conversations', 'abc.json'), '[{"transcript":"Salut Jaris"}]')
  writeFileSync(join(userData, 'profile.json'), '{"name":"Léo"}')
  mkdirSync(join(userData, 'memory'), { recursive: true })
  writeFileSync(join(userData, 'memory', 'Adresse.md'), '# Adresse\n12 rue des Fléchettes')
  mkdirSync(join(userData, 'generated-apps', '2026-snake'), { recursive: true })
  writeFileSync(join(userData, 'generated-apps', '2026-snake', 'index.html'), '<html>Snake</html>')
  writeFileSync(join(userData, 'reminders.json'), '[]')
  // Fichier INTERNE de Chromium : présent dans le même dossier, jamais à copier (voir dataLocation.ts).
  mkdirSync(join(userData, 'Cache'), { recursive: true })
  writeFileSync(join(userData, 'Cache', 'data_0'), 'cache chromium binaire')
}

test('sans marqueur, les données restent à leur emplacement par défaut', () => {
  const { root, userData } = setupUserData()
  const { getDataRoot } = loadDataLocation(userData)
  assert.equal(getDataRoot(), userData)
  rmSync(root, { recursive: true, force: true })
})

test('"Déplacer" copie conversations, profil, mémoire, applications générées et rappels', async () => {
  const { root, userData } = setupUserData()
  fillUserData(userData)
  const { moveDataLocation, getDataRoot } = loadDataLocation(userData)

  const newDir = join(root, 'D-disque', 'jaris')
  const result = await moveDataLocation(newDir, () => {})
  assert.equal(result.success, true, `déplacement attendu réussi, reçu : ${JSON.stringify(result)}`)

  const dest = join(newDir, 'jaris-data')
  assert.equal(readFileSync(join(dest, 'conversations', 'abc.json'), 'utf8'), '[{"transcript":"Salut Jaris"}]')
  assert.equal(readFileSync(join(dest, 'profile.json'), 'utf8'), '{"name":"Léo"}')
  assert.ok(readFileSync(join(dest, 'memory', 'Adresse.md'), 'utf8').includes('Fléchettes'))
  assert.equal(readFileSync(join(dest, 'generated-apps', '2026-snake', 'index.html'), 'utf8'), '<html>Snake</html>')
  assert.equal(readFileSync(join(dest, 'reminders.json'), 'utf8'), '[]')

  // À partir de maintenant, Jaris lit tout depuis le nouvel emplacement.
  assert.equal(getDataRoot(), dest)
  rmSync(root, { recursive: true, force: true })
})

test('les fichiers internes de Chromium ne sont JAMAIS copiés (ils restent dans userData)', async () => {
  const { root, userData } = setupUserData()
  fillUserData(userData)
  const { moveDataLocation } = loadDataLocation(userData)

  const newDir = join(root, 'D-disque', 'jaris')
  await moveDataLocation(newDir, () => {})

  // Copier le cache/les bases internes d'Electron pendant que Jaris tourne, c'est risquer une copie prise en
  // plein milieu d'une écriture : on ne les touche pas du tout, ils restent où Windows les a mis.
  assert.ok(!existsSync(join(newDir, 'jaris-data', 'Cache')), 'le cache Chromium ne doit jamais être copié')
  assert.ok(existsSync(join(userData, 'Cache', 'data_0')), 'le cache Chromium doit rester intact à sa place')
  rmSync(root, { recursive: true, force: true })
})

test('les originaux ne sont JAMAIS supprimés (filet de sécurité sur les seules données irremplaçables)', async () => {
  const { root, userData } = setupUserData()
  fillUserData(userData)
  const { moveDataLocation } = loadDataLocation(userData)

  await moveDataLocation(join(root, 'D-disque', 'jaris'), () => {})

  // Même politique que l'ancien conversation-history.json conservé à l'étape 96 : Léo s'était inquiété
  // explicitement de perdre des données ("j'ai peur que plus on avance plus tu vas perdre des données").
  assert.equal(readFileSync(join(userData, 'conversations', 'abc.json'), 'utf8'), '[{"transcript":"Salut Jaris"}]')
  assert.equal(readFileSync(join(userData, 'profile.json'), 'utf8'), '{"name":"Léo"}')
  assert.ok(existsSync(join(userData, 'memory', 'Adresse.md')))
  rmSync(root, { recursive: true, force: true })
})

test('une installation neuve (rien à copier) ne fait pas échouer le déplacement', async () => {
  const { root, userData } = setupUserData()
  const { moveDataLocation, getDataRoot } = loadDataLocation(userData)

  const result = await moveDataLocation(join(root, 'D-disque', 'jaris'), () => {})
  assert.equal(result.success, true, `attendu un succès même sans données, reçu : ${JSON.stringify(result)}`)
  assert.equal(getDataRoot(), join(root, 'D-disque', 'jaris', 'jaris-data'))
  rmSync(root, { recursive: true, force: true })
})

test('un marqueur qui pointe vers un dossier disparu (disque débranché) retombe sur le défaut', async () => {
  const { root, userData } = setupUserData()
  fillUserData(userData)
  const { moveDataLocation, getDataRoot } = loadDataLocation(userData)

  const newDir = join(root, 'D-disque', 'jaris')
  await moveDataLocation(newDir, () => {})
  assert.equal(getDataRoot(), join(newDir, 'jaris-data'))

  // Disque externe débranché / dossier supprimé à la main : Jaris doit repartir sur les données d'origine
  // (toujours là, jamais supprimées) plutôt que d'échouer à lire quoi que ce soit au démarrage.
  rmSync(join(root, 'D-disque'), { recursive: true, force: true })
  assert.equal(getDataRoot(), userData)
  rmSync(root, { recursive: true, force: true })
})

test('un marqueur illisible ne casse pas le démarrage', () => {
  const { root, userData } = setupUserData()
  writeFileSync(join(userData, 'data-location.json'), 'ceci n est pas du JSON {{{')
  const { getDataRoot } = loadDataLocation(userData)
  assert.equal(getDataRoot(), userData)
  rmSync(root, { recursive: true, force: true })
})

test('Jaris redémarre après un déplacement réussi (sinon les stores gardent l’ancien chemin en cache)', () => {
  // Les stores calculent leur chemin UNE fois au chargement du module (profileStore, memoryStore,
  // reminders...) : copier les fichiers ne suffit pas, il faut relancer pour que tout relise le marqueur.
  const source = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
  const handlerAt = source.indexOf('IPC_CHANNELS.chooseModelsLocation')
  assert.ok(handlerAt !== -1, 'handler chooseModelsLocation introuvable')
  const handler = source.slice(handlerAt, handlerAt + 3000)

  assert.ok(handler.includes('moveDataLocation'), '"Déplacer" doit aussi déplacer les données propres de Jaris')
  assert.ok(handler.includes('app.relaunch()'), 'un déplacement réussi doit relancer Jaris')
  assert.ok(
    handler.includes('quitting = true'),
    'quitting doit passer à true avant de quitter, sinon la fenêtre intercepte sa fermeture et se replie en widget (étape 109)'
  )
})

test('les 5 stores lisent leur emplacement via getDataRoot, plus jamais userData en dur', () => {
  const stores = ['profileStore', 'memoryStore', 'reminders', 'conversationStore', 'codeGenerator']
  for (const name of stores) {
    const source = readFileSync(new URL(`../electron/services/${name}.ts`, import.meta.url), 'utf8')
    assert.ok(source.includes('getDataRoot()'), `${name}.ts doit lire son dossier via getDataRoot()`)
    assert.ok(
      !source.includes("app.getPath('userData')"),
      `${name}.ts ne doit plus calculer son chemin depuis userData en dur, sinon "Déplacer" ne le déplace pas`
    )
  }
})
