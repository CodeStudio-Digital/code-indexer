/**
 * Graph state hook for `PipelineBuilder`. Owns the React Flow node /
 * edge arrays, the selected-entity slot, and every mutator the body
 * needs to call (`updateNode`, `removeEdge`, `addNewNode`, etc.).
 *
 * Extracted from the inline body of `PipelineBuilder.tsx` so the
 * orchestration component can stay focused on render decisions and the
 * graph-mutation contract can move/test as a unit.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnConnect,
} from '@xyflow/react';
import type {
  Pipeline,
  PipelineEdge,
  PipelineGraph,
  PipelineNode,
} from '@mcp/company/types.js';
import type { PipelineTemplate } from '../templates.js';
import { PIPELINE_EDGE_TYPE } from '../PipelineEdgeView.js';
import {
  STARTER_GRAPH,
  graphEdgesToFlow,
  graphNodesToFlow,
  nextNodeId,
  toFlowNode,
  type FlowEdge,
  type FlowNode,
} from './graph-helpers.js';

export interface UsePipelineGraphParams {
  pipeline: Pipeline | null;
  availableRoles: string[];
}

export interface UsePipelineGraphResult {
  name: string;
  setName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  flowNodes: FlowNode[];
  flowEdges: FlowEdge[];
  selected: { kind: 'node' | 'edge'; id: string } | null;
  setSelected: React.Dispatch<
    React.SetStateAction<{ kind: 'node' | 'edge'; id: string } | null>
  >;
  flowNodesWithPos: FlowNode[];

  onNodesChange: (changes: NodeChange<FlowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<FlowEdge>[]) => void;
  onConnect: OnConnect;

  updateNode: (nodeId: string, patch: Partial<PipelineNode>) => void;
  updateEdge: (edgeId: string, next: PipelineEdge) => void;
  removeNode: (nodeId: string) => void;
  removeEdge: (edgeId: string) => void;
  addNewNode: (init?: Partial<PipelineNode>) => void;
  addFromTemplate: (template: PipelineTemplate) => void;

  buildGraph: () => PipelineGraph;
}

export function usePipelineGraph({
  pipeline,
  availableRoles,
}: UsePipelineGraphParams): UsePipelineGraphResult {
  const initial = useMemo(() => {
    const g = pipeline?.graph ?? STARTER_GRAPH;
    return {
      name: pipeline?.name ?? 'New pipeline',
      description: pipeline?.description ?? '',
      flowNodes: graphNodesToFlow(g.nodes),
      flowEdges: graphEdgesToFlow(g.edges),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline]);

  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [flowNodes, setFlowNodes] = useState<FlowNode[]>(initial.flowNodes);
  const [flowEdges, setFlowEdges] = useState<FlowEdge[]>(initial.flowEdges);
  const [selected, setSelected] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null);

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      setFlowNodes((ns) => applyNodeChanges<FlowNode>(changes, ns));
      // Keyboard-delete (Backspace/Delete) routes through here too.
      // Drop edges whose source/target was just removed so the graph
      // stays consistent without relying on React Flow's automatic
      // edge cleanup (which is timing-dependent), and clear the side
      // panel when its node disappears.
      const removedNodeIds = changes
        .filter((c): c is Extract<NodeChange<FlowNode>, { type: 'remove' }> => c.type === 'remove')
        .map((c) => c.id);
      if (removedNodeIds.length > 0) {
        setFlowEdges((es) =>
          es.filter((e) => !removedNodeIds.includes(e.source) && !removedNodeIds.includes(e.target)),
        );
        setSelected((cur) =>
          cur && cur.kind === 'node' && removedNodeIds.includes(cur.id) ? null : cur,
        );
      }
    },
    [],
  );

  const onEdgesChange = useCallback((changes: EdgeChange<FlowEdge>[]) => {
    setFlowEdges((es) => applyEdgeChanges<FlowEdge>(changes, es));
    const removedEdgeIds = changes
      .filter((c): c is Extract<EdgeChange<FlowEdge>, { type: 'remove' }> => c.type === 'remove')
      .map((c) => c.id);
    if (removedEdgeIds.length > 0) {
      setSelected((cur) =>
        cur && cur.kind === 'edge' && removedEdgeIds.includes(cur.id) ? null : cur,
      );
    }
  }, []);

  /**
   * Connection handler: infer the edge kind from the source node's
   * `branchMode` and the dragged source handle id. Any pass-fail node
   * (validator OR agent with `branchMode: 'pass-fail'`) exposes three
   * named handles (pass / fail / review) and the handle id maps directly
   * to the edge's `on`. Everything else creates a linear edge.
   */
  const onConnect: OnConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return;
      const id = `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const sourceNode = flowNodes.find((n) => n.id === conn.source);
      const sourceBranchMode = sourceNode?.data.pipelineNode.branchMode ?? 'linear';
      const isPassFailHandle =
        sourceBranchMode === 'pass-fail' &&
        (conn.sourceHandle === 'pass' ||
          conn.sourceHandle === 'fail' ||
          conn.sourceHandle === 'review');
      let edge: PipelineEdge;
      if (isPassFailHandle) {
        edge = {
          kind: 'pass-fail',
          id,
          from: conn.source,
          on: conn.sourceHandle as 'pass' | 'fail' | 'review',
          to: conn.target,
        };
      } else {
        edge = { kind: 'linear', id, from: conn.source, to: conn.target };
      }
      setFlowEdges((es) =>
        addEdge<FlowEdge>(
          {
            id,
            source: conn.source!,
            target: conn.target!,
            sourceHandle: conn.sourceHandle ?? undefined,
            targetHandle: conn.targetHandle ?? undefined,
            data: { pipelineEdge: edge },
            type: PIPELINE_EDGE_TYPE,
          },
          es,
        ),
      );
    },
    [flowNodes],
  );

  // ─── Mutators applied to the underlying PipelineNode/Edge ────

  const updateNode = (nodeId: string, patch: Partial<PipelineNode>) => {
    setFlowNodes((ns) =>
      ns.map((n) => {
        if (n.id !== nodeId) return n;
        const merged: PipelineNode = { ...n.data.pipelineNode, ...patch };
        return {
          ...n,
          // Custom node renderer reads from `data.pipelineNode` — keep
          // the shape intact across edits.
          data: { pipelineNode: merged },
          position: merged.position ?? n.position,
        };
      }),
    );
  };

  const updateEdge = (edgeId: string, next: PipelineEdge) => {
    setFlowEdges((es) =>
      es.map((e) => {
        if (e.id !== edgeId) return e;
        return {
          ...e,
          data: { pipelineEdge: next },
          source: next.from,
          target: next.to,
          sourceHandle:
            next.kind === 'pass-fail' ? next.on : e.sourceHandle ?? undefined,
        };
      }),
    );
  };

  const removeNode = (nodeId: string) => {
    setFlowNodes((ns) => ns.filter((n) => n.id !== nodeId));
    setFlowEdges((es) => es.filter((e) => e.source !== nodeId && e.target !== nodeId));
    setSelected(null);
  };

  const removeEdge = (edgeId: string) => {
    setFlowEdges((es) => es.filter((e) => e.id !== edgeId));
    setSelected(null);
  };

  /** Add a node at a free spot — drops below the current bottom-most node. */
  const addNewNode = (init?: Partial<PipelineNode>) => {
    const id = nextNodeId(flowNodes);
    const bottomY = flowNodes.reduce((max, n) => Math.max(max, n.position.y), 0);
    const node: PipelineNode = {
      id,
      label: id,
      role: availableRoles[0] ?? 'subordinate',
      kind: 'agent',
      taskTemplate: '{{previous_output}}',
      branchMode: 'linear',
      position: { x: 200, y: bottomY + 180 },
      ...init,
    };
    setFlowNodes((ns) => [...ns, toFlowNode(node)]);
    setSelected({ kind: 'node', id });
  };

  /** Add a node from a template — same flow as `addNewNode` but seeded. */
  const addFromTemplate = (template: PipelineTemplate) => {
    addNewNode({ ...template.spec });
  };

  // Sync flow positions back into the underlying node objects on every
  // render — without this, drag-drop changes would be lost on save.
  const flowNodesWithPos: FlowNode[] = useMemo(
    () =>
      flowNodes.map((n) => ({
        ...n,
        data: {
          pipelineNode: {
            ...n.data.pipelineNode,
            position: { x: n.position.x, y: n.position.y },
          },
        },
      })),
    [flowNodes],
  );

  const buildGraph = (): PipelineGraph => ({
    version: 1,
    nodes: flowNodesWithPos.map((n) => n.data.pipelineNode),
    edges: flowEdges.map((e) => e.data!.pipelineEdge),
  });

  return {
    name,
    setName,
    description,
    setDescription,
    flowNodes,
    flowEdges,
    selected,
    setSelected,
    flowNodesWithPos,
    onNodesChange,
    onEdgesChange,
    onConnect,
    updateNode,
    updateEdge,
    removeNode,
    removeEdge,
    addNewNode,
    addFromTemplate,
    buildGraph,
  };
}
