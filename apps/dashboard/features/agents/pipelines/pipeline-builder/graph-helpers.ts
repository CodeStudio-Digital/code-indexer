/**
 * Pure conversion helpers between `PipelineGraph` (the persisted model)
 * and the React Flow `Node`/`Edge` shapes the visual builder operates on.
 *
 * Extracted from `PipelineBuilder.tsx` so the conversions can be unit
 * tested in isolation and reused by future pipeline tooling (preview,
 * diff viewer) without dragging the builder's render tree along.
 */
import type { Edge, Node } from '@xyflow/react';
import type {
  PipelineEdge,
  PipelineGraph,
  PipelineNode,
} from '@mcp/company/types.js';
import {
  PIPELINE_EDGE_TYPE,
  type PipelineEdgeData,
} from '../PipelineEdgeView.js';
import {
  PIPELINE_NODE_TYPE,
  type PipelineNodeData,
} from '../PipelineNodeView.js';

export type FlowNode = Node<PipelineNodeData>;
export type FlowEdge = Edge<PipelineEdgeData>;

/**
 * A two-node starter graph rendered when the user opens the builder
 * without a pre-existing pipeline. Picked to demonstrate both an
 * `investigate → implement` linear flow AND the role-binding contract
 * (each node owns a `role` + a `taskTemplate` with `{{…}}` interpolation).
 */
export const STARTER_GRAPH: PipelineGraph = {
  version: 1,
  nodes: [
    {
      id: 'investigate',
      label: 'Investigate',
      role: 'investigator',
      kind: 'agent',
      taskTemplate: '{{initial_input}}',
      branchMode: 'linear',
      position: { x: 100, y: 120 },
    },
    {
      id: 'implement',
      label: 'Implement',
      role: 'backend',
      kind: 'agent',
      taskTemplate: 'Implement based on:\n\n{{previous_output}}',
      branchMode: 'linear',
      position: { x: 480, y: 120 },
    },
  ],
  edges: [{ kind: 'linear', id: 'e1', from: 'investigate', to: 'implement' }],
};

/** Wrap a single `PipelineNode` in the React Flow node shape. */
export function toFlowNode(n: PipelineNode): FlowNode {
  return {
    id: n.id,
    type: PIPELINE_NODE_TYPE,
    position: n.position ?? { x: 100, y: 100 },
    data: { pipelineNode: n },
  };
}

/** Map every PipelineNode in the graph to a React Flow node. */
export function graphNodesToFlow(nodes: PipelineNode[]): FlowNode[] {
  return nodes.map((n) => toFlowNode(n));
}

/**
 * Map every PipelineEdge in the graph to a React Flow edge. Pass-fail
 * edges carry their `on` value as `sourceHandle` so the custom edge
 * view renders the right label.
 */
export function graphEdgesToFlow(edges: PipelineEdge[]): FlowEdge[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    sourceHandle: e.kind === 'pass-fail' ? e.on : undefined,
    type: PIPELINE_EDGE_TYPE,
    data: { pipelineEdge: e },
  }));
}

/**
 * Generate the next unused `node_N` id given the current set. Scans
 * from `existing.length + 1` so the typical "always grow" path doesn't
 * iterate over the whole set looking for collisions.
 */
export function nextNodeId(existing: FlowNode[]): string {
  let i = existing.length + 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = `node_${i}`;
    if (!existing.some((n) => n.id === candidate)) return candidate;
    i++;
  }
}
