import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { SCENARIOS } from './benchmark-scenarios.mjs'
import { DUEL_AGENT_TASKS } from './duel-agent-tasks.mjs'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 507 (Léo : « il n'y a pas un système de correction à la place d'utiliser un modèle ? », puis « oui ») : la
 * correction de ce que Léo dit par la LISTE des mots que Jaris connaît (applications, son nom, le prénom de Léo, les
 * titres des notes). Un nom mal entendu est remis ; une phrase juste n'est jamais touchée.
 */
const c = loadTsModule('electron/services/transcriptCorrector.ts')

// Un vrai menu Démarrer de Windows français, chargé d'applications courantes.
const APPS = ['Microsoft Edge', 'Paramètres', 'Calculatrice', 'Bloc-notes', 'Photos', 'Courrier', 'Calendrier', 'Microsoft Store', 'Spotify', 'Discord', 'Steam', 'Google Chrome', 'Paint', 'Explorateur de fichiers', 'Horloge', 'Météo', 'Xbox', 'Microsoft Teams', 'Word', 'Excel', 'PowerPoint', 'OneDrive', 'VLC media player', 'Visual Studio Code', 'Jaris', 'Outil Capture d’écran', 'Terminal', 'Gestionnaire des tâches', 'Netflix', 'WhatsApp', 'Telegram', 'OBS Studio', 'Epic Games Launcher', 'Battle.net', 'Minecraft Launcher', 'Ubisoft Connect', 'EA app', 'Firefox', 'Brave', 'Opera GX', 'Signal', 'Zoom', 'Skype', 'Audacity', 'GIMP', 'Blender', 'Notepad++', '7-Zip', 'Adobe Acrobat', 'Microsoft Clipchamp', 'Lecteur multimédia', 'Enregistreur vocal', 'Pense-bête', 'Cartes', 'Conseils', 'Assistance rapide', 'Panneau de configuration', 'Invite de commandes', 'Windows PowerShell']
const lexicon = c.buildLexicon({ apps: APPS, userName: 'Léo', notes: ['Voiture', 'Anniversaires', 'Courses', 'Mot de passe wifi', 'Portail'] })
const fix = (text) => c.correctTranscript(text, lexicon).text

test('un nom mal entendu est remis : application, nom de l’assistant', () => {
  assert.equal(fix('ouvre stime'), 'ouvre Steam')
  assert.equal(fix('Charisse mets un minuteur de dix minutes'), 'Jaris mets un minuteur de dix minutes')
  assert.equal(fix('lance crome'), 'lance Chrome')
  assert.equal(fix('ouvre exel'), 'ouvre Excel')
  // Ponctuation, espaces et autres mots restent exactement tels qu'entendus.
  assert.equal(fix('Bon, ouvre stime !'), 'Bon, ouvre Steam !')
  const out = c.correctTranscript('ouvre stime', lexicon)
  assert.deepEqual([out.changed, out.replaced], [true, [['stime', 'Steam']]])
})

test('étape 505 (journal de Léo) : « Quelle heure est-il? » n’est plus jamais touché', () => {
  assert.deepEqual(c.correctTranscript('Quelle heure est-il?', lexicon), { text: 'Quelle heure est-il?', changed: false, replaced: [] })
})

test('un vrai mot qui ne diffère que par sa terminaison n’est pas un nom mal entendu (« signale », « blocs »)', () => {
  assert.equal(fix('Un formateur de JSON qui signale les erreurs'), 'Un formateur de JSON qui signale les erreurs')
  assert.equal(fix("Un jeu où l'on empile des blocs"), "Un jeu où l'on empile des blocs")
  // Les mots courants ne sont jamais remplacés, même s'ils sonnent comme une application (« pain » / Paint).
  assert.equal(fix('écris la liste : pain, lait, œufs'), 'écris la liste : pain, lait, œufs')
})

test('aucune des vraies demandes du test des modèles et des duels n’est changée (≈ 230 phrases)', () => {
  const fr = readFileSync(new URL('../shared/i18n/fr.ts', import.meta.url), 'utf8')
  const ideas = [...fr.matchAll(/"duel\.suggest\.[a-z]+\.\d+": "([^"]+)"/g)].map((m) => m[1])
  const phrases = [...SCENARIOS.flatMap((s) => s.turns), ...DUEL_AGENT_TASKS.flatMap((s) => s.turns), ...ideas]
  assert.ok(phrases.length >= 200, `${phrases.length} phrases`)
  const changed = phrases.map((p) => [p, c.correctTranscript(p, lexicon)]).filter(([, r]) => r.changed)
  assert.deepEqual(changed.map(([p, r]) => `${p} → ${JSON.stringify(r.replaced)}`), [])
})

test('la liste : Jaris toujours, le prénom, chaque mot des applications et des notes ; sans doublon ni mot trop court', () => {
  const small = c.buildLexicon({ apps: ['Google Chrome', 'EA app', 'Steam', 'steam'], userName: 'Léonard', notes: ['Portail'] })
  assert.deepEqual(small.words.map((w) => w.display).sort(), ['Chrome', 'Google', 'Jaris', 'Léonard', 'Portail', 'Steam'])
  // Sans rien (Windows n'a pas donné ses applications) : Jaris reste reconnu.
  assert.equal(c.correctTranscript('Charisse ouvre stime', c.buildLexicon({})).text, 'Jaris ouvre stime')
})

test('la voix corrige par la liste (appLauncher, notes, prénom) et plus par un modèle', () => {
  const pipeline = readFileSync(new URL('../electron/services/voicePipeline.ts', import.meta.url), 'utf8')
  assert.match(pipeline, /correctTranscript\(combined, buildLexicon\(\{ apps, userName: profile\?\.name \?\? null, notes \}\)\)/)
  assert.doesNotMatch(pipeline, /structuredChat|preferLoadedModel/)
})
