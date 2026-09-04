export type RiskLevel = 'N1' | 'N2' | 'N3'

/**
 * Niveau de risque de chaque outil (même principe que les niveaux N1/N2/N3 vus sur des projets
 * comparables : jarvis-assistant-vocal notamment) :
 * - N1 (sûr) : exécuté directement, jamais de confirmation.
 * - N2 (sensible) : confirmation orale/écrite avant exécution ("tu confirmes : ... ?"), sauf si l'outil
 *   est dans `alwaysAllowedTools` du profil (Options → Sécurité, révocable à tout moment).
 * - N3 (critique) : confirmation à CHAQUE fois, jamais de "toujours autoriser" possible (voir
 *   needsConfirmation ci-dessous, qui ignore alwaysAllowedTools pour ce niveau).
 *
 * type_text/press_key/click_mouse restent volontairement N1 malgré le prompt système qui les décrit
 * lui-même comme "réelles et irréversibles" : c'est un comportement existant, déjà accepté, pas dans le
 * périmètre de ce garde-fou (qui cible les actions ajoutées/identifiées comme un vrai trou : envoi de mail
 * sans confirmation, futur contrôle machine plus lourd type extinction). click_browser_element/
 * fill_browser_field suivent le même précédent que click_mouse/type_text (même nature d'action, juste
 * ciblée par description au lieu de coordonnées écran) : garder une confirmation à chaque clic/champ
 * rendrait la navigation assistée impraticable, la prudence "achat/paiement" reste au niveau du prompt
 * système (assistant.ts), pas d'un blocage systématique ici.
 */
export const TOOL_RISK: Record<string, RiskLevel> = {
  open_app: 'N1',
  set_reminder: 'N1',
  look_at_screen: 'N1',
  search_web: 'N1',
  remember: 'N1',
  recall_memory: 'N1',
  type_text: 'N1',
  press_key: 'N1',
  click_mouse: 'N1',
  get_system_stats: 'N1',
  media_control: 'N1',
  read_browser_tab: 'N1',
  open_browser_url: 'N1',
  click_browser_element: 'N1',
  fill_browser_field: 'N1',
  screenshot_browser_tab: 'N1',
  send_email: 'N2',
  shutdown_pc: 'N3'
}

/** Nom lisible de chaque outil N2, pour Options → Sécurité (voir getConfirmableTools ci-dessous). */
const TOOL_LABELS: Record<string, string> = {
  send_email: 'Envoyer un mail'
}

/** Outils N2 proposables en "toujours autoriser" dans Options → Sécurité (jamais les N3, voir plus haut). */
export function getConfirmableTools(): { name: string; label: string }[] {
  return Object.entries(TOOL_RISK)
    .filter(([, level]) => level === 'N2')
    .map(([name]) => ({ name, label: TOOL_LABELS[name] ?? name }))
}

/** Un outil non répertorié (ex: ajouté sans y penser) reste prudent par défaut : jamais N1 implicite. */
function riskOf(toolName: string): RiskLevel {
  return TOOL_RISK[toolName] ?? 'N2'
}

export function needsConfirmation(toolName: string, alwaysAllowedTools: string[]): boolean {
  const level = riskOf(toolName)
  if (level === 'N1') return false
  if (level === 'N3') return true
  return !alwaysAllowedTools.includes(toolName)
}

/** Description humaine de l'action, pour la question de confirmation posée à l'utilisateur. */
export function describeToolCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'send_email':
      return `envoyer un mail à ${String(args.to ?? '?')} avec pour objet "${String(args.subject ?? '')}"`
    case 'shutdown_pc':
      return args.restart ? 'redémarrer cet ordinateur' : 'éteindre cet ordinateur'
    default:
      return `${name}(${JSON.stringify(args)})`
  }
}

export interface PendingConfirmation {
  name: string
  args: Record<string, unknown>
  description: string
  setAt: number
}

/**
 * Au-delà de ce délai sans réponse, une confirmation en attente est considérée abandonnée (l'utilisateur
 * est reparti sans répondre) : sans ça, une phrase totalement sans rapport dite bien plus tard serait
 * interprétée à tort comme une réponse oui/non à une action que l'utilisateur a en réalité oubliée.
 */
const PENDING_CONFIRMATION_TIMEOUT_MS = 2 * 60_000

/**
 * État module-level (pas par appel de converse()) : un seul Jaris, un seul utilisateur, donc une seule
 * confirmation "en attente" possible à la fois — le mode voix ET le mode chat (même fonction converse(),
 * juste un `channel` différent) doivent voir/résoudre la même confirmation, qu'elle ait été posée par
 * l'un ou l'autre canal.
 */
let pending: PendingConfirmation | null = null

export function setPendingConfirmation(name: string, args: Record<string, unknown>, description: string): void {
  pending = { name, args, description, setAt: Date.now() }
}

/** `null` si aucune confirmation en attente, ou si elle a expiré (voir PENDING_CONFIRMATION_TIMEOUT_MS). */
export function getPendingConfirmation(): PendingConfirmation | null {
  if (pending && Date.now() - pending.setAt > PENDING_CONFIRMATION_TIMEOUT_MS) pending = null
  return pending
}

export function clearPendingConfirmation(): void {
  pending = null
}

const YES_WORDS = ["c'est bon", 'daccord', "d'accord", 'confirme', 'confirmé', 'fais-le', 'fais le', 'ok', 'okay', 'oui', 'vas-y', 'vasy', 'yes']
const NO_WORDS = ['abandonne', 'annule', 'laisse tomber', 'non', 'pas la peine', 'stop', 'no']

/**
 * `true`/`false`/`null` (ni oui ni non net) — comparé sur la phrase entière normalisée plutôt qu'un simple
 * `includes` : "envoie plutôt un message" ne doit pas être pris pour un "oui" juste parce qu'il ne contient
 * aucun mot de la liste NO_WORDS.
 */
export function interpretYesNo(text: string): boolean | null {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, '')
  if (!normalized) return null
  const startsWithWord = (word: string): boolean => normalized === word || normalized.startsWith(`${word} `) || normalized.startsWith(`${word},`)
  if (YES_WORDS.some(startsWithWord)) return true
  if (NO_WORDS.some(startsWithWord)) return false
  return null
}
