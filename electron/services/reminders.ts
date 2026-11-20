import { join } from 'path'
import { randomUUID } from 'crypto'
import { UNREADABLE_DATA_DIR, readJsonDataFile, writeFileAtomic } from './atomicFile'
import { getDataRoot } from './dataLocation'

export interface Reminder {
  id: string
  message: string
  fireAt: string
}

type ReminderFireHandler = (message: string) => void

const storePath = join(getDataRoot(), 'reminders.json')
/** Où une liste de rappels abîmée est rangée avant d'être remplacée (atomicFile.ts) : elle suit « Déplacer ». */
const unreadableDir = join(getDataRoot(), UNREADABLE_DATA_DIR)
const timers = new Map<string, ReturnType<typeof setTimeout>>()
/** Plus long délai qu'un setTimeout respecte (2^31-1 ms, 24,8 jours) ; au-delà, Node le ramène à 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * Étape 325 : avant, toute erreur de lecture rendait une liste VIDE, et le rappel suivant réécrivait le fichier avec
 * ce seul rappel — tous les autres étaient perdus. Abîmé, le fichier est rangé de côté ; momentanément illisible,
 * l'action échoue (DataFileUnreadableError) sans rien réécrire.
 */
async function readReminders(): Promise<Reminder[]> {
  const read = await readJsonDataFile(storePath, (value) => (Array.isArray(value) ? (value as Reminder[]) : null), unreadableDir, 'reminders')
  return read.status === 'ok' ? read.value : []
}

/** D'un seul tenant (atomicFile.ts) : une coupure en pleine écriture laisse l'ancienne liste intacte. */
async function writeReminders(reminders: Reminder[]): Promise<void> {
  await writeFileAtomic(storePath, JSON.stringify(reminders, null, 2))
}

/**
 * Étape 328 : chaque modification relit la liste, la change puis la réécrit — une à la fois. Plusieurs rappels en
 * retard au démarrage sonnaient ensemble : chacun relisait la même liste complète et retirait SEULEMENT le sien, et la
 * dernière écriture gagnait. Les autres restaient dans le fichier et sonnaient de nouveau au lancement suivant.
 */
let writeChain: Promise<unknown> = Promise.resolve()
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task)
  writeChain = run.catch(() => undefined)
  return run
}

function removeReminder(id: string): Promise<void> {
  return exclusive(async () => {
    const reminders = await readReminders()
    await writeReminders(reminders.filter((r) => r.id !== id))
  })
}

function arm(reminder: Reminder, onFire: ReminderFireHandler): void {
  // Étape 234 (bêta) : réarmer un rappel déjà armé remplaçait le minuteur dans la liste SANS annuler l'ancien —
  // les deux sonnaient. C'est ce que faisait chaque redémarrage du moteur vocal (changement de micro...).
  const previous = timers.get(reminder.id)
  if (previous) clearTimeout(previous)
  const delayMs = Math.max(0, new Date(reminder.fireAt).getTime() - Date.now())
  // Étape 324 : setTimeout ramène à 1 ms tout délai au-delà de 2^31-1 ms (24,8 jours) — « rappelle-moi dans un
  // mois » sonnait tout de suite, puis était effacé. Un délai plus long attend par tranches et se réarme.
  if (delayMs > MAX_TIMER_MS) {
    timers.set(reminder.id, setTimeout(() => arm(reminder, onFire), MAX_TIMER_MS))
    return
  }
  const timer = setTimeout(() => {
    timers.delete(reminder.id)
    // Fichier verrouillé un instant : le rappel sonne quand même ; resté dans le fichier, il sera retiré plus tard.
    removeReminder(reminder.id).catch((err) => console.error('[jaris] Rappel non retiré de la liste :', err))
    onFire(reminder.message)
  }, delayMs)
  timers.set(reminder.id, timer)
}

/** Programme un rappel vocal, persisté sur disque pour survivre à un redémarrage de Jaris. */
export async function scheduleReminder(message: string, delayMinutes: number, onFire: ReminderFireHandler): Promise<string> {
  if (!message.trim() || !(delayMinutes > 0)) {
    return "Je n'ai pas pu programmer ce rappel : message ou délai invalide."
  }

  const reminder: Reminder = {
    id: randomUUID(),
    message: message.trim(),
    fireAt: new Date(Date.now() + delayMinutes * 60_000).toISOString()
  }

  await exclusive(async () => {
    const reminders = await readReminders()
    reminders.push(reminder)
    await writeReminders(reminders)
  })
  arm(reminder, onFire)

  return `Rappel programmé dans ${delayMinutes} minute${delayMinutes > 1 ? 's' : ''} : ${reminder.message}`
}

/** Minuscules, sans accents ni ponctuation : « Sortir les pâtes ! » et « pates » se comparent. */
function plain(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** « dans 9 min (10 h 09) » : le temps restant et l'heure, comme Léo les dirait. */
function whenText(fireAt: string, now: number): string {
  const at = new Date(fireAt)
  const minutes = Math.max(0, Math.round((at.getTime() - now) / 60_000))
  const clock = `${at.getHours()} h ${String(at.getMinutes()).padStart(2, '0')}`
  const sameDay = at.toDateString() === new Date(now).toDateString()
  return `dans ${minutes} min (${sameDay ? clock : `${at.toLocaleDateString('fr-FR')} à ${clock}`})`
}

/** Étape 508 (Léo : « oui tout ») : les rappels à venir, numérotés dans l'ordre où ils sonneront. */
export async function listReminders(now: number = Date.now()): Promise<string> {
  const reminders = (await readReminders()).sort((a, b) => a.fireAt.localeCompare(b.fireAt))
  if (!reminders.length) return 'Aucun rappel programmé.'
  return reminders.map((r, i) => `${i + 1}. ${r.message} — ${whenText(r.fireAt, now)}`).join('\n')
}

/**
 * Étape 508 : annule un rappel, désigné par son numéro dans listReminders ou par des mots de son message. Plusieurs
 * rappels correspondent : rien n'est annulé, la liste revient au modèle pour qu'il demande lequel.
 */
export async function cancelReminder(which: string, now: number = Date.now()): Promise<string> {
  const wanted = which.trim()
  if (!wanted) return 'Dis quel rappel annuler (son numéro ou quelques mots de son message).'
  return exclusive(async () => {
    const reminders = (await readReminders()).sort((a, b) => a.fireAt.localeCompare(b.fireAt))
    if (!reminders.length) return 'Aucun rappel programmé.'
    const index = /^\d+$/.test(wanted) ? Number(wanted) - 1 : -1
    const words = plain(wanted).split(' ').filter((w) => w.length >= 2)
    const matches =
      index >= 0 && index < reminders.length
        ? [reminders[index]]
        : reminders.filter((r) => words.length > 0 && words.every((w) => plain(r.message).includes(w)))
    if (!matches.length) return `Aucun rappel ne correspond à « ${wanted} ». Rappels programmés :\n` + reminders.map((r, i) => `${i + 1}. ${r.message} — ${whenText(r.fireAt, now)}`).join('\n')
    if (matches.length > 1) return `Plusieurs rappels correspondent, lequel annuler ?\n` + matches.map((r) => `${reminders.indexOf(r) + 1}. ${r.message} — ${whenText(r.fireAt, now)}`).join('\n')
    const target = matches[0]
    await writeReminders(reminders.filter((r) => r.id !== target.id))
    const timer = timers.get(target.id)
    if (timer) clearTimeout(timer)
    timers.delete(target.id)
    return `Rappel annulé : ${target.message}.`
  })
}

/** À appeler au démarrage : réarme les rappels persistés (ceux déjà en retard se déclenchent immédiatement). */
export async function restoreReminders(onFire: ReminderFireHandler): Promise<void> {
  let reminders: Reminder[]
  try {
    reminders = await readReminders()
  } catch (err) {
    // Liste illisible pour l'instant : rien n'est réécrit, les rappels restent sur le disque pour le prochain lancement.
    console.error('[jaris] Rappels non réarmés :', err)
    return
  }
  reminders.forEach((reminder) => arm(reminder, onFire))
}
