import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import {
  MAX_CODE_REPOS,
  MAX_CODE_TURNS,
  isCodeConversationKey,
  isCodeRepoEntry,
  mergeCodeConversations,
  sanitizeCodeConversations,
  type CodeConversationsData
} from '../../shared/codeConversations'

const empty = (): CodeConversationsData => ({ repos: [], conversations: {} })

/**
 * Où mettre de côté un fichier abîmé, à côté du vrai : `code-conversations.illisible-2026-10-17T09-30-00-000Z.json`.
 * Daté, pour qu'un second incident n'écrase jamais le premier.
 */
export function asidePathFor(filePath: string, now: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  return join(dirname(filePath), basename(filePath).replace(/\.json$/i, '') + `.illisible-${stamp}.json`)
}

/**
 * Les conversations du mode Code, gardées par le processus principal dans un fichier du dossier de données (voir
 * shared/codeConversations.ts). Lu UNE fois (puis gardé en mémoire), écrit à chaque changement envoyé par l'écran.
 *
 * Deux règles, pour ne jamais perdre ce qui est déjà sur le disque :
 * - écriture atomique : le contenu part d'abord dans un fichier temporaire, forcé sur le disque, puis REMPLACE
 *   l'ancien d'un seul geste — une coupure de courant en pleine écriture laisse l'ancienne version intacte ;
 * - un fichier illisible n'est jamais écrasé par une liste vide : abîmé, il est mis de côté sous un autre nom ;
 *   simplement inaccessible (verrouillé par un antivirus…), plus rien n'est écrit jusqu'au prochain lancement.
 */
export class CodeConversationsStore {
  private data: CodeConversationsData | null = null
  /** Le fichier existe mais n'a pu être ni lu ni mis de côté : rien ne doit l'écraser pendant cette session. */
  private readOnly = false

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now
  ) {}

  /** Une copie : l'appelant ne modifie jamais l'état gardé en mémoire. */
  load(): CodeConversationsData {
    const data = this.current()
    return { repos: [...data.repos], conversations: { ...data.conversations } }
  }

  /** `null` ou une liste vide : la conversation est retirée du fichier. */
  setConversation(key: unknown, turns: unknown): void {
    if (!isCodeConversationKey(key)) throw new Error(`Clé de conversation du mode Code refusée : ${String(key).slice(0, 80)}`)
    if (turns !== null && !Array.isArray(turns)) throw new Error('Conversation du mode Code refusée : ce n’est pas une liste de messages.')
    const data = this.current()
    const conversations = { ...data.conversations }
    if (turns === null || turns.length === 0) {
      if (!Object.prototype.hasOwnProperty.call(conversations, key)) return
      delete conversations[key]
    } else {
      conversations[key] = turns.slice(-MAX_CODE_TURNS)
    }
    this.save({ repos: data.repos, conversations })
  }

  setRepos(repos: unknown): void {
    if (!Array.isArray(repos)) throw new Error('Liste des dépôts du mode Code refusée : ce n’est pas une liste.')
    this.save({ repos: repos.filter(isCodeRepoEntry).slice(0, MAX_CODE_REPOS), conversations: this.current().conversations })
  }

  /**
   * Reprise de l'ancien stockage de la fenêtre : ajouté à ce que contient déjà le fichier, sans rien écraser. Lève si
   * l'écriture échoue — l'écran garde alors son ancien stockage, pour réessayer au lancement suivant.
   */
  importLegacy(extra: unknown): void {
    const legacy = sanitizeCodeConversations(extra)
    if (!legacy) throw new Error('Anciennes conversations du mode Code refusées : forme inattendue.')
    this.save(mergeCodeConversations(this.current(), legacy))
  }

  private current(): CodeConversationsData {
    if (this.data) return this.data
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Présent mais illisible pour l'instant : on n'écrit plus rien par-dessus, on le relira au prochain lancement.
        this.readOnly = true
        console.error('[code] Conversations du mode Code illisibles pour l’instant, rien ne sera écrit :', err)
      }
      this.data = empty()
      return this.data
    }
    let parsed: CodeConversationsData | null = null
    try {
      parsed = sanitizeCodeConversations(JSON.parse(raw))
    } catch {
      parsed = null
    }
    if (parsed) {
      this.data = parsed
      return parsed
    }
    // Abîmé : gardé à côté sous un autre nom, plutôt qu'écrasé par une liste vide au premier changement.
    const aside = asidePathFor(this.filePath, this.now())
    try {
      renameSync(this.filePath, aside)
      console.error(`[code] Conversations du mode Code abîmées, mises de côté dans ${aside}`)
    } catch (err) {
      this.readOnly = true
      console.error('[code] Conversations du mode Code abîmées, impossibles à mettre de côté : rien ne sera écrit.', err)
    }
    this.data = empty()
    return this.data
  }

  private save(next: CodeConversationsData): void {
    // Gardé en mémoire même si l'écriture échoue : un rechargement de l'écran retrouve la session en cours.
    this.data = next
    if (this.readOnly) throw new Error('Conversations du mode Code non enregistrées : le fichier existant n’a pas pu être lu.')
    mkdirSync(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    const fd = openSync(temporary, 'w')
    try {
      writeFileSync(fd, JSON.stringify({ version: 1, ...next }), 'utf-8')
      // Forcé sur le disque AVANT le remplacement : sinon, après une coupure, le renommage peut être là sans le contenu.
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, this.filePath)
  }
}
