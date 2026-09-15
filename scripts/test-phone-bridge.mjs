import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { promisify } from 'node:util'
import ts from 'typescript'

/**
 * Pont téléphone (étape 21, electron/services/phoneBridge.ts).
 *
 * Ni KDE Connect, ni Windows, ni iPhone dans cet environnement : ces tests vérifient ce qui EST vérifiable
 * ici — les commandes réellement construites, le texte qui reste un argument et jamais une commande, et les
 * messages rendus à Léo quand ça ne marche pas. Le comportement réel de KDE Connect sur sa machine ne peut
 * être confirmé que par lui (même honnêteté que pour tout ce qui touche à Windows dans ce dépôt).
 */
const nodeRequire = createRequire(import.meta.url)
// findKdeConnectCli lit ces variables pour deviner où KDE Connect s'installe : posées ici pour que le test
// se comporte pareil sur le Linux de développement et sur le runner Windows de la CI.
process.env.ProgramFiles = 'C:\\Program Files'
process.env.LOCALAPPDATA = 'C:\\Users\\leo\\AppData\\Local'
const projectRoot = new URL('..', import.meta.url)
const sourceText = readFileSync(new URL('electron/services/phoneBridge.ts', projectRoot), 'utf8')
const source = ts.transpileModule(sourceText, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

/**
 * `cliFound` : kdeconnect-cli.exe trouvé ou non. `devices` : ce que répond `--list-available --id-name-only`.
 * `failWith` : message d'erreur à lever à la place (réseau coupé, démon arrêté...).
 */
function setup({ cliFound = true, devices = 'abc123 iPhone de Léo\n', failWith = null } = {}) {
  const calls = []
  const run = (file, args) => {
    calls.push({ file, args })
    if (failWith) return Promise.reject(new Error(failWith))
    if (args.includes('--list-available')) return Promise.resolve({ stdout: devices, stderr: '' })
    return Promise.resolve({ stdout: '', stderr: '' })
  }
  // Même marque [util.promisify.custom] que le vrai child_process.execFile : sans elle, promisify résout
  // vers un tableau positionnel et `const { stdout } = await execFileAsync(...)` recevrait undefined — le
  // test passerait alors à côté de ce qu'il prétend vérifier (piège déjà rencontré à l'étape 66).
  const execFile = (file, args, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb
    void run(file, args).then(
      ({ stdout, stderr }) => callback(null, stdout, stderr),
      (err) => callback(err)
    )
  }
  execFile[promisify.custom] = (file, args) => run(file, args)

  const modules = {
    child_process: { execFile },
    fs: { existsSync: () => cliFound },
    path: nodeRequire('path'),
    util: nodeRequire('util')
  }
  // Chargé dans le realm COURANT (runInThisContext + enveloppe), pas dans un contexte vm séparé : un
  // contexte séparé a ses propres prototypes Array/Object, et `assert.deepEqual` y échoue sur des objets
  // pourtant identiques ("same structure but are not reference-equal") — piège déjà documenté, et rencontré
  // à nouveau en écrivant ce fichier, qui compare de vrais tableaux d'arguments.
  const exports = {}
  vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(exports, { exports }, (name) => modules[name] ?? nodeRequire(name))
  return { ...exports, calls }
}

test('la liste des téléphones garde les noms contenant des espaces', () => {
  const { parseDeviceList } = setup()
  // Format vérifié dans le source officiel de kdeconnect-cli : "<id> <nom>", le nom vient APRÈS la première
  // espace. Découper sur toutes les espaces couperait "iPhone de Léo" en morceaux.
  assert.deepEqual(parseDeviceList('abc123 iPhone de Léo\ndef456 Vieux tel\n'), [
    { id: 'abc123', name: 'iPhone de Léo' },
    { id: 'def456', name: 'Vieux tel' }
  ])
})

test('une sortie vide ne donne aucun téléphone, pas une ligne fantôme', () => {
  const { parseDeviceList } = setup()
  assert.deepEqual(parseDeviceList(''), [])
  assert.deepEqual(parseDeviceList('\n  \n'), [])
})

test('faire sonner vise le bon téléphone, avec ses arguments séparés', async () => {
  const { ringPhone, calls } = setup()
  const message = await ringPhone()
  assert.equal(message, 'Le téléphone sonne.')
  const ring = calls.find((call) => call.args.includes('--ring'))
  assert.ok(ring, `aucune commande --ring lancée : ${JSON.stringify(calls)}`)
  assert.deepEqual(ring.args, ['-d', 'abc123', '--ring'])
})

test("le texte dicté reste un ARGUMENT, il ne peut jamais devenir une commande", async () => {
  // Le cœur de ce fichier. Le texte vient du modèle, donc d'une phrase prononcée : s'il était concaténé dans
  // une ligne de commande, "coupe le son & shutdown -s -t 0" éteindrait vraiment le PC. Avec execFile et un
  // tableau d'arguments, il reste UNE chaîne, quoi qu'elle contienne.
  const piege = 'coucou" & shutdown -s -t 0 & echo "'
  const { sendTextToPhone, calls } = setup()
  await sendTextToPhone(piege)
  const share = calls.find((call) => call.args.includes('--share-text'))
  assert.ok(share, 'aucune commande --share-text lancée')
  assert.equal(share.args[share.args.indexOf('--share-text') + 1], piege)
  // Le texte ne doit apparaître nulle part ailleurs (ni recollé dans le nom du programme, ni dans un autre
  // argument) : un seul argument le porte, en entier.
  assert.equal(share.args.filter((arg) => arg.includes('shutdown')).length, 1)
  assert.ok(!share.file.includes('shutdown'))
})

test("le succès dit que ce n'est PAS un SMS", async () => {
  // Léo a un iPhone et voulait d'abord envoyer des SMS : « Envoyé sur le téléphone. » lui laisserait croire
  // qu'un message est parti à quelqu'un. Même famille que les fausses confirmations des étapes 87-90.
  const { sendTextToPhone } = setup()
  const message = await sendTextToPhone('un lien')
  assert.match(message, /pas un SMS/i)
})

test('un texte vide ne lance aucune commande', async () => {
  const { sendTextToPhone, calls } = setup()
  const message = await sendTextToPhone('   ')
  assert.match(message, /vide/i)
  assert.equal(calls.length, 0)
})

test("sans KDE Connect installé, rien n'est lancé et le message dit quoi faire", async () => {
  const { ringPhone, getPhoneStatus, calls } = setup({ cliFound: false })
  const message = await ringPhone()
  assert.match(message, /kdeconnect\.kde\.org/)
  assert.equal(calls.length, 0, 'une commande a été lancée alors que le programme est introuvable')
  const status = await getPhoneStatus()
  assert.equal(status.installed, false)
  assert.deepEqual(status.devices, [])
})

test('aucun téléphone joignable : on explique le Wi-Fi et l’application à garder ouverte', async () => {
  const { ringPhone, calls } = setup({ devices: '' })
  const message = await ringPhone()
  assert.match(message, /Wi-Fi/)
  assert.match(message, /iPhone/)
  assert.ok(!calls.some((call) => call.args.includes('--ring')), 'commande lancée sans téléphone joignable')
})

test('plusieurs téléphones joignables sans choix enregistré : Jaris demande lequel, il n’en tire pas un au hasard', async () => {
  const { ringPhone, calls } = setup({ devices: 'abc123 iPhone de Léo\ndef456 Tablette\n' })
  const message = await ringPhone()
  assert.match(message, /Options → Téléphone/)
  assert.match(message, /iPhone de Léo/)
  assert.ok(!calls.some((call) => call.args.includes('--ring')))
})

test('le téléphone choisi dans Options est bien celui utilisé', async () => {
  const { ringPhone, calls } = setup({ devices: 'abc123 iPhone de Léo\ndef456 Tablette\n' })
  assert.equal(await ringPhone('def456'), 'Le téléphone sonne.')
  const ring = calls.find((call) => call.args.includes('--ring'))
  assert.deepEqual(ring.args, ['-d', 'def456', '--ring'])
})

test("une commande en échec donne une phrase actionnable, jamais l'erreur brute seule", async () => {
  // Les messages d'échec d'outil sont affichés TELS QUELS (court-circuit d'assistant.ts) : ils doivent être
  // lisibles par Léo, pas par un développeur.
  const { ringPhone } = setup({ failWith: 'connect: connection refused' })
  const message = await ringPhone()
  assert.match(message, /KDE Connect est bien lancé/)
  assert.match(message, /même Wi-Fi/)
  assert.match(message, /connection refused/, "la cause réelle doit rester visible dans le message")
})

test('aucune commande de ce service ne passe par un shell', () => {
  // Vérification STRUCTURELLE : c'est la garantie qui rend le test du texte piégé ci-dessus durable. Un
  // futur ajout qui repasserait par `exec` (chaîne unique interprétée par cmd.exe) rouvrirait la faille sans
  // qu'aucun test de comportement ne s'en aperçoive.
  const withoutComments = ts.transpileModule(sourceText, {
    compilerOptions: { removeComments: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  assert.doesNotMatch(withoutComments, /\bshell\s*:/, 'option shell utilisée dans phoneBridge.ts')
  assert.doesNotMatch(withoutComments, /require\("child_process"\)\.exec\b/, 'exec() au lieu de execFile()')
  assert.match(withoutComments, /execFile/)
  // windowsHide sur chaque lancement : sans lui, chaque appel fait clignoter une console noire (piège déjà
  // rencontré avec les commandes internes d'Ollama).
  assert.match(withoutComments, /windowsHide:\s*true/)
})
