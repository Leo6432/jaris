import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import type { PhoneDevice, PhoneStatus } from '../../shared/ipc'

const execFileAsync = promisify(execFile)

/**
 * Pont entre Jaris et le téléphone (étape 21), par-dessus KDE Connect.
 *
 * POURQUOI KDE CONNECT ET PAS "MOBILE CONNECTÉ" (Phone Link) : les deux ont été comparés avant d'écrire une
 * seule ligne, comme le demandait l'étape 21. Mobile connecté sait faire plus de choses avec un iPhone
 * (messages et notifications par Bluetooth), mais n'expose AUCUNE API documentée : le seul moyen de s'en
 * servir depuis Jaris serait d'ouvrir sa fenêtre et de cliquer dedans à l'aveugle, ce qui casse à la
 * première mise à jour de Windows. KDE Connect, lui, fournit un vrai programme en ligne de commande
 * (`kdeconnect-cli`) — vérifié dans son dépôt officiel, `cli/` est compilé sur toutes les plateformes, y
 * compris Windows (`add_subdirectory(cli)` hors de tout `if (NOT WIN32)`). C'est donc exactement la même
 * forme d'intégration que tout le reste de Jaris : on lance une commande, on lit sa sortie.
 *
 * CE QUI EST POSSIBLE AVEC UN IPHONE, ET CE QUI NE L'EST PAS. Léo a un iPhone. L'application iOS de KDE
 * Connect contient exactement 8 fonctions (liste des dossiers de `Plugins and Plugin Views` dans le dépôt
 * kdeconnect-ios : Battery, Clipboard, FindMyPhone, Ping, Presenter, RemoteInput, RunCommand, Share) —
 * ni SMS, ni notifications. Leur propre README l'explique : « Notification syncing doesn't work because iOS
 * applications can't access notifications of other apps ». Ce n'est pas une limite de KDE Connect mais
 * d'Apple, donc aucun autre logiciel local ne peut la contourner : ne JAMAIS promettre ici l'envoi de SMS
 * ou la lecture des notifications tant que le téléphone est un iPhone.
 *
 * SÉCURITÉ, le point le plus important de ce fichier : le texte envoyé au téléphone vient du modèle (donc
 * d'une phrase dictée). Toutes les commandes passent par `execFile` avec un TABLEAU d'arguments, jamais par
 * une chaîne de shell — même règle que pour `type_text` (inputControl.ts), qui ne laisse jamais un texte
 * dicté entrer dans une commande PowerShell. Sans ça, un simple `& shutdown -s` prononcé dans une phrase
 * deviendrait une commande exécutée.
 */

/** Emplacements où l'installeur Windows de KDE Connect dépose ses binaires. */
function candidateDirectories(): string[] {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const roots = [programFiles, programFilesX86, localAppData ? join(localAppData, 'Programs') : '']
  const names = ['KDE Connect', 'KDEConnect']
  const dirs: string[] = []
  for (const root of roots) {
    if (!root) continue
    for (const name of names) {
      dirs.push(join(root, name, 'bin'))
      dirs.push(join(root, name))
    }
  }
  return dirs
}

/**
 * Cherche `kdeconnect-cli.exe` sur la machine. `overridePath` est le chemin que Léo a éventuellement
 * désigné lui-même (Options → Téléphone) : il gagne toujours sur la recherche automatique.
 *
 * Pourquoi un repli manuel existe : l'emplacement d'installation dépend de la façon dont KDE Connect a été
 * installé (installeur de kde.org, Microsoft Store, dossier personnalisé) et je n'ai aucun Windows dans cet
 * environnement pour vérifier lequel tombe juste. Plutôt que de deviner une liste de chemins en espérant
 * qu'elle couvre son cas, la liste sert de raccourci et le sélecteur de fichier reste le filet qui marche
 * quoi qu'il arrive.
 */
export function findKdeConnectCli(overridePath?: string): string | null {
  if (overridePath && existsSync(overridePath)) return overridePath
  for (const dir of candidateDirectories()) {
    const candidate = join(dir, 'kdeconnect-cli.exe')
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Lit la sortie de `kdeconnect-cli --list-available --id-name-only`.
 *
 * Format vérifié dans le source officiel (cli/kdeconnect-cli.cpp) : `<id> <nom>` par ligne, l'identifiant
 * d'abord puis le nom APRÈS la première espace — un nom de téléphone contient très souvent des espaces
 * ("iPhone de Léo"), donc découper sur toutes les espaces mélangerait le nom et le rendrait inutilisable.
 * Fonction pure, exportée pour être testable sans KDE Connect ni Windows.
 */
export function parseDeviceList(stdout: string): PhoneDevice[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(' ')
      if (separator === -1) return { id: line, name: line }
      return { id: line.slice(0, separator), name: line.slice(separator + 1).trim() }
    })
    .filter((device) => device.id.length > 0)
}

/** Message d'échec en français, lisible tel quel : personne ne le reformule avant de l'afficher (assistant.ts). */
function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/ENOENT/i.test(message)) {
    return "KDE Connect est introuvable sur cet ordinateur. Installe-le depuis kdeconnect.kde.org, puis rouvre Options → Téléphone."
  }
  return (
    "Le pont vers le téléphone n'a pas répondu. Vérifie que KDE Connect est bien lancé sur l'ordinateur ET " +
    `ouvert sur le téléphone, et que les deux sont sur le même Wi-Fi. (${message.trim()})`
  )
}

async function runCli(cliPath: string, args: string[]): Promise<string> {
  // windowsHide : sans lui, chaque appel ferait clignoter une console noire à l'écran — piège déjà rencontré
  // avec les commandes internes d'Ollama.
  const { stdout } = await execFileAsync(cliPath, args, { windowsHide: true, timeout: 20_000 })
  return stdout
}

/**
 * État du pont, pour Options → Téléphone : KDE Connect est-il installé, répond-il, et quels téléphones sont
 * appairés et joignables ?
 *
 * `--list-available` ne renvoie QUE les appareils à la fois appairés et joignables : c'est exactement la
 * question qui nous intéresse (peut-on lui parler maintenant ?), pas "a-t-il déjà été appairé un jour".
 */
export async function getPhoneStatus(overridePath?: string): Promise<PhoneStatus> {
  const cliPath = findKdeConnectCli(overridePath)
  if (!cliPath) {
    return {
      installed: false,
      reachable: false,
      devices: [],
      message:
        "KDE Connect n'est pas installé (ou Jaris ne l'a pas trouvé). Installe-le sur l'ordinateur depuis " +
        "kdeconnect.kde.org et sur le téléphone depuis l'App Store, puis reviens ici."
    }
  }

  try {
    const stdout = await runCli(cliPath, ['--list-available', '--id-name-only'])
    const devices = parseDeviceList(stdout)
    return {
      installed: true,
      reachable: true,
      devices,
      message:
        devices.length > 0
          ? ''
          : "Aucun téléphone joignable pour l'instant. Ouvre KDE Connect sur le téléphone (sur iPhone " +
            "l'application doit rester au premier plan, Apple ne lui permet pas de travailler en arrière-plan), " +
            'et vérifie que le téléphone et le PC sont sur le même Wi-Fi.'
    }
  } catch (error) {
    return { installed: true, reachable: false, devices: [], message: describeFailure(error) }
  }
}

/** Résout le téléphone à utiliser : celui choisi dans Options, sinon le seul joignable s'il n'y en a qu'un. */
async function resolveDevice(cliPath: string, preferredId?: string): Promise<{ id: string } | { error: string }> {
  const stdout = await runCli(cliPath, ['--list-available', '--id-name-only'])
  const devices = parseDeviceList(stdout)
  if (devices.length === 0) {
    return {
      error:
        "Aucun téléphone joignable. Ouvre KDE Connect sur le téléphone (sur iPhone, l'application doit rester " +
        'affichée à l\'écran) et vérifie que le téléphone et le PC sont sur le même Wi-Fi.'
    }
  }
  if (preferredId && devices.some((device) => device.id === preferredId)) return { id: preferredId }
  // Un seul téléphone joignable : inutile d'exiger un choix dans Options pour que ça marche.
  if (devices.length === 1) return { id: devices[0].id }
  return {
    error:
      'Plusieurs téléphones sont joignables : choisis celui à utiliser dans Options → Téléphone, ' +
      `sinon Jaris ne sait pas auquel parler (${devices.map((device) => device.name).join(', ')}).`
  }
}

type PhoneAction = { args: (deviceId: string) => string[]; success: string }

/** Tronc commun des actions : trouver le programme, trouver le téléphone, lancer, et n'affirmer un succès qu'après. */
async function runPhoneAction(action: PhoneAction, preferredId?: string, overridePath?: string): Promise<string> {
  const cliPath = findKdeConnectCli(overridePath)
  if (!cliPath) {
    return (
      "KDE Connect n'est pas installé sur cet ordinateur : sans lui, Jaris n'a aucun moyen de parler au " +
      'téléphone. Installe-le depuis kdeconnect.kde.org, puis dans Options → Téléphone.'
    )
  }
  try {
    const resolved = await resolveDevice(cliPath, preferredId)
    if ('error' in resolved) return resolved.error
    await runCli(cliPath, action.args(resolved.id))
    return action.success
  } catch (error) {
    return describeFailure(error)
  }
}

/** Fait sonner le téléphone, même s'il est en silencieux (plugin FindMyPhone, présent sur iPhone). */
export async function ringPhone(preferredId?: string, overridePath?: string): Promise<string> {
  return runPhoneAction(
    { args: (deviceId) => ['-d', deviceId, '--ring'], success: 'Le téléphone sonne.' },
    preferredId,
    overridePath
  )
}

/**
 * Envoie un texte (une note, un lien) sur le téléphone — plugin Share, présent sur iPhone.
 *
 * Le texte vient du modèle : il est passé en ARGUMENT, jamais concaténé dans une commande (voir l'en-tête).
 */
export async function sendTextToPhone(text: string, preferredId?: string, overridePath?: string): Promise<string> {
  const trimmed = text.trim()
  if (!trimmed) return "Rien à envoyer : le texte est vide."
  return runPhoneAction(
    {
      args: (deviceId) => ['-d', deviceId, '--share-text', trimmed],
      // Formulation volontairement explicite : "Envoyé sur le téléphone." laisserait croire qu'un SMS est
      // parti à quelqu'un alors que ça dépose un texte sur le téléphone de Léo lui-même. C'est exactement la
      // famille de fausses confirmations déjà corrigée trois fois (étapes 87-90) : un message de succès doit
      // dire ce qui s'est VRAIMENT passé, pas ce que l'utilisateur pourrait croire avoir demandé.
      success: 'Texte déposé sur ton téléphone, dans KDE Connect (ce n\'est pas un SMS envoyé à quelqu\'un).'
    },
    preferredId,
    overridePath
  )
}

/** Envoie un fichier déjà présent sur le PC vers le téléphone (plugin Share). */
export async function sendFileToPhone(filePath: string, preferredId?: string, overridePath?: string): Promise<string> {
  if (!existsSync(filePath)) return `Ce fichier n'existe pas sur l'ordinateur : ${filePath}`
  return runPhoneAction(
    { args: (deviceId) => ['-d', deviceId, '--share', filePath], success: 'Fichier envoyé sur le téléphone.' },
    preferredId,
    overridePath
  )
}
