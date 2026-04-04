import { FlowNode, FlowEdge } from '../liveblocks.config'

export function buildContext(
  nodes: FlowNode[],
  edges: FlowEdge[]
): string {
  return JSON.stringify({
    nodes: nodes.map(n => ({
      id: n.id,
      label: n.data.label,
      x: Math.round(n.position.x),
      y: Math.round(n.position.y),
    })),
    edges: edges.map(e => ({
      from: e.source,
      to: e.target,
      label: e.label,
    })),
  }, null, 2)
}
