import { useEffect, useRef, useState } from 'react'
import ForceGraph3D, { type ForceGraph3DInstance, type NodeObject } from '3d-force-graph'
import SpriteText from 'three-spritetext'
import type { MemoryGraph } from '../../shared/ipc'

interface MemoryBrainProps {
  graph: MemoryGraph
  onClose: () => void
}

interface SelectedNote {
  title: string
  content: string | null
}

function makeNodeLabel(node: NodeObject): SpriteText {
  const sprite = new SpriteText(String(node.id))
  sprite.color = '#d9ecff'
  sprite.textHeight = 3.5
  sprite.backgroundColor = 'rgba(5, 7, 12, 0.75)'
  sprite.padding = 2
  sprite.borderRadius = 3
  sprite.position.set(0, 9, 0)
  return sprite
}

export default function MemoryBrain({ graph, onClose }: MemoryBrainProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const instanceRef = useRef<ForceGraph3DInstance | null>(null)
  const [selectedNote, setSelectedNote] = useState<SelectedNote | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const instance = new ForceGraph3D(container)
      .graphData({ nodes: graph.nodes.map((n) => ({ ...n })), links: graph.links.map((l) => ({ ...l })) })
      .backgroundColor('rgba(0,0,0,0)')
      .nodeRelSize(4)
      .nodeColor(() => '#37e2ff')
      .nodeOpacity(0.9)
      .nodeThreeObject(makeNodeLabel)
      .nodeThreeObjectExtend(true)
      .linkColor(() => 'rgba(127, 163, 201, 0.55)')
      .linkDirectionalParticles(2)
      .linkDirectionalParticleColor(() => '#37e2ff')
      .onNodeClick((node) => {
        const title = String(node.id)
        setSelectedNote({ title, content: null })
        void window.jaris.getMemoryNoteContent(title).then((content) => setSelectedNote({ title, content }))
      })
      .width(container.clientWidth)
      .height(container.clientHeight)
    instanceRef.current = instance

    const handleResize = (): void => {
      if (!containerRef.current) return
      instance.width(containerRef.current.clientWidth).height(containerRef.current.clientHeight)
    }
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      instance._destructor()
      instanceRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph])

  return (
    <div className="memory-brain">
      <div className="memory-brain__header">
        <span>
          Cerveau de Jaris — {graph.nodes.length} note{graph.nodes.length > 1 ? 's' : ''}
        </span>
        <div className="memory-brain__actions">
          <button onClick={() => window.jaris.openMemoryFolder()}>Ouvrir le dossier</button>
          <button onClick={onClose}>Fermer</button>
        </div>
      </div>
      {graph.nodes.length === 0 ? (
        <div className="memory-brain__empty">Aucune note pour l'instant : parle à Jaris pour qu'il apprenne.</div>
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
