import assert from 'node:assert/strict'
import * as realFs from 'node:fs'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { join } from 'node:path'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Clé d'une conversation d'APPLICATION du mode Code : le NOM du dossier de l'application, plus jamais son chemin
 * absolu. L'ancienne clé « app:C:\…\generated-apps\1750000000000-snake » ne correspondait plus jamais après un
 * « Déplacer » (ou le rapatriement du démarrage) : le fichier des conversations suivait les données, mais chaque
 * application y était rangée sous l'ancien chemin, et sa conversation disparaissait de l'écran. Les anciennes clés,
 * Windows comme POSIX, sont converties à la lecture.
 */
const shared = loadTsModule('shared/codeConversations.ts')
const Store = loadTsModule('electron/services/codeConversationsStore.ts', {
  fs: realFs,
  path,
  '../../shared/codeConversations': shared,
  './atomicFile': loadTsModule('electron/services/atomicFile.ts', { fs: realFs, 'fs/promises': realFs.promises, path })
}).CodeConversationsStore

const turns = (text, first = 1) => [
  { id: first, kind: 'user', text },
  { id: first + 1, kind: 'reply', text: `Fait : ${text}.` }
]

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-code-keys-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const WINDOWS_OLD = 'C:\\Users\\leo\\AppData\\Roaming\\Jaris\\generated-apps\\1750000000000-snake'
const WINDOWS_MOVED = 'D:\\Jaris-data\\jaris-data\\generated-apps\\1750000000000-snake'
const POSIX_OLD = '/home/leo/.config/Jaris/generated-apps/1750000000001-pong'

test('la clé d’une application ne dépend plus de l’emplacement des données', () => {
  // Même application avant et après « Déplacer » : même clé, quel que soit le séparateur.
  assert.equal(shared.appConversationKey(WINDOWS_OLD), 'app:1750000000000-snake')
  assert.equal(shared.appConversationKey(WINDOWS_MOVED), 'app:1750000000000-snake')
  assert.equal(shared.appConversationKey(`${WINDOWS_MOVED}\\`), 'app:1750000000000-snake', 'séparateur final ignoré')
  assert.equal(shared.appConversationKey(POSIX_OLD), 'app:1750000000001-pong')
  assert.equal(shared.appConversationKey(join('un', 'dossier', 'generated-apps', '1750000000002-tetris')), 'app:1750000000002-tetris')
  assert.equal(shared.appConversationKey('1750000000000-snake'), 'app:1750000000000-snake', 'déjà un nom de dossier')
  // L'écran passe par le même calcul (re-exporté), jamais une copie qui pourrait diverger.
  const screen = loadTsModule('src/lib/codeConversations.ts', { '../../shared/codeConversations': shared })
  assert.equal(screen.appConversationKey(WINDOWS_MOVED), 'app:1750000000000-snake')
})

test('anciennes clés « app:<chemin absolu> » converties ; dépôts et clés au bon format inchangés', () => {
  assert.equal(shared.normalizeCodeConversationKey(`app:${WINDOWS_OLD}`), 'app:1750000000000-snake')
  assert.equal(shared.normalizeCodeConversationKey('app:C:/Users/leo/AppData/Roaming/Jaris/generated-apps/1750000000000-snake'), 'app:1750000000000-snake')
  assert.equal(shared.normalizeCodeConversationKey(`app:${POSIX_OLD}`), 'app:1750000000001-pong')
  assert.equal(shared.normalizeCodeConversationKey('app:1750000000000-snake'), 'app:1750000000000-snake')
  assert.equal(shared.normalizeCodeConversationKey('repo:leo/projet'), 'repo:leo/projet', 'un dépôt garde « propriétaire/nom »')
  assert.equal(shared.normalizeCodeConversationKey('repo:Leo/Mon-Site'), 'repo:Leo/Mon-Site')
})

test('fichier écrit par l’ancienne version (clés Windows ET POSIX) : relu sous les nouvelles clés, puis réécrit sans chemin', (t) => {
  const file = join(tempDir(t), 'code-conversations.json')
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      repos: [{ fullName: 'leo/projet', at: 5 }],
      conversations: {
        [`app:${WINDOWS_OLD}`]: turns('un snake'),
        [`app:${POSIX_OLD}`]: turns('un pong'),
        'repo:leo/projet': turns('corrige le README')
      }
    }),
    'utf-8'
  )
  const store = new Store(file)
  const loaded = store.load()
  assert.deepEqual(Object.keys(loaded.conversations).sort(), ['app:1750000000000-snake', 'app:1750000000001-pong', 'repo:leo/projet'])
  assert.deepEqual(loaded.conversations['app:1750000000000-snake'], turns('un snake'))

  // L'écran (même le vieux code) peut encore envoyer une clé avec un chemin : elle est rangée sous le nom du dossier.
  store.setConversation(`app:${WINDOWS_MOVED}`, turns('un snake plus rapide'))
  const onDisk = JSON.parse(readFileSync(file, 'utf-8'))
  assert.deepEqual(Object.keys(onDisk.conversations).sort(), ['app:1750000000000-snake', 'app:1750000000001-pong', 'repo:leo/projet'])
  assert.deepEqual(onDisk.conversations['app:1750000000000-snake'], turns('un snake plus rapide'))
  // Oublier par une ancienne clé efface bien la conversation rangée sous le nouveau nom (suppression de l'application).
  store.setConversation(`app:${POSIX_OLD}`, null)
  assert.equal(new Store(file).load().conversations['app:1750000000001-pong'], undefined)
})

test('même application sous deux anciens chemins (avant et après un « Déplacer » de l’ancienne version) : rien n’est perdu', (t) => {
  const file = join(tempDir(t), 'code-conversations.json')
  // Conversation complète sous le chemin de C ; après le déplacement, l'ancienne version a écrit sous le chemin de D
  // une demande interrompue — numérotée à partir de 1 elle aussi.
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      repos: [],
      conversations: {
        [`app:${WINDOWS_OLD}`]: turns('un snake'),
        [`app:${WINDOWS_MOVED}`]: [
          { id: 1, kind: 'user', text: 'ajoute un score' },
          { id: 2, kind: 'worked', durationMs: 4000, stopped: true }
        ]
      }
    }),
    'utf-8'
  )
  const conversation = new Store(file).load().conversations['app:1750000000000-snake']
  assert.deepEqual(
    conversation.map((turn) => turn.text ?? turn.kind),
    ['un snake', 'Fait : un snake.', 'ajoute un score', 'worked'],
    'les deux versions, dans l’ordre du fichier'
  )
  const ids = conversation.map((turn) => turn.id)
  assert.equal(new Set(ids).size, ids.length, `deux messages au même numéro se mélangeraient à l’écran : ${ids}`)
})

test('réunir deux versions d’une conversation : ni perte, ni doublon, même réunies deux fois', () => {
  const d = turns('corrige le README')
  // Copie identique (démarrage interrompu avant l'effacement de l'original) : rien n'est doublé.
  assert.deepEqual(shared.combineCodeTurns(d, JSON.parse(JSON.stringify(d))), d)
  // Une version qui contient déjà l'autre l'emporte telle quelle.
  const longer = [...d, { id: 3, kind: 'note', text: 'Aucun fichier changé.' }]
  assert.deepEqual(shared.combineCodeTurns(d, longer), longer)
  assert.deepEqual(shared.combineCodeTurns(longer, d), longer)
  // Deux sessions différentes (D, puis une session sur C numérotée à partir de 1) : tout est gardé, D d'abord.
  const c = turns('ajoute une page contact')
  const combined = shared.combineCodeTurns(d, c)
  assert.deepEqual(combined.map((turn) => turn.text), ['corrige le README', 'Fait : corrige le README.', 'ajoute une page contact', 'Fait : ajoute une page contact.'])
  assert.deepEqual(combined.map((turn) => turn.id), [1, 2, 3, 4])
  // Déjà réunies (le démarrage a écrit la fusion puis s'est arrêté avant d'effacer l'original) : rien n'est rajouté.
  assert.deepEqual(shared.combineCodeTurns(combined, c), combined)
  // Déjà réunies, PUIS la conversation a continué sur C (le démarrage avait abandonné D sur une erreur) : seule la
  // suite est ajoutée, jamais c1 et c-r1 une seconde fois.
  const cContinued = [...c, ...turns('ajoute un formulaire', 3)]
  const again = shared.combineCodeTurns(combined, cContinued)
  assert.deepEqual(
    again.map((turn) => turn.text),
    ['corrige le README', 'Fait : corrige le README.', 'ajoute une page contact', 'Fait : ajoute une page contact.', 'ajoute un formulaire', 'Fait : ajoute un formulaire.'],
    'des messages déjà réunis ont été recopiés'
  )
  assert.deepEqual(again.map((turn) => turn.id), [1, 2, 3, 4, 5, 6])
  // Réunies encore une fois (démarrage rejoué) : rien ne bouge.
  assert.deepEqual(shared.combineCodeTurns(again, cContinued), again)
  // Seule la fin de D recouvre ce que C ajoute : un message de C identique à un message du MILIEU de D (même demande
  // refaite) n'est pas pris pour un doublon.
  const redo = [...turns('ajoute une page contact', 1), ...turns('corrige le README', 3)]
  assert.deepEqual(
    shared.combineCodeTurns(combined, redo).map((turn) => turn.text),
    [...combined.map((turn) => turn.text), 'corrige le README', 'Fait : corrige le README.']
  )

  const both = shared.combineCodeConversations(
    { repos: [{ fullName: 'leo/site', at: 5 }], conversations: { 'repo:leo/site': d, 'app:1750000000000-snake': turns('un snake') } },
    { repos: [{ fullName: 'Leo/Site', at: 9 }, { fullName: 'leo/autre', at: 7 }], conversations: { 'repo:leo/site': c, [`app:${WINDOWS_OLD.replace('snake', 'pong')}`]: turns('un pong') } }
  )
  assert.deepEqual(Object.keys(both.conversations).sort(), ['app:1750000000000-pong', 'app:1750000000000-snake', 'repo:leo/site'])
  assert.deepEqual(both.conversations['repo:leo/site'], combined)
  assert.deepEqual(both.repos, [{ fullName: 'Leo/Site', at: 9 }, { fullName: 'leo/autre', at: 7 }])
})
