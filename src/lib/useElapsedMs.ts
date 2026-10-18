import { useEffect, useState } from 'react'

/**
 * Étape 325 : le temps écoulé depuis que `running` est devenu vrai, mis à jour chaque seconde ; 0 quand il est faux.
 * Repart de zéro à chaque nouveau départ (une nouvelle réponse), et s'arrête dès que `running` redevient faux
 * (réponse, erreur, arrêt). Le Chat et son widget l'affichent à côté de « Jaris réfléchit… », comme le mode Code
 * (étape 291) et l'écran vocal (étape 252) : un modèle qui se charge ou réfléchit deux minutes ne paraît plus figé.
 */
export function useElapsedMs(running: boolean): number {
  const [elapsedMs, setElapsedMs] = useState(0)
  useEffect(() => {
    setElapsedMs(0)
    if (!running) return
    const startedAt = Date.now()
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000)
    return () => clearInterval(timer)
  }, [running])
  return running ? elapsedMs : 0
}
