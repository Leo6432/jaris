import { useEffect, useRef, useState } from 'react'
import ForceGraph3D, { type ForceGraph3DInstance, type NodeObject } from '3d-force-graph'
import SpriteText from 'three-spritetext'
import type { MemoryGraph } from '../../shared/ipc'
import { t, tn } from '@/lib/i18n'

/**
 * Étape 265 : un écran de la zone principale (comme Options), plus un calque plein écran — celui-ci passait
 * sous les boutons réduire/agrandir/fermer de Windows. Plus de bouton « Fermer » : on en sort par le rail.
 */
interface MemoryBrainProps {
  graph: MemoryGraph
}

interface SelectedNote {
  title: string
  content: string | null
}

function isCenterNode(node: NodeObject): boolean {
  return Boolean((node as { isCenter?: boolean }).isCenter)
}

/**
 * Couleurs dessinées dans la vue 3D (un canvas : le CSS n'y entre pas). Celles du thème sombre sont celles d'origine ;
 * en thème clair, les étiquettes sombres sur fond quasi noir et les liens bleu pâle devenaient des taches sur le
 * blanc : texte foncé sur fond clair, liens plus soutenus. Les nœuds gardent les couleurs de Jaris (cyan, ambre).
 * La vue 3D éclaircit les couleurs de ses étiquettes (mesuré : #10243a s'affichait gris moyen) : d'où un texte noir,
 * et un ambre très foncé (#411600) qui s'affiche comme l'ambre du thème clair (#8a5300).
 */
const BRAIN_COLORS = {
  dark: { label: '#d9ecff', centerLabel: '#ffb648', labelBackground: 'rgba(5, 7, 12, 0.75)', link: 'rgba(127, 163, 201, 0.55)' },
  light: { label: '#000000', centerLabel: '#411600', labelBackground: 'rgba(255, 255, 255, 0.9)', link: 'rgba(30, 60, 100, 0.6)', weight: '600' }
} as const

const LIGHT_QUERY = '(prefers-color-scheme: light)'

/** Le thème de Windows (Jaris le suit), relu quand il change. */
function usePrefersLight(): boolean {
  const [light, setLight] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(LIGHT_QUERY).matches)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(LIGHT_QUERY)
    const onChange = (): void => setLight(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return light
}

function makeNodeLabel(node: NodeObject, colors: (typeof BRAIN_COLORS)['dark' | 'light']): SpriteText {
  const isCenter = isCenterNode(node)
  const sprite = new SpriteText(String(node.id))
  sprite.color = isCenter ? colors.centerLabel : colors.label
  sprite.textHeight = isCenter ? 5 : 3.5
  sprite.backgroundColor = colors.labelBackground
  // Texte foncé sur fond clair : les lettres fines, réduites par la vue 3D, tournaient au gris ; un cran plus gras.
  if ('weight' in colors) sprite.fontWeight = colors.weight
  sprite.padding = 2
  sprite.borderRadius = 3
  sprite.position.set(0, isCenter ? 13 : 9, 0)
  // Les étiquettes passent toujours devant les sphères : « Parc Astérix » disparaissait derrière la grosse sphère « Léo ».
  sprite.material.depthTest = false
  sprite.renderOrder = 10
  return sprite
}

export default function MemoryBrain({ graph }: MemoryBrainProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const instanceRef = useRef<ForceGraph3DInstance | null>(null)
  const [selectedNote, setSelectedNote] = useState<SelectedNote | null>(null)
  // Étape 234 (bêta) : sans WebGL (pilote graphique, machine virtuelle, accélération désactivée), la vue 3D
  // lève une exception dès sa création — non rattrapée, elle vidait TOUT l'écran de Jaris (menu compris).
  const [view3dFailed, setView3dFailed] = useState(false)
  const light = usePrefersLight()
  // Numéro de la dernière note demandée : une réponse plus ancienne qui arrive après (clic sur A puis B, A répond en
  // dernier) est ignorée au lieu de remplacer la note affichée. Fermer la note invalide aussi la demande en cours.
  const noteRequestRef = useRef(0)

  // Le nœud central est l'utilisateur (ajouté par main.ts), pas une note : le compter affichait « 2 notes » pour une seule.
  const notes = graph.nodes.filter((node) => !node.isCenter)
  const noteCount = notes.length

  const openNote = (title: string): void => {
    const request = ++noteRequestRef.current
    setSelectedNote({ title, content: null })
    // Étape 328 : aucune note à ce titre (le prénom au centre, souvent) ou note illisible : une phrase dans la langue
    // de Jaris, jamais « chargement… » pour toujours ni la réponse française destinée au modèle.
    void window.jaris.getMemoryNoteContent(title).then(
      (content) => {
        if (request === noteRequestRef.current) setSelectedNote({ title, content: content ?? t('brain.noNote', { title }) })
      },
      (err: unknown) => {
        if (request === noteRequestRef.current) setSelectedNote({ title, content: err instanceof Error ? err.message : String(err) })
      }
    )
  }

  const closeNote = (): void => {
    noteRequestRef.current++
    setSelectedNote(null)
  }

  /** Les notes en boutons (clavier, lecteur d'écran) : dans le canvas 3D, on ne les atteint qu'à la souris. */
  const noteList = (
    <ul className="memory-brain__list">
      {notes.map((node) => (
        <li key={node.id}>
          <button className="memory-brain__list-item" onClick={() => openNote(node.id)}>
            {node.id}
          </button>
        </li>
      ))}
    </ul>
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const colors = light ? BRAIN_COLORS.light : BRAIN_COLORS.dark
    let instance: ForceGraph3DInstance
    try {
      instance = new ForceGraph3D(container)
        .graphData({ nodes: graph.nodes.map((n) => ({ ...n })), links: graph.links.map((l) => ({ ...l })) })
        .backgroundColor('rgba(0,0,0,0)')
        // Étape 265 : l'aide de navigation de la bibliothèque est en anglais, en gris sur gris, collée en bas.
        .showNavInfo(false)
        .nodeRelSize(4)
        .nodeVal((node) => (isCenterNode(node) ? 3 : 1))
        .nodeColor((node) => (isCenterNode(node) ? '#ffb648' : '#37e2ff'))
        .nodeOpacity(0.9)
        .nodeThreeObject((node) => makeNodeLabel(node, colors))
        .nodeThreeObjectExtend(true)
        .linkColor(() => colors.link)
        .linkDirectionalParticles(2)
        .linkDirectionalParticleColor(() => '#37e2ff')
        .onNodeClick((node) => openNote(String(node.id)))
        // Étape 354 (design) : quelques notes restaient minuscules au milieu d'un grand vide. Le graphe est posé
        // avant le premier affichage, puis la caméra le cadre une seule fois (plus bas) : jamais elle ne reprend
        // la main sur un zoom de l'utilisateur.
        .warmupTicks(100)
        .width(container.clientWidth)
        .height(container.clientHeight)
    } catch (err) {
      console.error('[MemoryBrain] vue 3D impossible :', err)
      container.replaceChildren()
      setView3dFailed(true)
      return
    }
    instanceRef.current = instance
    const fitTimer = window.setTimeout(() => instance.zoomToFit(600, 120), 300)

    const handleResize = (): void => {
      if (!containerRef.current) return
      instance.width(containerRef.current.clientWidth).height(containerRef.current.clientHeight)
    }
    // Dans la zone principale, la taille change aussi quand la fenêtre ne bouge pas (liste repliée,
    // bandeau qui apparaît) : on suit le conteneur lui-même, pas seulement la fenêtre.
    const observer = new ResizeObserver(handleResize)
    observer.observe(container)
    window.addEventListener('resize', handleResize)

    return () => {
      window.clearTimeout(fitTimer)
      observer.disconnect()
      window.removeEventListener('resize', handleResize)
      instance._destructor()
      instanceRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, light])

  return (
    <div className="memory-brain">
      <div className="memory-brain__header">
        {/* Le nom de l'écran est déjà dans l'en-tête de la fenêtre : ne pas l'écrire deux fois. Avec la vue 3D, le nombre
            de notes déplie leur liste (discrète, fermée par défaut) : chaque note s'ouvre aussi au clavier. */}
        {noteCount > 0 && !view3dFailed ? (
          <details className="memory-brain__index">
            <summary>{tn('brain.notes', noteCount)}</summary>
            {noteList}
          </details>
        ) : (
          <span>{tn('brain.notes', noteCount)}</span>
        )}
        <div className="memory-brain__actions">
          <button onClick={() => window.jaris.openMemoryFolder()}>{t('common.openFolder')}</button>
        </div>
      </div>
      {noteCount === 0 ? (
        <div className="memory-brain__empty">{t('brain.empty')}</div>
      ) : view3dFailed ? (
        <div className="memory-brain__fallback">
          <p className="memory-brain__fallback-text">{t('brain.no3d')}</p>
          {noteList}
        </div>
      ) : (
        <div ref={containerRef} className="memory-brain__canvas" />
      )}

      {selectedNote && (
        <div className="memory-brain__note">
          <div className="memory-brain__note-header">
            <span>{selectedNote.title}</span>
            <button onClick={closeNote} aria-label={t('common.close')}>✕</button>
          </div>
          <pre className="memory-brain__note-content">
            {selectedNote.content === null ? t('common.loading') : selectedNote.content}
          </pre>
        </div>
      )}
    </div>
  )
}
