import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DependencyList } from 'react'

/**
 * Placement et fermeture d'un panneau ouvert au-dessus d'un bouton du champ de saisie (modèle/réflexion, durée
 * d'une vidéo). Extrait de ModelEffortPicker à l'étape 204 : le sélecteur de durée devait se comporter EXACTEMENT
 * pareil, et deux copies de ce calcul auraient fini par diverger.
 * - centré sur le bouton, mais jamais coupé par un bord de la fenêtre (mesuré avant d'être peint, étape 200) ;
 * - jamais plus haut que la place disponible au-dessus du bouton (étape 201) ;
 * - fermé au clic en dehors ou sur Échap, comme les menus de ChatGPT/Claude.
 * `deps` : ce qui change la taille du panneau pendant qu'il est ouvert (vue, contenu chargé…).
 */
export function usePickerPanel(open: boolean, setOpen: (open: boolean) => void, deps: DependencyList = []) {
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [shift, setShift] = useState(0)
  const [maxHeight, setMaxHeight] = useState<number | null>(null)

  useLayoutEffect(() => {
    if (!open || !panelRef.current) return
    const margin = 8
    const rect = panelRef.current.getBoundingClientRect()
    const centeredLeft = rect.left - shift
    const centeredRight = rect.right - shift
    let next = 0
    if (centeredRight > window.innerWidth - margin) next = window.innerWidth - margin - centeredRight
    if (centeredLeft + next < margin) next = margin - centeredLeft
    if (next !== shift) setShift(next)
    const room = rootRef.current ? Math.floor(rootRef.current.getBoundingClientRect().top - 16) : null
    if (room !== maxHeight) setMaxHeight(room)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, shift, maxHeight, ...deps])

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

  const panelStyle = { '--shift': `${shift}px`, maxHeight: maxHeight ?? undefined } as CSSProperties
  return { rootRef, panelRef, panelStyle }
}
