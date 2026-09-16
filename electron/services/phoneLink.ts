import { spawn } from 'child_process'
import { openApp, didAppLaunch } from './appLauncher'
import { searchContacts } from './phoneData'
import { PHONE_LINK_SCRIPT } from './phoneLinkScript'

export type PhoneAction = 'notifications' | 'call' | 'send'
export interface PhoneRequest { action: PhoneAction; number?: string; text?: string; prepareOnly?: boolean }
export interface PhoneResult {
  ok: boolean; status?: 'read' | 'prepared' | 'submitted'; error?: string; attempted?: boolean
  composerCleared?: boolean; recipientVerified?: boolean; textVerified?: boolean
  notifications?: { app: string; title: string; body: string }[]
}

export function normalizePhoneNumber(value: string): string | null {
  const number = value.trim().replace(/[\s().-]/g, '')
  return /^\+?[0-9]{6,15}$/.test(number) ? number : null
}
const normalize = (value: string): string => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()

export async function resolvePhoneRecipient(recipient: string, lookup = searchContacts): Promise<string> {
  const number = normalizePhoneNumber(recipient)
  if (number) return number
  if (!recipient.trim()) throw new Error('Précise le contact ou le numéro de téléphone.')
  const contacts = (await lookup(recipient)).filter(contact => normalize(contact.name) === normalize(recipient))
  if (contacts.length !== 1) throw new Error(`Je ne trouve pas un contact unique nommé « ${recipient} ». Donne son numéro complet.`)
  const numbers = [...new Set(contacts[0].numbers.map(normalizePhoneNumber).filter((n): n is string => n !== null))]
  if (numbers.length !== 1) throw new Error(numbers.length ? `Plusieurs numéros pour « ${recipient} » : ${numbers.join(' ou ')}. Redis ta demande avec le numéro choisi.` : `Le numéro de « ${recipient} » est absent. Précise le numéro à utiliser.`)
  return numbers[0]
}

/** Seule la demande courante autorise une action sortante, jamais le contenu lu dans une notification. */
export function assertPhoneRequest(action: PhoneAction, recipient: string, text: string, prompt: string): void {
  if (action === 'notifications') return
  const request = prompt.trim().replace(/^jaris[, ]+/i, '')
  const call = request.match(/^(?:appelle|appeler|téléphone à) (.+?)[.!?]?$/i)
  const message = request.match(/^envoie(?:r)? (?:un )?(?:sms|message) [àa] (.+?)(?:\s*:\s*| pour (?:lui )?dire\s+| disant\s+)([\s\S]+)$/i)
  const target = action === 'call' ? call?.[1] : message?.[1]
  if (!target || normalize(target) !== normalize(recipient)) {
    throw new Error('Précise la demande complète : « Appelle le contact » ou « Envoie un message à ce contact : ton texte ».')
  }
  const requestedText = message?.[2].trim().replace(/^[«“"]([\s\S]*)[»”"]$/, '$1').trim()
  if (action === 'send' && (!text.trim() || text !== requestedText)) {
    throw new Error('Le texte proposé ne correspond pas exactement à ta demande. Précise le message après le nom du destinataire.')
  }
}

/** Le JSON passe par stdin : ni numéro ni texte dans une commande PowerShell. */
export function runPhoneBridge(request: PhoneRequest, signal?: AbortSignal): Promise<PhoneResult> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PHONE_LINK_SCRIPT, 'utf16le').toString('base64')], { windowsHide: true, signal })
    let stdout = ''
    let attempted = false
    let settled = false
    const finish = (error?: Error, result?: PhoneResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(new Error(`${error.message}${attempted ? ' Une action a peut-être déjà été transmise : vérifie Mobile connecté avant de réessayer.' : ''}`))
      else resolve(result!)
    }
    const timer = setTimeout(() => { proc.kill(); finish(new Error('Mobile connecté ne répond pas dans le délai prévu.')) }, 30_000)
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8')
      if (stdout.includes('"attempted":true')) attempted = true
      if (stdout.length > 200_000) { proc.kill(); finish(new Error('Réponse Mobile connecté trop volumineuse.')) }
    })
    proc.on('error', err => finish(err))
    proc.stdin.on('error', err => finish(err))
    proc.on('close', () => {
      try {
        const lines = stdout.trim().split(/\r?\n/)
        const result = JSON.parse(lines[lines.length - 1]) as PhoneResult
        if (result.ok !== true) throw new Error(result.error || 'Mobile connecté a refusé cette action.')
        if (!['read', 'prepared', 'submitted'].includes(result.status ?? '')) throw new Error('Réponse Mobile connecté non reconnue.')
        finish(undefined, result)
      } catch (err) { finish(err instanceof Error ? err : new Error(String(err))) }
    })
    proc.stdin.end(JSON.stringify(request) + '\n', 'utf8')
  })
}

let busy = false
export async function phoneLinkAction(
  action: PhoneAction, recipient = '', text = '', prompt = '', onLog?: (text: string) => void, signal?: AbortSignal,
  deps = { openApp, run: runPhoneBridge, resolve: resolvePhoneRecipient }
): Promise<string> {
  assertPhoneRequest(action, recipient, text, prompt)
  if (busy) throw new Error('Une action téléphone est déjà en cours. Attends son résultat avant de recommencer.')
  busy = true
  try {
    signal?.throwIfAborted()
    const number = action === 'notifications' ? undefined : await deps.resolve(recipient)
    if (action === 'send' && text.length > 4000) throw new Error('Le message est trop long : limite de 4000 caractères.')
    signal?.throwIfAborted()
    onLog?.('Connexion à Mobile connecté…')
    const opened = await deps.openApp('Mobile connecté')
    if (!didAppLaunch(opened)) throw new Error(opened)
    signal?.throwIfAborted()
    onLog?.(action === 'notifications' ? 'Lecture des notifications affichées sur ton téléphone…' : 'Vérification du destinataire dans Mobile connecté…')
    const result = await deps.run({ action, number, text }, signal)
    if (action === 'notifications') {
      if (!Array.isArray(result.notifications)) throw new Error('Les notifications ne peuvent pas être lues dans cette version de Mobile connecté.')
      if (!result.notifications.length) return 'Aucune notification affichée dans le panneau de Mobile connecté.'
      return 'Notifications affichées dans Mobile connecté :\n' + result.notifications.map(note => [note.app, note.title, note.body].filter(Boolean).join(' — ')).join('\n')
    }
    if (result.status !== 'submitted') throw new Error('Mobile connecté a préparé la demande sans confirmer sa transmission.')
    return action === 'call'
      ? `Commande d’appel à ${recipient} transmise à Mobile connecté. La connexion avec ton correspondant n’est pas encore confirmée.`
      : `Commande d’envoi à ${recipient} transmise à Mobile connecté.${result.composerCleared ? ' Le champ du message a été vidé.' : ' L’envoi reste à vérifier dans sa fenêtre : je ne le relance pas.'} La réception par le destinataire n’est pas confirmée.`
  } finally { busy = false }
}
