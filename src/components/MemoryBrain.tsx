import { useEffect, useRef } from 'react'
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph'
import type { MemoryGraph } from '../../shared/ipc'

interface MemoryBrainProps {
  graph: MemoryGraph
  onClose: () => void
}

export default function MemoryBrain({ graph, onClose }: MemoryBrainProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const instanceRef = useRef<ForceGraph3DInstance | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const instance = new ForceGraph3D(container)
      .graphData({ nodes: graph.nodes.map((n) => ({ ...n })), links: graph.links.map((l) => ({ ...l })) })
      .backgroundColor('rgba(0,0,0,0)')
      .nodeLabel('id')
      .nodeColor(() => '#37e2ff')
      .nodeRelSize(5)
      .linkColor(() => 'rgba(127, 163, 201, 0.55)')
      .linkDirectionalParticles(1)
      .linkDirectionalParticleColor(() => '#37e2ff')
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
    </div>
  )
}
