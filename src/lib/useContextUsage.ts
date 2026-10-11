import { useEffect, useRef, useState } from 'react'
import type { ContextUsage, ContextUsageScope } from '../../shared/ipc'

/** Ce que montre le compteur : l'utilisé (`null` tant qu'aucune réponse ne l'a mesuré) et le maximum. */
export interface ContextGaugeValue {
  scope: ContextUsageScope
  used: number | null
  max: number
}

/**
 * Étape 299 : la dernière place occupée dans la mémoire du modèle pour cet écran (Chat ou Code), envoyée par le
 * processus principal après chaque réponse. Effacée quand on passe à une AUTRE conversation : le chiffre décrit
 * celle d'avant. Pas quand une nouvelle application reçoit son nom à la fin de sa création (rien → nom) : c'est la
 * même conversation, et le chiffre vient justement d'elle.
 *
 * Étape 300 (Léo : « je vois pas le contexte, c'est où ? ») : avant toute mesure, le compteur montre déjà le maximum
 * connu d'avance (« — / 32k ») au lieu de rester invisible — une conversation reprise, ou une réponse directe sans
 * le modèle (« salut »), ne le faisait jamais apparaître. L'utilisé, lui, n'est jamais inventé.
 */
export function useContextUsage(scope: ContextUsageScope, conversationKey: string | null): ContextGaugeValue | null {
  const [usage, setUsage] = useState<ContextUsage | null>(null)
  const [known, setKnown] = useState<number | null>(null)
  const previousKey = useRef(conversationKey)

  useEffect(() => window.jaris.onContextUsage((next) => {
    if (next.scope === scope) setUsage(next)
  }), [scope])

  useEffect(() => {
    const before = previousKey.current
    previousKey.current = conversationKey
    if (before !== null && before !== conversationKey) setUsage(null)
  }, [conversationKey])

  // Relu à chaque conversation ouverte : le réglage a pu changer entre-temps dans Options.
  useEffect(() => {
    let cancelled = false
    void window.jaris.getContextWindow(scope).then(
      (max) => {
        if (!cancelled) setKnown(max)
      },
      () => {}
    )
    return () => {
      cancelled = true
    }
  }, [scope, conversationKey])

  if (usage) return { scope, used: usage.used, max: usage.max }
  return known !== null && known > 0 ? { scope, used: null, max: known } : null
}
