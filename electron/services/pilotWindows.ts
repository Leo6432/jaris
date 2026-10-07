/**
 * Étape 256 — Jaris s'écarte pendant qu'il pilote l'écran. Léo parlait depuis la fenêtre de Jaris : la capture
 * montrait Jaris, et un clic visant la page derrière tombait sur Jaris. Au début d'une tâche, la grande fenêtre se
 * replie (en widget, comme quand on clique ailleurs) ; le widget, lui, reste à l'écran pour Léo mais devient
 * invisible aux captures et transparent aux clics. Il retrouve son état normal à la fin.
 *
 * Les fenêtres appartiennent à main.ts, qui fournit ces deux gestes ; computerUse.ts ne fait que les demander. Un
 * petit module à part évite que les deux fichiers s'importent l'un l'autre. Sans gestes enregistrés (tests), rien
 * ne se passe.
 */
export interface PilotWindowHooks {
  /** Écarte les fenêtres de Jaris ; résolu une fois qu'elles ont vraiment disparu de l'écran. */
  begin: () => Promise<void>
  end: () => void
}

let hooks: PilotWindowHooks | null = null

export function setPilotWindowHooks(next: PilotWindowHooks | null): void {
  hooks = next
}

/** Une tâche de pilotage, Jaris écarté le temps qu'elle dure — y compris si elle échoue ou est annulée. */
export async function withJarisSetAside<T>(task: () => Promise<T>): Promise<T> {
  const current = hooks
  try {
    await current?.begin()
  } catch {
    // Écarter Jaris aide le pilotage, ce n'est pas une condition : la tâche se fait quand même.
  }
  try {
    return await task()
  } finally {
    try {
      current?.end()
    } catch {
      // Rien à faire : au pire le widget reste transparent aux clics jusqu'au prochain affichage.
    }
  }
}
