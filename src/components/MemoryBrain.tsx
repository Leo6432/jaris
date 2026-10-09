import { useEffect, useRef, useState } from 'react'
import ForceGraph3D, { type ForceGraph3DInstance, type NodeObject } from '3d-force-graph'
import SpriteText from 'three-spritetext'
import type { MemoryGraph } from '../../shared/ipc'

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

function makeNodeLabel(node: NodeObject): SpriteText {
  const isCenter = isCenterNode(node)
  const sprite = new SpriteText(String(node.id))
  sprite.color = isCenter ? '#ffb648' : '#d9ecff'
  sprite.textHeight = isCenter ? 5 : 3.5
  sprite.backgroundColor = 'rgba(5, 7, 12, 0.75)'
  sprite.padding = 2
  sprite.borderRadius = 3
  sprite.position.set(0, isCenter ? 13 : 9, 0)
  return sprite
}

export default function MemoryBrain({ graph }: MemoryBrainProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const instanceRef = useRef<ForceGraph3DInstance | null>(null)
  const [selectedNote, setSelectedNote] = useState<SelectedNote | null>(null)
  // Étape 234 (bêta) : sans WebGL (pilote graphique, machine virtuelle, accélération désactivée), la vue 3D
  // lève une exception dès sa création — non rattrapée, elle vidait TOUT l'écran de Jaris (menu compris).
  const [view3dFailed, setView3dFailed] = useState(false)

  // Le nœud central est l'utilisateur (ajouté par main.ts), pas une note : le compter affichait « 2 notes » pour une seule.
  const noteCount = graph.nodes.filter((node) => !node.isCenter).length

  const openNote = (title: string): void => {
    setSelectedNote({ title, content: null })
    void window.jaris.getMemoryNoteContent(title).then((content) => setSelectedNote({ title, content }))
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

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
        .nodeThreeObject(makeNodeLabel)
        .nodeThreeObjectExtend(true)
        .linkColor(() => 'rgba(127, 163, 201, 0.55)')
        .linkDirectionalParticles(2)
        .linkDirectionalParticleColor(() => '#37e2ff')
        .onNodeClick((node) => openNote(String(node.id)))
        .width(container.clientWidth)
        .height(container.clientHeight)
    } catch (err) {
      console.error('[MemoryBrain] vue 3D impossible :', err)
      container.replaceChildren()
      setView3dFailed(true)
      return
    }
    instanceRef.current = instance

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
      observer.disconnect()
      window.removeEventListener('resize', handleResize)
      instance._destructor()
      instanceRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph])

  return (
    <div className="memory-brain">
      <div className="memory-brain__header">
        {/* Le nom de l'écran est déjà dans l'en-tête de la fenêtre : ne pas l'écrire deux fois. */}
        <span>
          {noteCount} note{noteCount > 1 ? 's' : ''}
        </span>
        <div className="memory-brain__actions">
          <button onClick={() => window.jaris.openMemoryFolder()}>Ouvrir le dossier</button>
        </div>
      </div>
      {noteCount === 0 ? (
        <div className="memory-brain__empty">Aucune note pour l'instant : parle à Jaris pour qu'il apprenne.</div>
      ) : view3dFailed ? (
        <div className="memory-brain__fallback">
          <p className="memory-brain__fallback-text">
            La vue en 3D ne peut pas s'afficher sur cet ordinateur (la carte graphique ou son pilote la refuse).
            Voici tes notes en liste : clique sur une note pour la lire.
          </p>
          <ul className="memory-brain__list">
            {graph.nodes
              .filter((node) => !node.isCenter)
              .map((node) => (
                <li key={node.id}>
                  <button className="memory-brain__list-item" onClick={() => openNote(node.id)}>
                    {node.id}
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ) : (
        <div ref={containerRef} className="memory-brain__canvas" />
      )}

      {selectedNote && (
        <div className="memory-brain__note">
          <div className="memory-brain__note-header">
            <span>{selectedNote.title}</span>
            <button onClick={() => setSelectedNote(null)}>✕</button>
          </div>
          <pre className="memory-brain__note-content">
            {selectedNote.content === null ? 'Chargement...' : selectedNote.content}
          </pre>
        </div>
      )}
    </div>
  )
}
