import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'

export interface Reminder {
  id: string
  message: string
  fireAt: string
}

type ReminderFireHandler = (message: string) => void

const storePath = join(app.getPath('userData'), 'reminders.json')
const timers = new Map<string, ReturnType<typeof setTimeout>>()

async function readReminders(): Promise<Reminder[]> {
  try {
    const raw = await readFile(storePath, 'utf-8')
    return JSON.parse(raw) as Reminder[]
  } catch {
    return []
  }
}

async function writeReminders(reminders: Reminder[]): Promise<void> {
  await mkdir(dirname(storePath), { recursive: true })
  await writeFile(storePath, JSON.stringify(reminders, null, 2), 'utf-8')
}

async function removeReminder(id: string): Promise<void> {
  const reminders = await readReminders()
  await writeReminders(reminders.filter((r) => r.id !== id))
}

function arm(reminder: Reminder, onFire: ReminderFireHandler): void {
  const delayMs = Math.max(0, new Date(reminder.fireAt).getTime() - Date.now())
  const timer = setTimeout(() => {
    timers.delete(reminder.id)
    void removeReminder(reminder.id)
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

  const reminders = await readReminders()
  reminders.push(reminder)
  await writeReminders(reminders)
  arm(reminder, onFire)

  return `Rappel programmé dans ${delayMinutes} minute${delayMinutes > 1 ? 's' : ''} : ${reminder.message}`
}

/** À appeler au démarrage : réarme les rappels persistés (ceux déjà en retard se déclenchent immédiatement). */
export async function restoreReminders(onFire: ReminderFireHandler): Promise<void> {
  const reminders = await readReminders()
  reminders.forEach((reminder) => arm(reminder, onFire))
}
