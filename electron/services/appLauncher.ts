import { exec, spawn } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)
const CACHE_TTL_MS = 5 * 60_000

interface StartApp {
  Name: string
  AppID: string
}

let cache: { apps: StartApp[]; fetchedAt: number } | null = null

/** Liste les applications connues du menu Démarrer Windows (classiques et Store) — aucune curation manuelle. */
async function listInstalledApps(): Promise<StartApp[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.apps

  const { stdout } = await execAsync('powershell -NoProfile -Command "Get-StartApps | ConvertTo-Json -Compress"', {
    windowsHide: true
  })
  const parsed: unknown = JSON.parse(stdout.trim() || '[]')
  const apps = Array.isArray(parsed) ? (parsed as StartApp[]) : [parsed as StartApp]
  cache = { apps, fetchedAt: Date.now() }
  return apps
}

/**
 * Ramène un nom d'application à une forme comparable : minuscules, accents retirés, et toute ponctuation
 * (trait d'union, apostrophe, point...) remplacée par une espace.
 *
 * Constaté en usage réel (Léo, "ouvre le bloc-notes" / "ouvre YouTube" : « il dit c'est lancé mais il lance
 * pas ») : la comparaison brute par sous-chaîne échouait sur des différences purement orthographiques entre
 * ce que le modèle passe en `app_name` (issu d'une transcription vocale, donc sans trait d'union ni accent)
 * et le nom EXACT renvoyé par Get-StartApps. Mesuré avant de corriger, sur une liste imitant un Windows
 * français : "bloc note", "bloc notes", "blocnotes" et "parametres" ne matchaient RIEN — seule la graphie
 * exacte "bloc-notes" fonctionnait. Une fois normalisés, "bloc notes" contient bien "bloc note" (le pluriel
 * se règle donc tout seul par la sous-chaîne) et "parametres" matche "Paramètres".
 */
function normalizeAppName(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    // Plage des diacritiques combinants, écrite en échappements plutôt qu'en caractères littéraux :
    // des accents combinants nus dans le source sont invisibles à la relecture et faciles à casser.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Noms des applications Windows intégrées dont le libellé change selon la langue de l'installation : le
 * modèle traduit régulièrement la demande de Léo en anglais ("notepad" pour "bloc-notes"), et l'inverse
 * arrive si Windows est en anglais alors qu'il parle français. Vérifié avant d'ajouter cette table :
 * "notepad" ne matche RIEN face à "Bloc-notes", quelle que soit la normalisation — aucune lettre commune,
 * c'est une question de langue, pas d'orthographe. Volontairement limitée aux quelques applications
 * intégrées qu'on demande vraiment à la voix : ce n'est pas un dictionnaire général, juste un pont entre
 * les deux libellés possibles d'une même application Windows. Les alias jouent dans les DEUX sens.
 */
const LOCALIZED_ALIASES: string[][] = [
  ['bloc notes', 'notepad'],
  ['calculatrice', 'calculator'],
  ['parametres', 'settings'],
  ['explorateur de fichiers', 'file explorer'],
  ['invite de commandes', 'command prompt'],
  ['magnetophone', 'sound recorder'],
  ['photos', 'photos'],
  ['courrier', 'mail'],
  ['calendrier', 'calendar'],
  ['horloge', 'clock'],
  ['appareil photo', 'camera'],
  // Étape 21bis : « Mobile connecté » en français, « Phone Link » en anglais — aucune normalisation ne
  // rapproche les deux, c'est une question de langue. Jaris l'ouvre pour l'appairage au téléphone.
  ['mobile connecte', 'phone link']
]

/** Toutes les graphies équivalentes d'un nom déjà normalisé (lui-même inclus). */
function aliasesFor(normalized: string): string[] {
  const group = LOCALIZED_ALIASES.find((names) => names.includes(normalized))
  return group ? Array.from(new Set([normalized, ...group])) : [normalized]
}

/**
 * Longueur minimale d'un fragment pour qu'il ait le droit de matcher AUTRE CHOSE que lui-même à
 * l'identique. Sans ce plancher, un nom d'application d'une seule lettre — Léo a "X" (le réseau social)
 * installé — matche par sous-chaîne dès que sa lettre apparaît n'importe où dans la demande : mesuré avant
 * de poser cette limite, "ouvre explorateur", "excel" et "le fichier texte" élisaient TOUS les trois "X".
 * C'est exactement le bug qu'il a déjà vécu ; une correspondance exacte ("ouvre X") reste évidemment
 * possible, elle passe par l'égalité en amont.
 */
const MIN_FRAGMENT_LENGTH = 3

/**
 * Vrai si `needle` apparaît dans `haystack` comme une suite CONTIGUË de mots entiers — le dernier mot
 * pouvant n'être qu'un préfixe du mot correspondant, ce qui règle le pluriel ("bloc note" trouve
 * "Bloc-notes") sans ouvrir la porte aux fragments d'un caractère (voir MIN_FRAGMENT_LENGTH).
 *
 * Comparer des MOTS entiers plutôt que des sous-chaînes brutes est ce qui empêche un nom court de se
 * glisser à l'intérieur d'un mot sans rapport ("x" dans "excel").
 */
function containsWords(haystack: string, needle: string): boolean {
  const hay = haystack.split(' ')
  const want = needle.split(' ')
  if (!want.length || want.length > hay.length) return false

  for (let start = 0; start + want.length <= hay.length; start++) {
    const matches = want.every((word, index) => {
      const candidate = hay[start + index]
      if (word === candidate) return true
      const isLastWord = index === want.length - 1
      return isLastWord && word.length >= MIN_FRAGMENT_LENGTH && candidate.startsWith(word)
    })
    if (matches) return true
  }
  return false
}

/** Même question, mais en ignorant complètement les espaces : "blocnotes" doit trouver "Bloc-notes". */
function containsCompact(haystack: string, needle: string): boolean {
  const compactNeedle = needle.replace(/ /g, '')
  if (compactNeedle.length < MIN_FRAGMENT_LENGTH) return false
  return haystack.replace(/ /g, '').includes(compactNeedle)
}

/** Vrai si le nom de l'application couvre toute la demande ("chrome" -> "Google Chrome"). */
function appCoversQuery(appName: string, query: string): boolean {
  return containsWords(appName, query) || containsCompact(appName, query)
}

/**
 * Exportée pour être testable directement (scripts/test-app-launcher.mjs) sans avoir à mocker
 * `listInstalledApps` (qui lance PowerShell) juste pour exercer la logique d'appariement.
 *
 * Constaté en usage réel (Léo, "Ouvre le bloc-notes et écris bonjour") : Jaris a ouvert "X" (le réseau
 * social) au lieu du bloc-notes. Cause : un appel d'outil `open_app` SANS `app_name` (ou avec une chaîne
 * vide, ex: argument oublié par le petit modèle local) donnait `q === ''` — `"n'importe quoi".includes('')`
 * vaut TOUJOURS `true` en JS, donc TOUTE application installée matchait la condition, et le tri par nom le
 * plus court (pensé pour départager des matches légitimes similaires) élisait alors le nom le plus court de
 * TOUTE la machine, peu important son rapport avec la demande — "X" (1 caractère) gagne face à "Bloc-notes"
 * sans le moindre lien sémantique. Reproduit avec un vrai test AVANT de corriger (query vide -> {Name: 'X'}
 * sur une liste d'apps de test), pas deviné. Corrigé en refusant toute correspondance pour une requête vide
 * — un nom d'application vide ne "matche" plus rien, il déclenche le message "aucune application nommée"
 * déjà existant dans `openApp` (ou le message dédié ci-dessous, si le nom manque carrément).
 *
 * La comparaison se fait sur les noms NORMALISÉS (voir normalizeAppName) et sur leurs alias de langue (voir
 * LOCALIZED_ALIASES) : sans ça, la moitié des demandes réelles de Léo à la voix ne matchaient rien du tout,
 * et Jaris annonçait quand même "c'est lancé" (voir le court-circuit dans assistant.ts, qui l'empêche
 * désormais de mentir sur un échec).
 */
export function findBestMatch(apps: StartApp[], query: string): StartApp | undefined {
  const q = normalizeAppName(query)
  if (!q) return undefined

  const normalized = apps.map((app) => ({ app, name: normalizeAppName(app.Name) }))
  const wanted = aliasesFor(q)

  const exact = normalized.find((entry) => wanted.includes(entry.name))
  if (exact) return exact.app

  // Le nom de l'application couvre TOUTE la demande ("chrome" -> "Google Chrome") : la meilleure
  // correspondance est alors la plus courte, celle qui ajoute le moins de mots à ce qui a été demandé.
  const covering = normalized.filter((entry) =>
    aliasesFor(entry.name).some((alias) => wanted.some((want) => appCoversQuery(alias, want)))
  )
  if (covering.length) {
    return covering.sort((a, b) => a.app.Name.length - b.app.Name.length)[0].app
  }

  // Sinon, l'inverse : la demande contient le nom de l'application ("le bloc-notes" -> "Bloc-notes"). Ici
  // c'est le nom le PLUS LONG qui gagne, celui qui explique la plus grande partie de la demande — sans ça,
  // "bloc notes" élirait une éventuelle app "Notes" (plus courte) plutôt que "Bloc-notes".
  const contained = normalized.filter((entry) =>
    aliasesFor(entry.name).some((alias) => wanted.some((want) => appCoversQuery(want, alias)))
  )
  return contained.sort((a, b) => b.app.Name.length - a.app.Name.length)[0]?.app
}

/**
 * Suffixe du seul message de succès de `openApp` — donc la seule preuve qu'une application a VRAIMENT été
 * lancée. Extrait ici (plutôt que recopié en littéral chez chaque appelant, comme le faisait déjà
 * dependencyServices.ts) parce qu'un deuxième appelant en a maintenant besoin : assistant.ts court-circuite
 * la réponse du modèle quand un `open_app` échoue, pour qu'il ne puisse plus annoncer "c'est lancé" par
 * dessus un échec — constaté en usage réel (Léo : « même quand je dit ouvre l'application youtube ou bloc
 * note il dit c'est lancé mais il lance pas »), exactement le même travers déjà corrigé pour les erreurs
 * SearXNG.
 */
export const APP_LAUNCHED_SUFFIX = 'a été lancé.'

/** Vrai seulement si le résultat de `openApp` est son message de succès. */
export function didAppLaunch(result: string): boolean {
  return result.endsWith(APP_LAUNCHED_SUFFIX)
}

function launch(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    proc.on('error', (err) => resolve(err.message))
    proc.on('spawn', () => resolve(null))
  })
}

/** Ouvre une application installée sur la machine, identifiée par son nom parlé (ex: "discord", "calculatrice"). */
export async function openApp(name: string): Promise<string> {
  // Message dédié (plutôt que de laisser tomber dans le "aucune application nommée" générique, qui
  // afficherait un nom vide entre guillemets) : voir findBestMatch ci-dessus, un nom vide/absent ouvrait
  // jusqu'ici l'application dont le nom est le plus court sur TOUTE la machine, sans rapport avec la demande.
  if (!name.trim()) {
    return "Aucun nom d'application n'a été précisé : impossible de savoir laquelle ouvrir."
  }

  let apps: StartApp[]
  try {
    apps = await listInstalledApps()
  } catch (err) {
    return `Impossible de lister les applications installées : ${err instanceof Error ? err.message : String(err)}`
  }

  const match = findBestMatch(apps, name)
  if (!match) {
    return `Je n'ai trouvé aucune application nommée "${name}" installée sur cette machine.`
  }

  const error = await launch('explorer.exe', [`shell:appsFolder\\${match.AppID}`])
  return error ? `Échec de l'ouverture de "${match.Name}" : ${error}` : `${match.Name} ${APP_LAUNCHED_SUFFIX}`
}
