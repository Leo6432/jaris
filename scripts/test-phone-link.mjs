import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Lecture des notifications du téléphone via Mobile connecté (étape 21bis, electron/services/phoneLink.ts).
 *
 * Ni Windows, ni iPhone, ni Mobile connecté ici : le script PowerShell lui-même ne peut être ni exécuté ni
 * vérifié dans cet environnement. C'est justement pourquoi tout ce qui peut être testé a été mis du côté
 * TypeScript (analyse de la sortie, choix des messages) — même partage qu'à l'étape 32 pour UI Automation.
 * Ce qui reste à confirmer par Léo est écrit noir sur blanc dans le fichier testé.
 */
const nodeRequire = createRequire(import.meta.url)
const projectRoot = new URL('..', import.meta.url)
const sourceText = readFileSync(new URL('electron/services/phoneLink.ts', projectRoot), 'utf8')
const source = ts.transpileModule(sourceText, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

// Realm COURANT (pas runInNewContext) : ce fichier compare de vrais tableaux avec deepEqual, et un contexte
// vm séparé a ses propres prototypes — piège déjà documenté, et déjà repayé une fois cette session.
const exports = {}
vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(exports, { exports }, (name) =>
  name === 'child_process' ? { execFile: () => {} } : nodeRequire(name)
)
const { parseNotificationsOutput, formatNotificationsForSpeech } = exports

test('une notification unique ne se perd pas (ConvertTo-Json sans -AsArray)', () => {
  // LE piège de PowerShell 5.1, déjà rencontré à l'étape 32 : une liste d'UN élément ressort en OBJET, pas
  // en tableau. Une seule notification, c'est le cas le plus banal — donc celui qu'on teste le moins
  // spontanément, et celui qui aurait fait dire à Jaris "tu n'as rien reçu" alors qu'il y avait un message.
  const stdout = JSON.stringify({ status: 'allowed', notifications: { app: 'Mobile connecté', lines: 'Maman : à table' } })
  const result = parseNotificationsOutput(stdout)
  assert.equal(result.status, 'allowed')
  assert.deepEqual(result.notifications, [{ app: 'Mobile connecté', lines: ['Maman : à table'] }])
})

test('plusieurs notifications gardent leur application et leurs lignes', () => {
  const stdout = JSON.stringify({
    status: 'allowed',
    notifications: [
      { app: 'Mobile connecté', lines: ['Maman', 'Tu rentres quand ?'] },
      { app: 'Outlook', lines: ['Facture'] }
    ]
  })
  const result = parseNotificationsOutput(stdout)
  assert.equal(result.notifications.length, 2)
  assert.deepEqual(result.notifications[0].lines, ['Maman', 'Tu rentres quand ?'])
  assert.match(result.message, /2 notification/)
})

test("un refus de Windows ne se lit JAMAIS comme « tu n'as rien reçu »", () => {
  // Le point le plus important de ce fichier : zéro notification et accès refusé donnent tous les deux une
  // liste vide. Si les deux messages se ressemblaient, Léo croirait n'avoir aucun message alors que Jaris
  // n'a simplement pas le droit de regarder.
  const refus = parseNotificationsOutput(JSON.stringify({ status: 'denied', detail: 'Denied' }))
  const vide = parseNotificationsOutput(JSON.stringify({ status: 'allowed', notifications: [] }))
  assert.equal(refus.status, 'denied')
  assert.match(refus.message, /Paramètres Windows/)
  assert.match(refus.message, /autorise/i)
  assert.doesNotMatch(refus.message, /Aucune notification/)
  assert.match(vide.message, /Aucune notification/)
})

test('rien reçu : on explique quoi vérifier côté téléphone, au lieu de laisser deviner', () => {
  const vide = parseNotificationsOutput(JSON.stringify({ status: 'allowed', notifications: [] }))
  assert.match(vide.message, /Mobile connecté/)
  assert.match(vide.message, /iPhone/)
})

test('une version de Windows trop ancienne est distinguée d’une vraie panne', () => {
  const vieux = parseNotificationsOutput(JSON.stringify({ status: 'unsupported', detail: 'type introuvable' }))
  assert.equal(vieux.status, 'unsupported')
  assert.match(vieux.message, /version de Windows/)
})

test('une sortie illisible devient une erreur lisible, jamais un plantage', () => {
  for (const sortie of ['', '   ', 'Erreur PowerShell inattendue', '{"status":']) {
    const result = parseNotificationsOutput(sortie)
    assert.equal(result.status, 'error')
    assert.deepEqual(result.notifications, [])
    assert.ok(result.message.length > 0)
  }
})

test('les lignes vides sont retirées, et une notification sans texte ne casse rien', () => {
  const result = parseNotificationsOutput(
    JSON.stringify({ status: 'allowed', notifications: [{ app: 'Test', lines: ['Salut', '', '   ', null] }, { app: '', lines: [] }] })
  )
  assert.deepEqual(result.notifications[0].lines, ['Salut'])
  assert.deepEqual(result.notifications[1], { app: '', lines: [] })
})

test('la mise en phrase reste lisible à voix haute', () => {
  const result = parseNotificationsOutput(
    JSON.stringify({ status: 'allowed', notifications: [{ app: 'Mobile connecté', lines: ['Maman', 'À table'] }] })
  )
  assert.equal(formatNotificationsForSpeech(result), 'Mobile connecté : Maman — À table')
  // En cas d'échec, c'est le MESSAGE qui est dit, jamais une liste vide silencieuse.
  const refus = parseNotificationsOutput(JSON.stringify({ status: 'denied', detail: 'Denied' }))
  assert.equal(formatNotificationsForSpeech(refus), refus.message)
})

test('le script PowerShell ne reçoit aucune donnée du modèle et cache sa console', () => {
  // Règle héritée de l'étape 32 : ce qui n'est pas vérifiable ici (PowerShell) ne manipule jamais de données
  // non fiables. Le script est une constante sans le moindre paramètre — aucune interpolation possible.
  const withoutComments = ts.transpileModule(sourceText, {
    compilerOptions: { removeComments: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const script = /READ_NOTIFICATIONS_SCRIPT = `([\s\S]*?)`/.exec(withoutComments)
  assert.ok(script, 'script PowerShell introuvable')
  assert.doesNotMatch(script[1], /\$\{/, 'le script PowerShell contient une interpolation')
  assert.match(withoutComments, /windowsHide:\s*true/)
  assert.match(withoutComments, /'-NoProfile'/)
})

test('aucune trace de KDE Connect ne subsiste dans le code', () => {
  // Léo a demandé de tout retirer ("enlève tout kde connect"). Un grep-sweep après un retrait est une étape
  // de la checklist du projet : ce test le rend permanent plutôt que ponctuel.
  const fichiers = [
    'electron/services/phoneLink.ts',
    'electron/services/tools.ts',
    'electron/main.ts',
    'electron/preload.ts',
    'shared/ipc.ts',
    'src/components/OptionsMenu.tsx',
    'src/global.d.ts'
  ]
  for (const fichier of fichiers) {
    // Commentaires retirés : c'est le CODE qui ne doit plus appeler KDE Connect. Expliquer en commentaire
    // pourquoi il a été retiré est au contraire ce qui évite qu'il revienne par inadvertance.
    const contenu = ts.transpileModule(readFileSync(new URL(fichier, projectRoot), 'utf8'), {
      compilerOptions: {
        removeComments: true,
        jsx: fichier.endsWith('.tsx') ? ts.JsxEmit.Preserve : ts.JsxEmit.None,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022
      }
    }).outputText
    assert.doesNotMatch(contenu, /kdeconnect|kde connect/i, `${fichier} référence encore KDE Connect`)
  }
})
