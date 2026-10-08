/**
 * Étape 256 — Jaris s'écarte pendant qu'il pilote l'écran (étape 263 : seulement quand la tâche reprend l'écran ; en
 * arrière-plan, la fenêtre visée est capturée seule et Jaris reste où il est). Léo parlait depuis la fenêtre de Jaris : la capture
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
  /**
   * Étape 263 : le widget devient transparent aux clics (et invisible aux captures) le temps d'un geste emprunté à
   * Léo en arrière-plan — sans replier la grande fenêtre de Jaris, dont Léo continue peut-être de se servir.
   */
  guard?: (on: boolean) => void
}

let hooks: PilotWindowHooks | null = null

export function setPilotWindowHooks(next: PilotWindowHooks | null): void {
  hooks = next
}

/** Ce qu'une tâche de pilotage peut demander aux fenêtres de Jaris. */
export interface PilotWindows {
  /** Pilotage d'avant (sur l'écran) : Jaris s'écarte, une seule fois par tâche. */
  setAside: () => Promise<void>
  /** Étape 263 : geste emprunté en arrière-plan. */
  guard: (on: boolean) => void
}

/**
 * Une tâche de pilotage. Étape 263 : Jaris ne s'écarte plus d'emblée — en arrière-plan, Léo garde ses fenêtres ; il ne
 * s'écarte que si la tâche doit reprendre l'écran (setAside). Il revient dans tous les cas à la fin, y compris si la
 * tâche échoue ou est annulée.
 */
export async function withPilotWindows<T>(task: (windows: PilotWindows) => Promise<T>): Promise<T> {
  const current = hooks
  let begun = false
  const windows: PilotWindows = {
    setAside: async () => {
      if (begun) return
      begun = true
      try {
        await current?.begin()
      } catch {
        // Écarter Jaris aide le pilotage, ce n'est pas une condition : la tâche se fait quand même.
      }
    },
    guard: (on) => {
      try {
        current?.guard?.(on)
      } catch {
        // Le widget reste comme il est : au pire, il gêne un clic emprunté.
      }
    }
  }
  try {
    return await task(windows)
  } finally {
    if (begun) {
      try {
        current?.end()
      } catch {
        // Rien à faire : au pire le widget reste transparent aux clics jusqu'au prochain affichage.
      }
    }
  }
}
