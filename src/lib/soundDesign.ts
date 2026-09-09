import type { SoundCue } from '../../shared/ipc'

/**
 * Design sonore de Jaris (étape 31) : des bips courts et distincts façon J.A.R.V.I.S. (Iron Man), un par
 * type d'action (écoute/réflexion/succès/échec/clic/scan). Synthétisés à la volée avec le Web Audio API,
 * jamais de vrai fichier audio à embarquer : reste 100% local, léger, et sans aucun asset à maintenir.
 */

let ctx: AudioContext | null = null

function getContext(): AudioContext | null {
  if (typeof window === 'undefined' || typeof window.AudioContext === 'undefined') return null
  if (!ctx) ctx = new AudioContext()
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

/** Volume de base volontairement discret : un signe de vie, jamais une alarme qui surprend. */
const MASTER_GAIN = 0.05

interface Tone {
  freq: number
  /** Décalage en secondes après le début du cue. */
  start: number
  duration: number
  type?: OscillatorType
  gain?: number
  /** Fréquence finale pour un balayage (son "scan") au lieu d'un ton fixe. */
  sweepTo?: number
}

function playTone(context: AudioContext, { freq, start, duration, type = 'sine', gain = MASTER_GAIN, sweepTo }: Tone): void {
  const osc = context.createOscillator()
  const gainNode = context.createGain()
  osc.type = type
  const t0 = context.currentTime + start
  osc.frequency.setValueAtTime(freq, t0)
  if (sweepTo !== undefined) osc.frequency.linearRampToValueAtTime(sweepTo, t0 + duration)

  // Enveloppe courte (attaque/chute rapides) : évite un clic audible au démarrage/arrêt de l'oscillateur.
  gainNode.gain.setValueAtTime(0, t0)
  gainNode.gain.linearRampToValueAtTime(gain, t0 + 0.008)
  gainNode.gain.linearRampToValueAtTime(0, t0 + duration)

  osc.connect(gainNode)
  gainNode.connect(context.destination)
  osc.start(t0)
  osc.stop(t0 + duration + 0.02)
}

const SEQUENCES: Record<SoundCue, Tone[]> = {
  // Deux notes montantes, comme une oreille qui se tend.
  listening: [
    { freq: 660, start: 0, duration: 0.07 },
    { freq: 990, start: 0.08, duration: 0.09 }
  ],
  // Un seul ton bref et discret : trop fréquent pour être plus présent sans devenir fatiguant.
  thinking: [{ freq: 520, start: 0, duration: 0.05, gain: MASTER_GAIN * 0.6 }],
  // Deux notes montantes plus franches, comme un carillon de réussite.
  success: [
    { freq: 880, start: 0, duration: 0.08 },
    { freq: 1320, start: 0.09, duration: 0.14 }
  ],
  // Deux notes descendantes en onde carrée, plus rêche : signale clairement un problème sans être alarmant.
  error: [
    { freq: 380, start: 0, duration: 0.12, type: 'square', gain: MASTER_GAIN * 0.8 },
    { freq: 260, start: 0.13, duration: 0.16, type: 'square', gain: MASTER_GAIN * 0.8 }
  ],
  // Un "tick" très court et sec, comme un vrai clic mécanique.
  click: [{ freq: 1400, start: 0, duration: 0.02, type: 'square', gain: MASTER_GAIN * 0.5 }],
  // Un balayage de fréquence montant, façon scanner de science-fiction.
  scan: [{ freq: 300, start: 0, duration: 0.18, type: 'sine', sweepTo: 1100 }],
  // Deux notes courtes et nettes, façon "whoosh" d'un message qui part (iMessage/Slack) : plus vif que
  // "success", pour ne pas confondre "envoyé" avec "réponse reçue".
  send: [
    { freq: 700, start: 0, duration: 0.05 },
    { freq: 1050, start: 0.05, duration: 0.06 }
  ]
}

export function playSoundCue(cue: SoundCue): void {
  const context = getContext()
  if (!context) return
  for (const tone of SEQUENCES[cue]) playTone(context, tone)
}

/**
 * Comme playSoundCue, mais relit le profil pour respecter la case "Bips d'interface" désactivable dans
 * Options → Voix (soundEffectsEnabled) — utilisé par tout renderer qui joue un cue directement (App.tsx pour
 * les cues broadcastés par main.ts, ChatPanel.tsx pour le son "send" joué localement au clic sur Envoyer/
 * Entrée, sans passer par l'IPC main -> renderer).
 */
export async function playSoundCueIfEnabled(cue: SoundCue): Promise<void> {
  try {
    const profile = await window.jaris.getProfile()
    if (profile?.soundEffectsEnabled === false) return
  } catch {
    // Profil illisible : un simple bip d'interface ne vaut pas la peine de bloquer dessus, on le joue quand même.
  }
  playSoundCue(cue)
}
