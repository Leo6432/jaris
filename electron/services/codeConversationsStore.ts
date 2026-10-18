import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import {
  CODE_CONVERSATIONS_ASIDE_DIR,
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
 * Délais entre deux essais quand Windows refuse un instant l'accès au fichier (antivirus ou indexeur qui l'ouvre juste
 * après une écriture) : au plus ~350 ms d'attente, et seulement quand ça échoue.
 */
const RETRY_DELAYS_MS = [50, 100, 200]
/** Les refus passagers d'un renommage sous Windows (fichier tenu ouvert un instant par un autre programme). */
const TRANSIENT_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** Attente SYNCHRONE (le processus principal répond à une lecture synchrone de l'écran) : courte, et rare. */
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Le fichier existe mais n'a pas pu être lu : rien ne doit l'écraser, on réessaiera au prochain accès. */
export class CodeConversationsUnreadableError extends Error {
  constructor(cause: unknown) {
    super(`Conversations du mode Code non lues : le fichier existant n’a pas pu être ouvert (${String((cause as Error)?.message ?? cause)}).`)
    this.name = 'CodeConversationsUnreadableError'
  }
}

/**
 * Où mettre de côté un fichier abîmé : `code-conversations-illisibles/code-conversations-2026-10-17T09-30-00-000Z.json`,
 * à côté du vrai. Daté, pour qu'un second incident n'écrase jamais le premier ; dans un dossier au nom fixe, pour
 * pouvoir suivre les données lors d'un « Déplacer » (voir CODE_CONVERSATIONS_ASIDE_DIR).
 */
export function asidePathFor(filePath: string, now: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  return join(dirname(filePath), CODE_CONVERSATIONS_ASIDE_DIR, `code-conversations-${stamp}.json`)
}

interface StoreOptions {
  now?: () => number
  /** Remplacé par les tests, pour ne pas attendre pour de vrai. */
  sleep?: (ms: number) => void
}

/**
 * Les conversations du mode Code, gardées par le processus principal dans un fichier du dossier de données (voir
 * shared/codeConversations.ts). Lu UNE fois (puis gardé en mémoire), écrit à chaque changement envoyé par l'écran.
 *
 * Règles, pour ne jamais perdre ce qui est déjà sur le disque :
 * - écriture atomique : le contenu part d'abord dans un fichier temporaire, forcé sur le disque, puis REMPLACE
 *   l'ancien d'un seul geste — une coupure de courant en pleine écriture laisse l'ancienne version intacte ;
 *   un remplacement refusé un instant par Windows est réessayé, et une écriture ratée est retentée à la fermeture ;
 * - un fichier illisible n'est jamais écrasé par une liste vide : abîmé, il est mis de côté sous un autre nom ;
 *   inaccessible (verrouillé par un antivirus…), la lecture est réessayée, puis plus rien n'est écrit tant qu'il
 *   n'a pas pu être lu — et rien n'est gardé en mémoire à sa place, pour le relire au prochain accès.
 */
export class CodeConversationsStore {
  private data: CodeConversationsData | null = null
  /** La dernière écriture a échoué : la copie en mémoire est plus récente que le fichier (voir flush()). */
  private dirty = false
  /** « Déplacer » en cours (voir holdWrites) : les changements restent en mémoire, rien n'est écrit. */
  private held = false
  private readonly now: () => number
  private readonly sleep: (ms: number) => void

  constructor(
    private filePath: string,
    options: StoreOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? sleepSync
  }

  /**
   * Une copie : l'appelant ne modifie jamais l'état gardé en mémoire. `null` si le fichier existe mais n'a pas pu être
   * lu — l'écran sait alors qu'il ne doit rien y écrire (une liste vide l'écraserait).
   */
  load(): CodeConversationsData | null {
    let data: CodeConversationsData
    try {
      data = this.current()
    } catch (err) {
      if (err instanceof CodeConversationsUnreadableError) return null
      throw err
    }
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
   * l'écriture échoue (ou si le fichier existant n'a pas pu être lu) — l'écran garde alors son ancien stockage.
   */
  importLegacy(extra: unknown): void {
    // L'écran efface l'ancien stockage dès que cette reprise répond : elle doit être SUR le disque, jamais seulement
    // gardée en mémoire le temps d'un déplacement. Refusée : l'écran la retentera plus tard, rien n'est perdu.
    if (this.held) throw new Error('Anciennes conversations du mode Code non reprises : un déplacement des données est en cours.')
    const legacy = sanitizeCodeConversations(extra)
    if (!legacy) throw new Error('Anciennes conversations du mode Code refusées : forme inattendue.')
    this.save(mergeCodeConversations(this.current(), legacy))
  }

  /**
   * À la fermeture de Jaris : réécrit la copie en mémoire si la dernière écriture avait échoué (renommage refusé un
   * instant par Windows…). Sans ça, le tout dernier changement de la session ne serait jamais arrivé sur le disque.
   */
  flush(): void {
    if (!this.dirty || !this.data) return
    this.write(this.data)
    this.dirty = false
  }

  /**
   * « Déplacer » (Options) : pendant la copie — souvent des dizaines de minutes — l'écran du mode Code reste utilisable.
   * Écrit dans l'ancien dossier, un changement serait perdu : déjà copié (ou sur le point de l'être), ce dossier est
   * effacé à la fin. Les changements restent donc en mémoire (l'écran les affiche normalement) jusqu'à releaseWrites.
   */
  holdWrites(): void {
    this.held = true
  }

  /**
   * Fin du déplacement. `movedTo` : le fichier dans le NOUVEAU dossier (déplacement réussi) — ce qui a été gardé en
   * mémoire y est écrit, et les écritures suivantes y vont. Sans : déplacement annulé, tout repart dans le fichier
   * d'origine, resté intact. Une écriture qui échoue ici est retentée à la fermeture (flush), au bon endroit.
   */
  releaseWrites(movedTo?: string): void {
    this.held = false
    if (movedTo) this.filePath = movedTo
    this.flush()
  }

  private current(): CodeConversationsData {
    if (this.data) return this.data
    const raw = this.readWithRetries()
    if (raw === null) {
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
      mkdirSync(dirname(aside), { recursive: true })
      renameSync(this.filePath, aside)
      console.error(`[code] Conversations du mode Code abîmées, mises de côté dans ${aside}`)
    } catch (err) {
      // Ni lisible ni déplaçable : on n'écrit rien, et on réessaiera au prochain accès.
      throw new CodeConversationsUnreadableError(err)
    }
    this.data = empty()
    return this.data
  }

  /** Le contenu du fichier, `null` s'il n'existe pas encore. Un refus passager est réessayé avant d'abandonner. */
  private readWithRetries(): string | null {
    for (let attempt = 0; ; attempt++) {
      try {
        return readFileSync(this.filePath, 'utf-8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        if (attempt >= RETRY_DELAYS_MS.length) {
          console.error('[code] Conversations du mode Code illisibles pour l’instant, rien ne sera écrit :', err)
          throw new CodeConversationsUnreadableError(err)
        }
        this.sleep(RETRY_DELAYS_MS[attempt])
      }
    }
  }

  private save(next: CodeConversationsData): void {
    // Gardé en mémoire même si l'écriture échoue : un rechargement de l'écran retrouve la session en cours, la
    // prochaine écriture (le fichier entier) l'emporte avec elle, et flush() la retente à la fermeture.
    this.data = next
    this.dirty = true
    if (this.held) return
    this.write(next)
    this.dirty = false
  }

  private write(next: CodeConversationsData): void {
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
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(temporary, this.filePath)
        return
      } catch (err) {
        if (!TRANSIENT_RENAME.has((err as NodeJS.ErrnoException).code ?? '') || attempt >= RETRY_DELAYS_MS.length) throw err
        this.sleep(RETRY_DELAYS_MS[attempt])
      }
    }
  }
}
