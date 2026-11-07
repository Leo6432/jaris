import assert from 'node:assert/strict'
import * as realFs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import * as realFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { join } from 'node:path'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 325 : les magasins de données (profil, rappels, langue, notes de mémoire) écrivaient PAR-DESSUS leur fichier.
 * Une coupure de courant, un plantage ou un antivirus pendant l'écriture laissait un fichier tronqué — et chaque lecteur
 * prenait un fichier illisible pour un fichier ABSENT : un profil tronqué relançait l'écran de premier lancement, dont
 * le premier enregistrement (le prénom seul) écrasait le vrai ; une liste de rappels ou une note verrouillée un instant
 * était réécrite avec le seul nouvel ajout.
 *
 * Désormais (atomicFile.ts) : écriture dans un temporaire voisin forcé sur le disque, puis remplacement d'un seul geste ;
 * un fichier abîmé est rangé de côté (fichiers-illisibles) avant tout fichier neuf ; un fichier momentanément illisible
 * fait échouer l'action au lieu d'être pris pour vide. Vrai disque (dossier temporaire), `fs` qui échoue à la demande.
 */

const errno = (code) => Object.assign(new Error(`${code}: simulé`), { code })

/**
 * `fs/promises` réel, avec des pannes à la demande : `busy` (lecture refusée pour ces chemins, comme un antivirus),
 * `refuseRename` (nombre de renommages vers ce chemin refusés en EPERM, `Infinity` pour toujours), `cutWrite` (la
 * prochaine écriture ouverte n'écrit que la moitié du contenu, puis échoue : une coupure de courant).
 */
function faultyFsPromises() {
  const faults = { busy: new Set(), refuseRename: new Map(), cutWrite: false }
  const fsPromises = {
    ...realFsPromises,
    readFile: async (path, ...rest) => {
      if (faults.busy.has(path)) throw errno('EBUSY')
      return realFsPromises.readFile(path, ...rest)
    },
    rename: async (from, to) => {
      const left = faults.refuseRename.get(to) ?? 0
      if (left > 0) {
        faults.refuseRename.set(to, left - 1)
        throw errno('EPERM')
      }
      return realFsPromises.rename(from, to)
    },
    // Une écriture directe PAR-DESSUS le fichier (ce que plus aucun magasin ne doit faire) subit la même coupure.
    writeFile: async (path, data, ...rest) => {
      if (!faults.cutWrite) return realFsPromises.writeFile(path, data, ...rest)
      faults.cutWrite = false
      const bytes = Buffer.from(data)
      await realFsPromises.writeFile(path, bytes.subarray(0, Math.floor(bytes.length / 2)))
      throw errno('EIO')
    },
    open: async (path, flags) => {
      const handle = await realFsPromises.open(path, flags)
      if (!faults.cutWrite) return handle
      faults.cutWrite = false
      return {
        writeFile: async (content) => {
          if (typeof content === 'string') await handle.writeFile(content.slice(0, Math.floor(content.length / 2)))
          else await handle.writeFile(Buffer.from(content).subarray(0, Math.floor(content.length / 2)))
          throw errno('EIO')
        },
        sync: () => handle.sync(),
        close: () => handle.close()
      }
    }
  }
  return { faults, fsPromises }
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-data-files-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function loadAtomicFile(fsPromises) {
  return loadTsModule('electron/services/atomicFile.ts', { fs: realFs, 'fs/promises': fsPromises, path: nodePath })
}

/** Les magasins réels, avec leur dossier de données dans `dataRoot` et le `fs/promises` donné. */
function loadStores(dataRoot, fsPromises = realFsPromises) {
  const atomicFile = loadAtomicFile(fsPromises)
  const common = { path: nodePath, 'fs/promises': fsPromises, './atomicFile': atomicFile, './dataLocation': { getDataRoot: () => dataRoot } }
  const fr = loadTsModule('shared/i18n/fr.ts').fr
  return {
    atomicFile,
    profile: loadTsModule('electron/services/profileStore.ts', common),
    reminders: loadTsModule('electron/services/reminders.ts', { ...common, crypto: { randomUUID: () => 'rappel-neuf' } }),
    memory: loadTsModule('electron/services/memoryStore.ts', { ...common, 'fs/promises': fsPromises }),
    language: loadTsModule('electron/services/language.ts', {
      ...common,
      electron: { app: { getPreferredSystemLanguages: () => ['fr-FR'], getLocale: () => 'fr-FR' } },
      './locales': { localeMessages: (code) => (code === 'fr' ? fr : {}) }
    })
  }
}

/** Les copies de secours rangées dans `fichiers-illisibles`, sous la forme `nom → contenu`. */
function asideCopies(dataRoot) {
  const dir = join(dataRoot, 'fichiers-illisibles')
  if (!existsSync(dir)) return {}
  return Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8')]))
}

test('écriture d’un seul tenant : une coupure en pleine écriture laisse l’ancien fichier intact', async (t) => {
  const dir = tempDir(t)
  const file = join(dir, 'profile.json')
  const { faults, fsPromises } = faultyFsPromises()
  const atomicFile = loadAtomicFile(fsPromises)
  await atomicFile.writeFileAtomic(file, '{"name":"Léo","models":{"flash":"qwen3"}}')

  faults.cutWrite = true
  await assert.rejects(atomicFile.writeFileAtomic(file, '{"name":"Léo","models":{"flash":"autre"}}'), /EIO/)
  assert.equal(readFileSync(file, 'utf8'), '{"name":"Léo","models":{"flash":"qwen3"}}', 'la coupure a tronqué le vrai fichier')
})

test('écriture d’un seul tenant : un renommage refusé un instant est réessayé ; refusé pour de bon, rien ne traîne', async (t) => {
  const dir = tempDir(t)
  const file = join(dir, 'reminders.json')
  const { faults, fsPromises } = faultyFsPromises()
  const atomicFile = loadAtomicFile(fsPromises)
  writeFileSync(file, '[]')

  faults.refuseRename.set(file, 2)
  await atomicFile.writeFileAtomic(file, '[1]')
  assert.equal(readFileSync(file, 'utf8'), '[1]')

  faults.refuseRename.set(file, Infinity)
  await assert.rejects(atomicFile.writeFileAtomic(file, '[2]'), /EPERM/)
  assert.equal(readFileSync(file, 'utf8'), '[1]', 'un remplacement refusé a touché le fichier')
  assert.deepEqual(readdirSync(dir), ['reminders.json'], 'temporaire laissé derrière')
})

test('écritures simultanées d’un même fichier : l’une après l’autre, la dernière demandée reste, jamais un mélange', async (t) => {
  const dir = tempDir(t)
  const file = join(dir, 'profile.json')
  const atomicFile = loadAtomicFile(realFsPromises)
  const contents = Array.from({ length: 25 }, (_, i) => JSON.stringify({ name: 'Léo', version: i, padding: 'x'.repeat(i % 2 ? 4000 : 10) }))
  await Promise.all(contents.map((content) => atomicFile.writeFileAtomic(file, content)))
  assert.equal(readFileSync(file, 'utf8'), contents[contents.length - 1])
  assert.deepEqual(readdirSync(dir), ['profile.json'])
})

test('mise de côté : un fichier remplacé entre-temps par un fichier neuf n’est jamais déplacé à sa place', async (t) => {
  const dir = tempDir(t)
  const file = join(dir, 'profile.json')
  const atomicFile = loadAtomicFile(realFsPromises)
  // Deux lectures ont vu le même profil abîmé ; la première l'a rangé, puis le premier lancement en a écrit un neuf.
  writeFileSync(file, '{"name":"Léo"}')
  assert.equal(await atomicFile.setAsideDamagedFile(file, join(dir, 'fichiers-illisibles'), 'profile', Date.now(), '{"name":"Lé'), null)
  assert.equal(readFileSync(file, 'utf8'), '{"name":"Léo"}', 'le profil neuf a été rangé à la place de l’abîmé')
  assert.ok(!existsSync(join(dir, 'fichiers-illisibles')))
})

test('profil tronqué : rangé de côté AVANT que le premier lancement n’en écrive un neuf', async (t) => {
  const dataRoot = tempDir(t)
  const truncated = '{"name":"Léo","capacityScanDone":true,"models":{"flash":"qw'
  writeFileSync(join(dataRoot, 'profile.json'), truncated)
  const { profile } = loadStores(dataRoot)

  assert.equal(await profile.getProfile(), null, 'un profil abîmé relance bien le premier lancement')
  const copies = asideCopies(dataRoot)
  assert.deepEqual(Object.values(copies), [truncated], 'le profil abîmé doit être gardé tel quel')
  assert.match(Object.keys(copies)[0], /^profile-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/)

  // L'écran de premier lancement enregistre le prénom : la copie du vrai profil reste là.
  await profile.saveProfile({ name: 'Léo' })
  assert.deepEqual(await profile.getProfile(), { name: 'Léo' })
  assert.deepEqual(Object.values(asideCopies(dataRoot)), [truncated])
})

test('profil verrouillé un instant (antivirus) : jamais pris pour « aucun profil », rien n’est touché', async (t) => {
  const dataRoot = tempDir(t)
  const file = join(dataRoot, 'profile.json')
  writeFileSync(file, '{"name":"Léo","contextLength":32768}')
  const { faults, fsPromises } = faultyFsPromises()
  const { profile } = loadStores(dataRoot, fsPromises)

  faults.busy.add(file)
  await assert.rejects(profile.getProfile(), /EBUSY/)
  assert.equal(readFileSync(file, 'utf8'), '{"name":"Léo","contextLength":32768}')
  assert.deepEqual(asideCopies(dataRoot), {}, 'un simple refus passager ne met rien de côté')
  faults.busy.clear()
  assert.equal((await profile.getProfile()).contextLength, 32768)
})

test('profil : une coupure pendant l’enregistrement garde l’ancien, et le temporaire abandonné n’est jamais lu', async (t) => {
  const dataRoot = tempDir(t)
  const { faults, fsPromises } = faultyFsPromises()
  const { profile } = loadStores(dataRoot, fsPromises)
  await profile.saveProfile({ name: 'Léo', models: { flash: 'qwen3:1.7b' } })

  faults.cutWrite = true
  await assert.rejects(profile.saveProfile({ name: 'Léo', models: { flash: 'ministral-3:3b' } }), /EIO/)
  assert.ok(existsSync(join(dataRoot, 'profile.json.tmp')), 'la coupure laisse un temporaire à moitié écrit')
  assert.deepEqual(await profile.getProfile(), { name: 'Léo', models: { flash: 'qwen3:1.7b' } }, 'le profil d’avant doit rester lisible')
  assert.deepEqual(asideCopies(dataRoot), {}, 'rien d’abîmé à mettre de côté')

  // Sans vrai profil, le temporaire ne compte pas : premier lancement, jamais un profil à moitié écrit.
  rmSync(join(dataRoot, 'profile.json'))
  assert.equal(await profile.getProfile(), null)
})

test('rappels tronqués : rangés de côté avant d’écrire la nouvelle liste ; verrouillés : le rappel est refusé, rien n’est perdu', async (t) => {
  const dataRoot = tempDir(t)
  const file = join(dataRoot, 'reminders.json')
  const truncated = '[{"id":"a","message":"appeler maman","fireAt":"2026-11'
  writeFileSync(file, truncated)
  const { faults, fsPromises } = faultyFsPromises()
  const { reminders } = loadStores(dataRoot, fsPromises)

  t.mock.timers.enable({ apis: ['setTimeout'] })
  assert.match(await reminders.scheduleReminder('boire de l’eau', 5, () => {}), /^Rappel programmé/)
  t.mock.timers.reset()
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).map((r) => r.message), ['boire de l’eau'])
  assert.deepEqual(Object.values(asideCopies(dataRoot)), [truncated], 'les rappels abîmés ont été écrasés sans copie')

  const before = readFileSync(file, 'utf8')
  faults.busy.add(file)
  await assert.rejects(reminders.scheduleReminder('sortir le chien', 5, () => {}), /reminders\.json.*EBUSY/)
  assert.equal(readFileSync(file, 'utf8'), before, 'une liste momentanément illisible a été réécrite avec le seul nouveau rappel')
})

test('note de mémoire verrouillée un instant : l’ajout est refusé au lieu de réécrire la note avec ce seul ajout', async (t) => {
  const dataRoot = tempDir(t)
  const note = join(dataRoot, 'memory', 'Adresse.md')
  mkdirSync(join(dataRoot, 'memory'), { recursive: true })
  writeFileSync(note, '# Adresse\n\n_01/10/2026 10:00:00_\n12 rue des Lilas')
  const { faults, fsPromises } = faultyFsPromises()
  const { memory } = loadStores(dataRoot, fsPromises)

  faults.busy.add(note)
  await assert.rejects(memory.rememberNote('Adresse', 'code de la porte : 4521'), /EBUSY/)
  assert.equal(readFileSync(note, 'utf8'), '# Adresse\n\n_01/10/2026 10:00:00_\n12 rue des Lilas')

  faults.busy.clear()
  await memory.rememberNote('Adresse', 'code de la porte : 4521')
  const text = readFileSync(note, 'utf8')
  assert.ok(text.startsWith('# Adresse\n\n_01/10/2026 10:00:00_\n12 rue des Lilas\n\n_'))
  assert.ok(text.endsWith('_\ncode de la porte : 4521'))
  assert.deepEqual(readdirSync(join(dataRoot, 'memory')), ['Adresse.md'])
})

// Relecture croisée : deux ajouts simultanés à la même note (l'outil « remember » et la mémoire automatique de fin
// d'échange) relisaient tous les deux l'ancien contenu : le second écrit effaçait le premier.
test('note de mémoire : des ajouts simultanés à la même note sont tous gardés', async (t) => {
  const dataRoot = tempDir(t)
  const { memory } = loadStores(dataRoot)
  await memory.rememberNote('Léo', 'Aime le jazz.')
  const facts = ['Habite à Lyon.', 'A un chat nommé Pixel.', 'Se lève à 7 h.', 'Joue de la guitare.']
  await Promise.all(facts.map((fact) => memory.rememberNote('Léo', fact)))
  const leo = readFileSync(join(dataRoot, 'memory', 'Léo.md'), 'utf8')
  for (const fact of ['Aime le jazz.', ...facts]) assert.ok(leo.includes(fact), `« ${fact} » perdu`)
  assert.ok(leo.startsWith('# Léo\n'))
  assert.deepEqual(readdirSync(join(dataRoot, 'memory')), ['Léo.md'])
})

test('langue tronquée : rangée de côté, Jaris repart sur la langue de Windows', async (t) => {
  const dataRoot = tempDir(t)
  writeFileSync(join(dataRoot, 'language.json'), '{"setting":"d')
  const { language } = loadStores(dataRoot)
  assert.equal(await language.loadLanguageSetting(), 'fr')
  assert.deepEqual(Object.values(asideCopies(dataRoot)), ['{"setting":"d'])

  await language.saveLanguageSetting('de')
  assert.deepEqual(JSON.parse(readFileSync(join(dataRoot, 'language.json'), 'utf8')), { setting: 'de' })
  await language.saveLanguageSetting('fr')
})

test('les magasins de données n’écrivent plus jamais directement par-dessus leur fichier', () => {
  for (const name of ['profileStore', 'conversationStore', 'reminders', 'language', 'memoryStore']) {
    const source = readFileSync(new URL(`../electron/services/${name}.ts`, import.meta.url), 'utf8')
    assert.ok(!/\bwriteFile\(/.test(source), `${name}.ts écrit encore par-dessus un fichier (writeFile) au lieu de writeFileAtomic`)
    assert.ok(source.includes('writeFileAtomic('), `${name}.ts doit écrire d’un seul tenant (writeFileAtomic)`)
  }
  const code = readFileSync(new URL('../electron/services/codeConversationsStore.ts', import.meta.url), 'utf8')
  assert.ok(code.includes('writeFileAtomicSync('), 'le mode Code partage la même écriture (atomicFile.ts), sans la recopier')
})

/**
 * Relecture croisée : le jeton GitHub, la clé Claude et la trace de connexion GitHub étaient encore écrits PAR-DESSUS leur
 * fichier. Une coupure en pleine écriture laissait un jeton tronqué, donc indéchiffrable : déconnecté de GitHub (et le
 * jeton de renouvellement, à usage unique, perdu avec).
 */
function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.concat([Buffer.from([0xff, 0x00, 0xfe]), Buffer.from(text, 'utf8')]),
    decryptString: (data) => {
      if (data.length < 3 || data[0] !== 0xff || data[1] !== 0x00 || data[2] !== 0xfe) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      return data.subarray(3).toString('utf8')
    }
  }
}

function loadSecrets(dataRoot, fsPromises) {
  const atomicFile = loadAtomicFile(fsPromises)
  const common = { electron: { safeStorage: fakeSafeStorage() }, 'fs/promises': fsPromises, path: nodePath, './atomicFile': atomicFile, './dataLocation': { getDataRoot: () => dataRoot } }
  return { github: loadTsModule('electron/services/github.ts', common), claude: loadTsModule('electron/services/claudeKey.ts', common) }
}

test('jeton GitHub et clé Claude : une coupure en pleine écriture laisse l’ancien intact', async (t) => {
  const dataRoot = tempDir(t)
  const { faults, fsPromises } = faultyFsPromises()
  const { github, claude } = loadSecrets(dataRoot, fsPromises)

  await github.saveGithubToken({ token: 'gho_a', refreshToken: 'ghr_a', expiresAt: 1 })
  faults.cutWrite = true
  await assert.rejects(github.saveGithubToken({ token: 'gho_b', refreshToken: 'ghr_b', expiresAt: 2 }), /EIO/)
  assert.deepEqual({ ...(await github.readGithubToken()) }, { token: 'gho_a', unreadable: false, refreshToken: 'ghr_a', expiresAt: 1 }, 'jeton tronqué : déconnecté')
  // Des octets quelconques (le chiffrement de Windows) passent tels quels, sans réencodage.
  await github.saveGithubToken({ token: 'gho_c', refreshToken: 'ghr_c', expiresAt: 3 })
  assert.equal((await github.readGithubToken()).token, 'gho_c')

  const first = `sk-ant-${'a'.repeat(30)}`
  await claude.saveClaudeKey(first)
  faults.cutWrite = true
  await assert.rejects(claude.saveClaudeKey(`sk-ant-${'b'.repeat(30)}`), /EIO/)
  assert.equal(await claude.loadClaudeKey(), first, 'clé tronquée : perdue')
})

test('trace de connexion GitHub : un échec d’écriture ne fait pas échouer la connexion, mais il laisse une trace', async (t) => {
  const dataRoot = tempDir(t)
  const { github } = loadSecrets(dataRoot, realFsPromises)
  const record = { connectedAt: 1, login: 'leo', memoryOnly: false, rejectedAt: null }
  await github.writeConnectionRecord(record)
  assert.deepEqual(await github.readConnectionRecord(), record)
  // Un dossier à la place du fichier : impossible d'écrire.
  rmSync(join(dataRoot, 'github-connection.json'))
  mkdirSync(join(dataRoot, 'github-connection.json'))
  const logged = t.mock.method(console, 'error', () => {})
  await github.writeConnectionRecord({ ...record, rejectedAt: 2 })
  assert.equal(logged.mock.callCount(), 1, 'échec avalé sans laisser de trace')
  assert.match(String(logged.mock.calls[0].arguments[0]), /\[github\]/)
})

test('jeton GitHub, clé Claude, téléphones : plus jamais écrits directement par-dessus leur fichier', () => {
  for (const name of ['github', 'claudeKey', 'phoneDevices']) {
    const source = readFileSync(new URL(`../electron/services/${name}.ts`, import.meta.url), 'utf8')
    assert.ok(!/\bwriteFile\(/.test(source), `${name}.ts écrit encore par-dessus un fichier (writeFile) au lieu de writeFileAtomic`)
    assert.ok(source.includes('writeFileAtomic('), `${name}.ts doit écrire d’un seul tenant (writeFileAtomic)`)
  }
})

test('un profil verrouillé au démarrage ne laisse plus Jaris invisible : réessayé, puis expliqué, jamais l’écran de premier lancement', () => {
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
  const decision = main.indexOf('onboardingDone = Boolean(profile?.capacityScanDone)')
  assert.ok(decision > 0)
  const before = main.slice(main.lastIndexOf('const profile = ', decision), decision)
  assert.match(before, /^const profile = await readProfileAtStartup\(\)/, 'le démarrage lit encore le profil sans garde (une exception l’arrête avant toute fenêtre)')
  assert.match(main, /async function readProfileAtStartup[\s\S]*?dialog\.showErrorBox[\s\S]*?quitting = true[\s\S]*?app\.quit\(\)/)
  // Les autres lectures du démarrage ne laissent pas de promesse rejetée sans gestion.
  assert.ok(!/void getProfile\(\)\.then\(/.test(main), 'une lecture du profil sans .catch')
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.ok(!/window\.jaris\.getProfile\(\)\.then\(/.test(app), 'App.tsx lit le profil sans gérer un échec (écran vide pour toujours)')
})

test('patchProfile change seulement les champs donnés, sur le profil relu (étape 328)', async (t) => {
  const dataRoot = tempDir(t)
  const { profile } = loadStores(dataRoot)
  await profile.saveProfile({ name: 'Léo', models: { flash: 'qwen3:1.7b' }, soundEffectsEnabled: true })
  // Options a été ouvert ici, avec cette copie. Puis « Retester la configuration » change les modèles :
  await profile.saveProfile({ name: 'Léo', models: { flash: 'ministral-3:3b' }, soundEffectsEnabled: true })
  // Un réglage d'Options ne doit pas remettre l'ancien modèle.
  const updated = await profile.patchProfile({ soundEffectsEnabled: false })
  assert.deepEqual(updated, { name: 'Léo', models: { flash: 'ministral-3:3b' }, soundEffectsEnabled: false })
  assert.deepEqual(await profile.getProfile(), updated)
})

test('patchProfile : deux réglages envoyés en même temps sont gardés tous les deux, et rien n’est créé sans profil', async (t) => {
  const dataRoot = tempDir(t)
  const { profile } = loadStores(dataRoot)
  assert.equal(await profile.patchProfile({ soundEffectsEnabled: false }), null)
  assert.equal(await profile.getProfile(), null, 'un simple réglage ne crée pas de profil')
  await profile.saveProfile({ name: 'Léo' })
  await Promise.all([profile.patchProfile({ soundEffectsEnabled: false }), profile.patchProfile({ activationKeyEnabled: false })])
  assert.deepEqual(await profile.getProfile(), { name: 'Léo', soundEffectsEnabled: false, activationKeyEnabled: false })
})

// Relecture croisée : un champ calculé à partir de sa valeur actuelle (réflexion choisie pour UN mode) se calcule sur le
// profil relu dans la file, jamais sur une copie lue avant une longue attente.
test('patchProfile avec une fonction : calculé sur le profil relu dans la file, sans effacer un réglage fait entre-temps', async (t) => {
  const dataRoot = tempDir(t)
  const { profile } = loadStores(dataRoot)
  await profile.saveProfile({ name: 'Léo', thinkChoices: { chat: { model: 'a', think: 'low' } } })
  await Promise.all([
    profile.patchProfile((current) => ({ thinkChoices: { ...current.thinkChoices, voice: { model: 'b', think: false } } })),
    profile.patchProfile({ audioInputDeviceName: 'Micro USB' }),
    profile.patchProfile((current) => ({ thinkChoices: { ...current.thinkChoices, code: { model: 'c', think: 'high' } } }))
  ])
  const saved = await profile.getProfile()
  assert.deepEqual(Object.keys(saved.thinkChoices).sort(), ['chat', 'code', 'voice'])
  assert.equal(saved.audioInputDeviceName, 'Micro USB')
})

test('main.ts ne réécrit plus jamais le profil entier lu avant une attente : seulement les champs changés', () => {
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const calls = [...main.matchAll(/\bsaveProfile\(([^)\n]*)/g)].map((m) => m[1])
  // Le seul enregistrement entier : celui que l'écran demande lui-même (premier lancement), rien d'autre.
  assert.deepEqual(calls, ['profile'], `réécriture entière du profil dans main.ts : ${calls.join(' | ')}`)
  for (const handler of ['setAudioInputDevice', 'setWakewordEnabled', 'setPhoneAccessEnabled', 'logoutPhoneAccess', 'acknowledgeNewModels']) {
    const at = main.indexOf(`IPC_CHANNELS.${handler},`)
    assert.ok(at !== -1, handler)
    assert.match(main.slice(at, main.indexOf('\n  })', at)), /patchProfile\(/, `${handler} doit passer par patchProfile`)
  }
  for (const name of ['saveThinkChoice', 'saveModelChoice']) {
    const at = main.indexOf(`async function ${name}(`)
    assert.match(main.slice(at, main.indexOf('\n}\n', at)), /patchProfile\(\(current\) =>/, `${name} doit calculer sur le profil relu`)
  }
  const bench = readFileSync(new URL('../electron/services/benchmarkRunner.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(bench, /saveProfile\(/, 'la configuration réécrit encore le profil entier lu avant les téléchargements')
})

test('notes : un titre bizarre ou très long se relit toujours, et le Cerveau ne plante jamais (étape 328)', async (t) => {
  const dataRoot = tempDir(t)
  const { memory } = loadStores(dataRoot)
  const long = `${'Liste des choses importantes à faire pour les vacances '.repeat(2)}`.slice(0, 79) + ' fin'
  await memory.rememberNote('"  Vacances', 'Départ le 12 août.')
  await memory.rememberNote(long, 'Réserver le train.')
  await memory.rememberNote('Con', 'Un nom de fichier interdit sous Windows.')
  const titles = await memory.listMemoryTitles()
  for (const title of titles) {
    assert.equal(title, title.trim(), `aucun nom de note ne commence ni ne finit par une espace : « ${title} »`)
    assert.doesNotMatch(title, /^(con|prn|aux|nul)$/i)
  }
  assert.match(await memory.recallNote('Vacances'), /12 août/)
  assert.match(await memory.recallNote(titles.find((x) => x.startsWith('Liste'))), /train/)
  // Le même titre redonne la même note (pas un second fichier à côté).
  await memory.rememberNote('"  Vacances', 'Retour le 26.')
  assert.equal((await memory.listMemoryTitles()).length, 3)
  const graph = await memory.getMemoryGraph()
  assert.equal(graph.nodes.length, 3)
})

test('notes : une ancienne note au nom terminé par une espace reste lisible, et une note illisible ne bloque pas le Cerveau', async (t) => {
  const dataRoot = tempDir(t)
  const dir = join(dataRoot, 'memory')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'Ancienne note .md'), '# Ancienne note\n\nLien vers [[Voiture]].')
  writeFileSync(join(dir, 'Voiture.md'), '# Voiture\n\nUne Clio.')
  const { memory } = loadStores(dataRoot)
  assert.match(await memory.recallNote('Ancienne note '), /Voiture/)
  const graph = await memory.getMemoryGraph()
  assert.deepEqual(graph.links, [{ source: 'Ancienne note ', target: 'Voiture' }])
  rmSync(join(dir, 'Voiture.md'))
  mkdirSync(join(dir, 'Voiture.md'))
  const after = await memory.getMemoryGraph()
  assert.equal(after.nodes.length, 2, 'une note illisible (ici un dossier) n’empêche pas d’afficher les autres')
})

test('Cerveau : seule la note au titre exact s’affiche, et une note absente répond null (étape 328)', async (t) => {
  const dataRoot = tempDir(t)
  const { memory } = loadStores(dataRoot)
  await memory.rememberNote('Léo - adresse', '12 rue des Lilas.')
  assert.equal(await memory.readNoteForDisplay('Léo'), null, 'jamais la note dont le titre CONTIENT le prénom')
  assert.match(await memory.recallNote('Léo'), /Lilas/, 'le modèle, lui, garde la recherche approchée')
  await memory.rememberNote('Léo', 'Aime le jazz.')
  assert.match(await memory.readNoteForDisplay('léo'), /jazz/)
})
