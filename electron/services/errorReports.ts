import { app } from 'electron'
import * as Sentry from '@sentry/electron/main'
import { homedir, hostname, userInfo } from 'os'
import { join } from 'path'
import { getDataRoot } from './dataLocation'
import { readFileWithRetriesSync, writeFileAtomicSync } from './atomicFile'
import { ERROR_REPORTS_DSN, PRIVATE_DATA_COLLECTION, scrubErrorEvent, type ErrorReportsState } from '../../shared/errorReports'

/**
 * Étape 527 (Léo : « on va faire un tableau de bord avec tout… et tu vas m'expliquer comment changer les politiques ») :
 * rapports d'erreurs envoyés à Sentry (organisation de Léo, serveurs en Allemagne), SEULEMENT si la personne a dit oui.
 * - Le choix vit dans son propre petit fichier (ERROR_REPORTS_FILE, dans OWNED_ENTRIES), lu de façon synchrone au
 *   démarrage : Sentry doit démarrer avant les fenêtres pour voir aussi les plantages.
 * - Sans « oui » : Sentry n'est jamais démarré, rien ne part.
 * - Avant chaque envoi : scrubErrorEvent (shared/errorReports.ts) retire le nom du PC, le nom d'utilisateur des chemins,
 *   les adresses mail, l'utilisateur, la requête et le fil des dernières actions (il peut contenir du texte de Léo).
 *   Ni capture d'écran, ni variables du programme, ni en-têtes : PRIVATE_DATA_COLLECTION coupe tout ce que Sentry
 *   collecte par défaut.
 */
export const ERROR_REPORTS_FILE = 'rapports-erreurs.json'

let started = false

function filePath(): string {
  return join(getDataRoot(), ERROR_REPORTS_FILE)
}

/** Le choix enregistré : `asked` faux tant que la question n'a jamais été posée. Jamais d'erreur : illisible = pas demandé. */
export function readErrorReportsState(): ErrorReportsState {
  try {
    const raw = readFileWithRetriesSync(filePath())
    if (raw === null) return { asked: false, enabled: false }
    const parsed = JSON.parse(raw) as { enabled?: unknown }
    return { asked: true, enabled: parsed.enabled === true }
  } catch {
    return { asked: false, enabled: false }
  }
}

/** Ce qui identifie la personne dans un texte, à effacer : son dossier, son nom d'utilisateur Windows, le nom du PC. */
function privateWords(): string[] {
  const words: string[] = []
  try {
    words.push(homedir())
  } catch {
    /* rien */
  }
  try {
    words.push(userInfo().username)
  } catch {
    /* rien */
  }
  try {
    words.push(hostname())
  } catch {
    /* rien */
  }
  return words.filter((w) => w && w.length >= 3)
}

/**
 * Démarre Sentry dans le main — seulement avec l'accord. Appelé tout en haut de main.ts (avant `ready`, comme Sentry
 * le demande pour voir les plantages et les fenêtres), puis quand la personne dit oui. Un « oui » donné en cours de
 * route couvre le main tout de suite ; les fenêtres, au démarrage suivant.
 */
export function startErrorReports(): void {
  if (started || !readErrorReportsState().enabled) return
  started = true
  try {
    const words = privateWords()
    Sentry.init({
      dsn: ERROR_REPORTS_DSN,
      release: `jaris@${app.getVersion()}`,
      environment: process.windowsStore === true ? 'store' : 'installeur',
      dataCollection: PRIVATE_DATA_COLLECTION,
      attachScreenshot: false,
      maxBreadcrumbs: 0,
      // Le nom du PC n'est jamais lu (Sentry le met par défaut dans chaque rapport).
      includeServerName: false,
      beforeSend: (event, hint) => {
        // Aucune pièce jointe : lors d'un plantage natif, Sentry joint un « minidump », un extrait de la MÉMOIRE du
        // programme (il peut contenir le texte d'une conversation). Le rapport part quand même (processus, raison).
        // Relu dans @sentry/core 11.16 (client.js) : le même `hint` va de beforeSend à l'envoi.
        hint.attachments = []
        return scrubErrorEvent(event as unknown as Record<string, unknown>, words) as unknown as typeof event
      }
    })
  } catch (err) {
    started = false
    console.error('[jaris] Rapports d’erreurs non démarrés :', err)
  }
}

/** Enregistre le choix ; « oui » démarre tout de suite, « non » coupe tout de suite (rien ne part plus). */
export async function setErrorReports(enabled: boolean): Promise<ErrorReportsState> {
  writeFileAtomicSync(filePath(), JSON.stringify({ enabled, at: new Date().toISOString() }))
  if (enabled) startErrorReports()
  else if (started) {
    await Sentry.close().catch(() => false)
    started = false
  }
  return readErrorReportsState()
}

export function errorReportsRunning(): boolean {
  return started
}
