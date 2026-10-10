import { createContext, useContext } from 'react'

/**
 * Refonte « design sobre » (maquette Jaris.dc.html) : comme sur ChatGPT, la liste des conversations (ou des
 * applications, images, vidéos) n'est plus une deuxième colonne DANS chaque écran, mais la section
 * « Récents » de la barre latérale principale — et le bouton « Nouvelle conversation » est en tête de cette
 * barre. Chaque écran garde pourtant sa propre liste et sa propre logique (Workspace.tsx) : il y rend ces
 * morceaux par portail dans les emplacements que la barre latérale lui prête ici.
 */
export interface ShellSlots {
  /** Emplacement du bouton « Nouveau… », en haut de la barre latérale. */
  newSlot: HTMLElement | null
  /** Emplacement de la liste « Récents », sous les modes. */
  recentsSlot: HTMLElement | null
  /** Emplacement du titre de l'en-tête (conversation ouverte, ou nom de l'écran). */
  titleSlot: HTMLElement | null
}

export const ShellSlotsContext = createContext<ShellSlots>({ newSlot: null, recentsSlot: null, titleSlot: null })

export const useShellSlots = (): ShellSlots => useContext(ShellSlotsContext)

/**
 * Vrai si l'écran qui contient ce composant est celui affiché (voir KeepAlive.tsx) : les quatre écrans restent
 * montés en permanence, mais un seul doit occuper les emplacements de la barre latérale à un instant donné.
 */
export const ScreenActiveContext = createContext(true)

export const useScreenActive = (): boolean => useContext(ScreenActiveContext)
