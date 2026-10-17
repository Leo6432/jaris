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

/** Un `fs` réel dont on peut faire échouer UN appel (le suivant de ce nom) et dont on note les appels. */
function faultyFs() {
  const calls = []
  const failNext = new Map()
  const wrapped = {}
  for (const name of ['readFileSync', 'openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync', 'mkdirSync']) {
    wrapped[name] = (...args) => {
      calls.push([name, typeof args[0] === 'string' ? path.basename(args[0]) : args[0]])
      const error = failNext.get(name)
      if (error) {
        failNext.delete(name)
        throw error
      }
      return realFs[name](...args)
    }
  }
  return { fs: wrapped, calls, failNext }
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
  store.setConversation('app:C:/apps/snake', turns('un snake'))
  store.setRepos([{ fullName: 'leo/projet', at: 5 }])
  assert.equal(existsSync(`${file}.tmp`), false, 'le fichier temporaire est renommé, jamais laissé derrière')

  const restarted = new Store(file).load()
  assert.deepEqual(restarted.conversations['app:C:/apps/snake'], turns('un snake'))
  assert.deepEqual(restarted.repos, [{ fullName: 'leo/projet', at: 5 }])
})

test('écriture atomique : une panne pendant l’écriture laisse l’ancienne version intacte', (t) => {
  const file = join(tempDir(t), 'code-conversations.json')
  const faulty = faultyFs()
  const Store = loadStore(faulty.fs)
  const store = new Store(file)
  store.setConversation('app:C:/apps/snake', turns('un snake'))
  const before = readFileSync(file, 'utf-8')

  // Disque plein (ou coupure) pendant que le nouveau contenu s'écrit.
  faulty.failNext.set('writeFileSync', errno('ENOSPC'))
  assert.throws(() => store.setConversation('app:C:/apps/pong', turns('un pong')))
  assert.equal(readFileSync(file, 'utf-8'), before, 'le fichier a été touché par une écriture ratée')

  // Remplacement refusé (fichier ouvert par un antivirus) : pareil.
  faulty.failNext.set('renameSync', errno('EPERM'))
  assert.throws(() => store.setConversation('app:C:/apps/pong', turns('un pong')))
  assert.equal(readFileSync(file, 'utf-8'), before)
  assert.deepEqual(Object.keys(new Store(file).load().conversations), ['app:C:/apps/snake'])

  // Le contenu est forcé sur le disque AVANT de remplacer l'ancien fichier, et c'est un fichier à côté qui est écrit.
  faulty.calls.length = 0
  store.setConversation('app:C:/apps/pong', turns('un pong'))
  const order = faulty.calls.map(([name]) => name).filter((name) => name !== 'mkdirSync')
  assert.deepEqual(order, ['openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync'])
  assert.equal(faulty.calls.find(([name]) => name === 'openSync')[1], 'code-conversations.json.tmp')
  assert.deepEqual(Object.keys(new Store(file).load().conversations).sort(), ['app:C:/apps/pong', 'app:C:/apps/snake'])
})

test('fichier abîmé : jamais écrasé par une liste vide, il est gardé à côté sous un autre nom', (t) => {
  for (const damaged of ['{ "repos": [ {"fullName": "leo/projet"', '[1, 2, 3]', '']) {
    const dir = tempDir(t)
    const file = join(dir, 'code-conversations.json')
    writeFileSync(file, damaged, 'utf-8')
    const Store = loadStore()
    const store = new Store(file, () => Date.UTC(2026, 9, 17, 9, 30))
    assert.deepEqual(store.load(), { repos: [], conversations: {} })

    store.setConversation('app:C:/apps/neuve', turns('nouvelle'))
    const aside = readdirSync(dir).filter((name) => name.includes('illisible'))
    assert.deepEqual(aside, ['code-conversations.illisible-2026-10-17T09-30-00-000Z.json'], `contenu : ${JSON.stringify(damaged)}`)
    assert.equal(readFileSync(join(dir, aside[0]), 'utf-8'), damaged, 'le fichier abîmé a été modifié')
    assert.deepEqual(Object.keys(new Store(file).load().conversations), ['app:C:/apps/neuve'])
  }
})

test('fichier inaccessible pour l’instant (verrouillé) : rien n’est écrit par-dessus pendant la session', (t) => {
  const file = join(tempDir(t), 'code-conversations.json')
  writeFileSync(file, JSON.stringify({ version: 1, repos: [], conversations: { 'app:C:/apps/snake': turns('un snake') } }), 'utf-8')
  const original = readFileSync(file, 'utf-8')
  const faulty = faultyFs()
  faulty.failNext.set('readFileSync', errno('EBUSY'))
  const store = new (loadStore(faulty.fs))(file)
  assert.deepEqual(store.load(), { repos: [], conversations: {} })
  assert.throws(() => store.setRepos([{ fullName: 'leo/projet', at: 1 }]))
  assert.throws(() => store.setConversation('app:C:/apps/pong', turns('un pong')))
  assert.equal(readFileSync(file, 'utf-8'), original, 'le fichier verrouillé a été écrasé')
  assert.equal(readdirSync(path.dirname(file)).some((name) => name.includes('illisible')), false, 'un fichier sain n’est jamais mis de côté')
})

test('reprise de l’ancien stockage : ajoutée au fichier sans rien écraser', (t) => {
  const file = join(tempDir(t), 'code-conversations.json')
  const store = new (loadStore())(file)
  store.setConversation('app:C:/apps/snake', turns('version du fichier'))
  store.setRepos([{ fullName: 'leo/projet', at: 10 }])

  store.importLegacy({
    repos: [{ fullName: 'Leo/Projet', at: 3 }, { fullName: 'leo/site', at: 7 }],
    conversations: { 'app:C:/apps/snake': turns('ancienne version'), 'repo:leo/site': turns('le site') }
  })
  const data = new (loadStore())(file).load()
  assert.equal(data.conversations['app:C:/apps/snake'][0].text, 'version du fichier', 'la reprise a écrasé une conversation déjà enregistrée')
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
  assert.throws(() => store.setConversation('app:C:/apps/x', 'pas une liste'))
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
  store.setConversation('app:C:/apps/long', long)
  const kept = new (loadStore())(file).load().conversations['app:C:/apps/long']
  assert.equal(kept.length, shared.MAX_CODE_TURNS)
  assert.equal(kept[0].text, 'm50')
})
