import { useState } from 'react'

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
 */
export default function KeepAlive({ active, children }: { active: boolean; children: React.ReactNode }): JSX.Element | null {
  const [visited, setVisited] = useState(active)
  if (active && !visited) setVisited(true)
  if (!visited && !active) return null
  return (
    <div className="keep-alive" style={{ display: active ? 'contents' : 'none' }} aria-hidden={!active}>
      {children}
    </div>
  )
}
