/**
 * Étape 257 — duel vidéo, outil de développement (Léo : « fais-moi un petit bouton sur Jaris développeur pour que je
 * teste chez moi avec 3 prompts pour les 2 modèles, et ça enregistre la vitesse et le rendu, c'est moi qui choisis »).
 * FastWan 2.2 5B (le modèle de Jaris) contre Kandinsky 6.0 Video Lite distillé, sur SA machine : les classements en
 * ligne ne comparent pas ces deux modèles, et un jugement de rendu ne se laisse pas deviner par des chiffres (leçon
 * Kandinsky/Supertonic de l'étape 75).
 *
 * Le jugement est fait À L'AVEUGLE : les deux vidéos d'une description sont montrées « A » et « B » dans un ordre tiré
 * au hasard, le nom du modèle et son temps n'apparaissent qu'après le choix — sinon la vitesse (FastWan est bien plus
 * rapide) et le nom influencent le regard. Module pur, partagé par le processus principal et l'écran.
 */

export type DuelPromptId = 'humain' | 'paysage' | 'chat'
export type DuelModel = 'fastwan' | 'kandinsky'
/** `egalite` : « je ne vois pas de différence ». */
export type DuelChoice = DuelModel | 'egalite'

export interface DuelPrompt {
  id: DuelPromptId
  label: string
  /** En français, comme Léo l'écrirait dans Jaris : c'est ce que les deux modèles reçoivent tels quels. */
  prompt: string
}

export const DUEL_PROMPTS: readonly DuelPrompt[] = [
  {
    id: 'humain',
    label: 'Un humain',
    prompt: 'Une femme qui marche dans une rue de Paris en souriant, ses cheveux bougent avec le vent, lumière douce du soir, vidéo réaliste'
  },
  {
    id: 'paysage',
    label: 'Un paysage',
    prompt: 'Un paysage de montagne au lever du soleil, un lac calme au premier plan, des nuages qui passent lentement au-dessus des sommets, vidéo réaliste'
  },
  { id: 'chat', label: 'Un chat', prompt: 'Un chat roux qui joue avec une pelote de laine sur un tapis dans un salon, vidéo réaliste' }
]

/** Même durée (la durée par défaut du mode Vidéo), même taille, même graine pour les deux modèles. */
export const DUEL_SECONDS = 2
export const DUEL_SEED = 42

export const DUEL_MODEL_LABELS: Record<DuelModel, string> = {
  fastwan: 'FastWan 2.2 5B (actuel)',
  kandinsky: 'Kandinsky 6 Lite (avec le son)'
}

export interface DuelVideoResult {
  prompt: DuelPromptId
  model: DuelModel
  file: string
  /** Temps de la vidéo, de la demande au fichier écrit (chargement du modèle compris pour FastWan, comme dans Jaris). */
  seconds: number
}

export interface VideoDuelResults {
  /** ISO 8601. */
  date: string
  machine: string
  fastwanQuality: string
  kandinsky: {
    /** Lecture des 3 descriptions par son lecteur (Qwen2.5-VL 7B, sur le processeur), une fois pour toutes. */
    encodeSeconds: number | null
    /** Chargement du modèle vidéo, une fois pour les 3 vidéos. */
    loadSeconds: number | null
    /** `model` = tout le modèle sur la carte ; `sequential` = couche par couche (8 Go ne suffisaient pas, plus lent). */
    offload: string | null
    peakVramGb: number | null
  }
  videos: DuelVideoResult[]
  /** Pour chaque description, quelle vidéo est montrée en « A » (tirée au hasard une fois, gardée ensuite). */
  order: Record<DuelPromptId, DuelModel>
  choices: Partial<Record<DuelPromptId, DuelChoice>>
  /** Raison lisible si le duel s'est arrêté avant la fin (les vidéos déjà faites restent). */
  error?: string
}

export interface VideoDuelStatus {
  supported: boolean
  /** Raison lisible quand le duel ne peut pas être lancé ici (pas de FastWan installé, pas Windows…). */
  blocker: string | null
  /** Environnement Python du duel ET modèle Kandinsky déjà sur le disque. */
  ready: boolean
  /** Ce qu'il reste à télécharger avant le premier lancement, ex. « environ 31 Go ». */
  downloadLabel: string
  running: boolean
  results: VideoDuelResults | null
}

/** Nom d'une vidéo du duel : le seul format qui voyage entre l'écran et le processus principal, revérifié à chaque fois. */
export function duelVideoFile(model: DuelModel, prompt: DuelPromptId): string {
  return `${model}-${prompt}.${model === 'fastwan' ? 'webm' : 'mp4'}`
}

export function isDuelVideoFile(name: unknown): name is string {
  return typeof name === 'string' && /^(?:fastwan-(?:humain|paysage|chat)\.webm|kandinsky-(?:humain|paysage|chat)\.mp4)$/.test(name)
}

export function isDuelChoice(value: unknown): value is DuelChoice {
  return value === 'fastwan' || value === 'kandinsky' || value === 'egalite'
}

export function isDuelPromptId(value: unknown): value is DuelPromptId {
  return value === 'humain' || value === 'paysage' || value === 'chat'
}

/** Tirage de l'ordre A/B, une fois par duel ; `random` injectable pour les tests. */
export function drawDuelOrder(random: () => number = Math.random): Record<DuelPromptId, DuelModel> {
  const pick = (): DuelModel => (random() < 0.5 ? 'fastwan' : 'kandinsky')
  return { humain: pick(), paysage: pick(), chat: pick() }
}

/** Les deux vidéos d'une description dans l'ordre montré (A puis B). */
export function duelPair(order: Record<DuelPromptId, DuelModel>, prompt: DuelPromptId): [DuelModel, DuelModel] {
  return order[prompt] === 'fastwan' ? ['fastwan', 'kandinsky'] : ['kandinsky', 'fastwan']
}

/** « 45 s », « 3 min 05 », « 1 h 02 ». */
export function formatDuelDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`
}

export interface DuelSummary {
  wins: Record<DuelChoice, number>
  /** Temps total des vidéos faites, par modèle (`null` si aucune). */
  totals: Record<DuelModel, number | null>
  /** Toutes les descriptions ont un choix. */
  complete: boolean
}

export function summarizeDuel(results: VideoDuelResults): DuelSummary {
  const wins: Record<DuelChoice, number> = { fastwan: 0, kandinsky: 0, egalite: 0 }
  for (const prompt of DUEL_PROMPTS) {
    const choice = results.choices[prompt.id]
    if (choice) wins[choice]++
  }
  const total = (model: DuelModel): number | null => {
    const videos = results.videos.filter((v) => v.model === model)
    return videos.length ? videos.reduce((sum, v) => sum + v.seconds, 0) : null
  }
  return { wins, totals: { fastwan: total('fastwan'), kandinsky: total('kandinsky') }, complete: DUEL_PROMPTS.every((p) => results.choices[p.id]) }
}

/** Une ligne d'évènement du script Python (python/video_duel.py), ou `null` si ce n'en est pas une. */
export type DuelPythonEvent =
  | { event: 'progress'; message: string }
  | { event: 'result'; name: DuelPromptId; file: string; seconds: number; peak_vram_gb: number | null; offload: string }
  | { event: 'error'; message: string }
  | { event: 'done'; encode_seconds: number | null; load_seconds: number | null }

export function parseDuelLine(line: string): DuelPythonEvent | null {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(line)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  switch (data.event) {
    case 'progress':
    case 'error':
      return typeof data.message === 'string' ? { event: data.event, message: data.message } : null
    case 'result':
      if (!isDuelPromptId(data.name) || typeof data.file !== 'string' || num(data.seconds) === null) return null
      return {
        event: 'result',
        name: data.name,
        file: data.file,
        seconds: num(data.seconds) as number,
        peak_vram_gb: num(data.peak_vram_gb),
        offload: typeof data.offload === 'string' ? data.offload : 'model'
      }
    case 'done':
      return { event: 'done', encode_seconds: num(data.encode_seconds), load_seconds: num(data.load_seconds) }
    default:
      return null
  }
}
