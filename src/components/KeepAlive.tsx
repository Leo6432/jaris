import { useState } from 'react'
import { ScreenActiveContext } from '@/lib/shellContext'

/**
 * Étape 202 (Léo : « si je fais un prompt à Code, je pars dans Chat ou Vocal et je reviens dans Code, c'est
 * vide et ça travaille encore sur mon processeur »). Un écran rendu seulement quand son onglet est actif est
 * DÉTRUIT dès qu'on change d'onglet — avec son état (génération en cours, avancement, résultat) —, alors que
 * le travail continue dans le main process. Au retour, un écran neuf ne savait plus rien, et la réponse finale
 * arrivait sur un écran qui n'existait plus.
 *
 * Ici l'écran est monté à sa première ouverture (rien n'est chargé pour un onglet jamais visité), puis
 * seulement CACHÉ quand on en sort. `display: contents` quand il est visible : l'enveloppe ne change rien à la
 * mise en page existante.
 *
 * Refonte « design sobre » : l'état actif est aussi transmis par contexte, pour que seul l'écran affiché
 * remplisse la section « Récents » de la barre latérale (voir shellContext.ts, Workspace.tsx).
 */
export default function KeepAlive({ active, children }: { active: boolean; children: React.ReactNode }): JSX.Element | null {
  const [visited, setVisited] = useState(active)
  if (active && !visited) setVisited(true)
  if (!visited && !active) return null
  return (
    <div className="keep-alive" style={{ display: active ? 'contents' : 'none' }} aria-hidden={!active}>
      <ScreenActiveContext.Provider value={active}>{children}</ScreenActiveContext.Provider>
    </div>
  )
}
