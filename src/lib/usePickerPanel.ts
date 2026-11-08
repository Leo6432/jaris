import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DependencyList } from 'react'

/**
 * Placement et fermeture d'un panneau ouvert au-dessus d'un bouton du champ de saisie (modèle/réflexion, durée
 * d'une vidéo). Extrait de ModelEffortPicker à l'étape 204 : le sélecteur de durée devait se comporter EXACTEMENT
 * pareil, et deux copies de ce calcul auraient fini par diverger.
 * - centré sur le bouton, mais jamais coupé par un bord de la fenêtre (mesuré avant d'être peint, étape 200), ni par
 *   celui d'une colonne qui coupe ce qui dépasse (mode Code à 1200 px : la colonne de 250 px à côté de l'aperçu
 *   coupait le panneau GitHub de 340 px, nom du dépôt et recherche amputés de leur début) — plus étroit si besoin ;
 * - jamais plus haut que la place disponible au-dessus du bouton (étape 201) ;
 * - fermé au clic en dehors ou sur Échap, comme les menus de ChatGPT/Claude.
 * `deps` : ce qui change la taille du panneau pendant qu'il est ouvert (vue, contenu chargé…).
 */
/** Bords gauche et droit de ce qui reste visible autour de `from` : la fenêtre, réduite par chaque parent qui coupe ce
 *  qui dépasse en largeur (overflow autre que visible). */
function visibleBounds(from: HTMLElement | null): { left: number; right: number } {
  let left = 0
  let right = window.innerWidth
  for (let el = from?.parentElement ?? null; el && el !== document.body; el = el.parentElement) {
    if (getComputedStyle(el).overflowX === 'visible') continue
    const box = el.getBoundingClientRect()
    left = Math.max(left, box.left)
    right = Math.min(right, box.right)
  }
  return { left, right }
}

export function usePickerPanel(open: boolean, setOpen: (open: boolean) => void, deps: DependencyList = []) {
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [shift, setShift] = useState(0)
  const [maxHeight, setMaxHeight] = useState<number | null>(null)
  const [maxWidth, setMaxWidth] = useState<number | null>(null)

  useLayoutEffect(() => {
    if (!open || !panelRef.current) return
    const margin = 8
    const bounds = visibleBounds(rootRef.current)
    const width = Math.floor(bounds.right - bounds.left - 2 * margin)
    if (width !== maxWidth) setMaxWidth(width)
    const rect = panelRef.current.getBoundingClientRect()
    const centeredLeft = rect.left - shift
    const centeredRight = rect.right - shift
    let next = 0
    if (centeredRight > bounds.right - margin) next = bounds.right - margin - centeredRight
    if (centeredLeft + next < bounds.left + margin) next = bounds.left + margin - centeredLeft
    if (next !== shift) setShift(next)
    const room = rootRef.current ? Math.floor(rootRef.current.getBoundingClientRect().top - 16) : null
    if (room !== maxHeight) setMaxHeight(room)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, shift, maxHeight, maxWidth, ...deps])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, setOpen])

  const panelStyle = { '--shift': `${shift}px`, maxHeight: maxHeight ?? undefined, maxWidth: maxWidth ?? undefined } as CSSProperties
  return { rootRef, panelRef, panelStyle }
}
