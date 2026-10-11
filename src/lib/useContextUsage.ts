import { useEffect, useRef, useState } from 'react'
import type { ContextUsage, ContextUsageScope } from '../../shared/ipc'

/**
 * Étape 299 : la dernière place occupée dans la mémoire du modèle pour cet écran (Chat ou Code), envoyée par le
 * processus principal après chaque réponse. Effacée quand on passe à une AUTRE conversation : le chiffre décrit
 * celle d'avant. Pas quand une nouvelle application reçoit son nom à la fin de sa création (rien → nom) : c'est la
 * même conversation, et le chiffre vient justement d'elle.
 */
export function useContextUsage(scope: ContextUsageScope, conversationKey: string | null): ContextUsage | null {
  const [usage, setUsage] = useState<ContextUsage | null>(null)
  const previousKey = useRef(conversationKey)

  useEffect(() => window.jaris.onContextUsage((next) => {
    if (next.scope === scope) setUsage(next)
  }), [scope])

  useEffect(() => {
    const before = previousKey.current
    previousKey.current = conversationKey
    if (before !== null && before !== conversationKey) setUsage(null)
  }, [conversationKey])

  return usage
}
