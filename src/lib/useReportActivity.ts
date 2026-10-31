import { useEffect } from 'react'
import { useJarisStore, type ActivityState } from '@/store/useJarisStore'

/**
 * Étape 392 : un écran dit ce qu'il fait (réfléchit, répond, ou rien), pour que les orbes de Jaris prennent la
 * même couleur que sur le téléphone. Effacé quand l'écran est démonté, pour ne jamais laisser une orbe orange.
 */
export function useReportActivity(source: string, state: ActivityState | null): void {
  const setActivity = useJarisStore((s) => s.setActivity)
  useEffect(() => {
    setActivity(source, state)
  }, [setActivity, source, state])
  useEffect(() => () => setActivity(source, null), [setActivity, source])
}
