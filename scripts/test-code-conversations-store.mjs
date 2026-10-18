import assert from 'node:assert/strict'
import * as realFs from 'node:fs'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { join } from 'node:path'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Les conversations du mode Code vivent dans code-conversations.json, dans le dossier de données (elles partaient
 * avec le localStorage du dossier de Chromium, effacé par un « Déplacer »). Ce fichier est tout ce qui reste de la
 * liste du mode Code : une coupure de courant pendant une écriture, ou un fichier abîmé, ne doit jamais l'effacer.
 * Vrai disque (dossier temporaire), avec un `fs` qui peut échouer à la demande pour simuler la panne.
 */
const shared = loadTsModule('shared/codeConversations.ts')

function loadStore(fsModule = realFs) {
  return loadTsModule('electron/services/codeConversationsStore.ts', {
    fs: fsModule,
    path,
    '../../shared/codeConversations': shared
  }).CodeConversationsStore
}

/**
 * Un `fs` réel dont on peut faire échouer les prochains appels d'un nom (`failNext.set(nom, erreur)` : le suivant
 * seulement ; `failNext.set(nom, { error, times })` : les `times` suivants ; `Infinity` : tant qu'on ne l'a pas retiré)
 * et dont on note les appels.
 */
function faultyFs() {
  const calls = []
  const failNext = new Map()
  const wrapped = {}
  for (const name of ['readFileSync', 'openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync', 'mkdirSync']) {
    wrapped[name] = (...args) => {
      calls.push([name, typeof args[0] === 'string' ? path.basename(args[0]) : args[0]])
      const planned = failNext.get(name)
      if (planned) {
        const { error, times } = planned instanceof Error ? { error: planned, times: 1 } : planned
        if (times <= 1) failNext.delete(name)
        else failNext.set(name, { error, times: times - 1 })
        throw error
      }
      return realFs[name](...args)
    }
  }
  return { fs: wrapped, calls, failNext }
}

/** Attente du store : notée, jamais réelle (le vrai store attend quelques dizaines de millisecondes entre deux essais). */
function fakeSleep() {
  const waits = []
  return { waits, sleep: (ms) => waits.push(ms) }
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-code-conv-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const turns = (text) => [{ id: 1, kind: 'user', text }, { id: 2, kind: 'reply', text: 'Fait.' }]
const errno = (code) => Object.assign(new Error(code), { code })

test('pas encore de fichier : liste vide, puis le fichier est créé et relu au lancement suivant', (t) => {
  const file = join(tempDir(t), 'code-conversations.json')
  const Store = loadStore()
  const store = new Store(file)
  assert.deepEqual(store.load(), { repos: [], conversations: {} })
  store.setConversation('app:snake', turns('un snake'))
  store.setRepos([{ fullName: 'leo/projet', at: 5 }])
  assert.equal(existsSync(`${file}.tmp`), false, 'le fichier temporaire est renommé, jamais laissé derrière')

  const restarted = new Store(file).load()
  assert.deepEqual(restarted.conversations['app:snake'], turns('un snake'))
  assert.deepEqual(restarted.repos, [{ fullName: 'leo/projet', at: 5 }])
})

test('écriture atomique : une panne pendant l’écriture laisse l’ancienne version intacte', (t) => {
  const file = join(tempDir(t), 'code-conversations.json')
  const faulty = faultyFs()
  const Store = loadStore(faulty.fs)
  const store = new Store(file, { sleep: fakeSleep().sleep })
  store.setConversation('app:snake', turns('un snake'))
  const before = readFileSync(file, 'utf-8')

  // Disque plein (ou coupure) pendant que le nouveau contenu s'écrit.
  faulty.failNext.set('writeFileSync', errno('ENOSPC'))
  assert.throws(() => store.setConversation('app:pong', turns('un pong')))
  assert.equal(readFileSync(file, 'utf-8'), before, 'le fichier a été touché par une écriture ratée')

  // Remplacement refusé pour de bon (fichier tenu ouvert par un antivirus, même après les nouveaux essais) : pareil.
  faulty.failNext.set('renameSync', { error: errno('EPERM'), times: Infinity })
  assert.throws(() => store.setConversation('app:pong', turns('un pong')))
  faulty.failNext.delete('renameSync')
  assert.equal(readFileSync(file, 'utf-8'), before)
  assert.deepEqual(Object.keys(new Store(file).load().conversations), ['app:snake'])

  // Le contenu est forcé sur le disque AVANT de remplacer l'ancien fichier, et c'est un fichier à côté qui est écrit.
  faulty.calls.length = 0
  store.setConversation('app:pong', turns('un pong'))
  const order = faulty.calls.map(([name]) => name).filter((name) => name !== 'mkdirSync')
  assert.deepEqual(order, ['openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync'])
  assert.equal(faulty.calls.find(([name]) => name === 'openSync')[1], 'code-conversations.json.tmp')
  assert.deepEqual(Object.keys(new Store(file).load().conversations).sort(), ['app:pong', 'app:snake'])
})

test('fichier abîmé : jamais écrasé par une liste vide, il est gardé à côté sous un autre nom', (t) => {
  for (const damaged of ['{ "repos": [ {"fullName": "leo/projet"', '[1, 2, 3]', '']) {
    const dir = tempDir(t)
    const file = join(dir, 'code-conversations.json')
    writeFileSync(file, damaged, 'utf-8')
    const Store = loadStore()
    const store = new Store(file, { now: () => Date.UTC(2026, 9, 17, 9, 30) })
    assert.deepEqual(store.load(), { repos: [], conversations: {} })

    store.setConversation('app:neuve', turns('nouvelle'))
    // Dans un dossier au nom FIXE (emporté par « Déplacer » avec les données), sous un nom daté.
    const asideDir = join(dir, shared.CODE_CONVERSATIONS_ASIDE_DIR)
    assert.deepEqual(readdirSync(asideDir), ['code-conversations-2026-10-17T09-30-00-000Z.json'], `contenu : ${JSON.stringify(damaged)}`)
    assert.equal(readFileSync(join(asideDir, 'code-conversations-2026-10-17T09-30-00-000Z.json'), 'utf-8'), damaged, 'le fichier abîmé a été modifié')
    assert.deepEqual(Object.keys(new Store(file).load().conversations), ['app:neuve'])
  }
})

test('fichier refusé un instant (antivirus) à la première lecture : relu, la liste n’apparaît jamais vide', (t) => {
  const file = join(tempDir(t), 'code-conversations.json')
  writeFileSync(file, JSON.stringify({ version: 1, repos: [], conversations: { 'app:snake': turns('un snake') } }), 'utf-8')
  const faulty = faultyFs()
  faulty.failNext.set('readFileSync', { error: errno('EBUSY'), times: 2 })
  const pause = fakeSleep()
  const store = new (loadStore(faulty.fs))(file, { sleep: pause.sleep })
  assert.deepEqual(Object.keys(store.load().conversations), ['app:snake'])
  assert.equal(pause.waits.length, 2, 'la lecture n’a pas été réessayée après une courte attente')
  // Et le travail de la session s'enregistre normalement, à côté de ce qui était déjà là.
  store.setConversation('app:pong', turns('un pong'))
  assert.deepEqual(Object.keys(new (loadStore())(file).load().conversations).sort(), ['app:pong', 'app:snake'])

  // Avec la VRAIE attente (synchrone, dans le processus principal) : elle marche hors d'un navigateur.
  const real = faultyFs()
  real.failNext.set('readFileSync', errno('EPERM'))
  const started = Date.now()
  assert.equal(Object.keys(new (loadStore(real.fs))(file).load().conversations).length, 2)
  assert.ok(Date.now() - started >= 40, 'aucune attente entre les deux essais')
})

test('fichier verrouillé pour de bon : l’écran le sait (null), rien n’est écrit par-dessus, et il est relu ensuite', (t) => {
  const file = join(tempDir(t), 'code-conversations.json')
  writeFileSync(file, JSON.stringify({ version: 1, repos: [], conversations: { 'app:snake': turns('un snake') } }), 'utf-8')
  const original = readFileSync(file, 'utf-8')
  const faulty = faultyFs()
  faulty.failNext.set('readFileSync', { error: errno('EBUSY'), times: Infinity })
  const store = new (loadStore(faulty.fs))(file, { sleep: fakeSleep().sleep })
  assert.equal(store.load(), null, 'une liste vide renvoyée à l’écran ferait croire que tout a été effacé')
  assert.throws(() => store.setRepos([{ fullName: 'leo/projet', at: 1 }]))
  assert.throws(() => store.setConversation('app:pong', turns('un pong')))
  assert.throws(() => store.importLegacy({ repos: [], conversations: { 'app:vieux': turns('vieux') } }))
  assert.equal(readFileSync(file, 'utf-8'), original, 'le fichier verrouillé a été écrasé')
  assert.equal(readdirSync(path.dirname(file)).some((name) => name.includes('illisible')), false, 'un fichier sain n’est jamais mis de côté')

  // Le verrou est levé : le fichier est relu (rien de vide n'a été gardé à sa place), puis complété.
  faulty.failNext.delete('readFileSync')
  store.setConversation('app:pong', turns('un pong'))
  assert.deepEqual(Object.keys(new (loadStore())(file).load().conversations).sort(), ['app:pong', 'app:snake'])
})

test('remplacement refusé un instant par Windows : réessayé ; refusé jusqu’au bout : réécrit à la fermeture', (t) => {
  const file = join(tempDir(t), 'code-conversations.json')
  const faulty = faultyFs()
  const pause = fakeSleep()
  const store = new (loadStore(faulty.fs))(file, { sleep: pause.sleep })
  store.setConversation('app:snake', turns('un snake'))

  faulty.failNext.set('renameSync', { error: errno('EPERM'), times: 2 })
  store.setConversation('app:pong', turns('un pong'))
  assert.equal(pause.waits.length, 2)
  assert.deepEqual(Object.keys(new (loadStore())(file).load().conversations).sort(), ['app:pong', 'app:snake'])

  // Le dernier changement de la session ne passe pas : gardé en mémoire, puis écrit par flush() à la fermeture.
  faulty.failNext.set('renameSync', { error: errno('EPERM'), times: Infinity })
  assert.throws(() => store.setConversation('app:tetris', turns('un tetris')))
  faulty.failNext.delete('renameSync')
  assert.equal(new (loadStore())(file).load().conversations['app:tetris'], undefined)
  store.flush()
  assert.deepEqual(Object.keys(new (loadStore())(file).load().conversations).sort(), ['app:pong', 'app:snake', 'app:tetris'])

  // Rien en attente : la fermeture n'écrit rien.
  faulty.calls.length = 0
  store.flush()
  assert.equal(faulty.calls.some(([name]) => name === 'openSync'), false)
  // Une erreur qui ne passera pas en réessayant (disque plein) n'est pas réessayée.
  pause.waits.length = 0
  faulty.failNext.set('renameSync', errno('ENOSPC'))
  assert.throws(() => store.setConversation('app:x', turns('x')))
  assert.equal(pause.waits.length, 0)
})

test('fichier abîmé ET impossible à mettre de côté : rien n’est écrit, et on réessaie au prochain accès', (t) => {
  const dir = tempDir(t)
  const file = join(dir, 'code-conversations.json')
  writeFileSync(file, '{ pas fini', 'utf-8')
  const faulty = faultyFs()
  faulty.failNext.set('renameSync', { error: errno('EACCES'), times: Infinity })
  const store = new (loadStore(faulty.fs))(file, { sleep: fakeSleep().sleep, now: () => Date.UTC(2026, 9, 17, 9, 30) })
  assert.equal(store.load(), null)
  assert.throws(() => store.setConversation('app:neuve', turns('nouvelle')))
  assert.equal(readFileSync(file, 'utf-8'), '{ pas fini')

  faulty.failNext.delete('renameSync')
  store.setConversation('app:neuve', turns('nouvelle'))
  assert.equal(readFileSync(join(dir, shared.CODE_CONVERSATIONS_ASIDE_DIR, 'code-conversations-2026-10-17T09-30-00-000Z.json'), 'utf-8'), '{ pas fini')
  assert.deepEqual(Object.keys(new (loadStore())(file).load().conversations), ['app:neuve'])
})

test('reprise de l’ancien stockage : ajoutée au fichier sans rien écraser', (t) => {
  const file = join(tempDir(t), 'code-conversations.json')
  const store = new (loadStore())(file)
  store.setConversation('app:snake', turns('version du fichier'))
  store.setRepos([{ fullName: 'leo/projet', at: 10 }])

  store.importLegacy({
    repos: [{ fullName: 'Leo/Projet', at: 3 }, { fullName: 'leo/site', at: 7 }],
    conversations: { 'app:snake': turns('ancienne version'), 'repo:leo/site': turns('le site') }
  })
  const data = new (loadStore())(file).load()
  assert.equal(data.conversations['app:snake'][0].text, 'version du fichier', 'la reprise a écrasé une conversation déjà enregistrée')
  assert.equal(data.conversations['repo:leo/site'][0].text, 'le site')
  assert.deepEqual(data.repos, [{ fullName: 'leo/projet', at: 10 }, { fullName: 'leo/site', at: 7 }])
  assert.throws(() => store.importLegacy('pas une liste'))
})

test('seules des conversations du mode Code entrent dans le fichier ; une conversation vide en sort', (t) => {
  const file = join(tempDir(t), 'code-conversations.json')
  const store = new (loadStore())(file)
  for (const key of ['__proto__', 'constructor', 'autre:x', 'app:', 42]) {
    assert.throws(() => store.setConversation(key, turns('x')), `clé acceptée : ${String(key)}`)
  }
  assert.throws(() => store.setConversation('app:x', 'pas une liste'))
  assert.throws(() => store.setRepos('pas une liste'))

  store.setConversation('repo:leo/projet', turns('x'))
  store.setRepos([{ fullName: 'leo/projet', at: 1 }, { fullName: '', at: 2 }, { fullName: 'leo/site' }])
  assert.deepEqual(new (loadStore())(file).load().repos, [{ fullName: 'leo/projet', at: 1 }])
  store.setConversation('repo:leo/projet', [])
  assert.deepEqual(new (loadStore())(file).load().conversations, {})
})

test('une conversation trop longue garde ses 200 derniers messages', (t) => {
  const file = join(tempDir(t), 'code-conversations.json')
  const store = new (loadStore())(file)
  const long = Array.from({ length: 250 }, (_, index) => ({ id: index, kind: 'user', text: `m${index}` }))
  store.setConversation('app:long', long)
  const kept = new (loadStore())(file).load().conversations['app:long']
  assert.equal(kept.length, shared.MAX_CODE_TURNS)
  assert.equal(kept[0].text, 'm50')
})
