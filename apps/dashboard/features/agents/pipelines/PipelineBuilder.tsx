/**
 * Visual builder for pipelines on top of `@xyflow/react`.
 *
 * Two modes:
 *   - Editing an existing pipeline (`pipeline` prop): preserves
 *     `version` for optimistic-concurrency PATCHes.
 *   - Creating a new one (`pipeline === null`): blank canvas, first
 *     save POSTs and switches to edit mode.
 *
 * Layout:
 *   [Templates panel]  [Canvas with custom nodes/edges]  [Selected entity panel]
 *
 * The graph stays the source of truth: xyflow nodes/edges mirror
 * `PipelineGraph.nodes/edges` 1:1 plus layout fields. On save we
 * round-trip through `validatePipelineGraph` so a misconfigured graph
 * never reaches the executor.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  SelectionMode,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type OnConnect,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ChevronLeft, Save, Network, HelpCircle, Trash2 } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../../components/ui/tooltip.js';
import { apiPost, apiPatch } from '../../../hooks/useApi.js';
import type {
  KanbanColumn,
  KanbanTag,
  Pipeline,
  PipelineEdge,
  PipelineGraph,
  PipelineNode,
} from '@mcp/company/types.js';
import { NodeEditPanel } from './NodeEditPanel.js';
import { EdgeEditPanel } from './EdgeEditPanel.js';
import { PipelineNodeView, PIPELINE_NODE_TYPE, type PipelineNodeData } from './PipelineNodeView.js';
import { PipelineEdgeView, PIPELINE_EDGE_TYPE, type PipelineEdgeData } from './PipelineEdgeView.js';
import { PipelineTemplatesPanel } from './PipelineTemplatesPanel.js';
import type { PipelineTemplate } from './templates.js';

interface PipelineBuilderProps {
  companySessionId: number;
  pipeline: Pipeline | null;
  availableRoles: string[];
  availableSkills: string[];
  onClose: () => void;
  onSaved: (pipeline: Pipeline) => void;
}

type FlowNode = Node<PipelineNodeData>;
type FlowEdge = Edge<PipelineEdgeData>;

const STARTER_GRAPH: PipelineGraph = {
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

// `nodeTypes`/`edgeTypes` need stable references — recreating them on
// every render makes React Flow warn and remount.
const NODE_TYPES = { [PIPELINE_NODE_TYPE]: PipelineNodeView } as const;
const EDGE_TYPES = { [PIPELINE_EDGE_TYPE]: PipelineEdgeView } as const;

export function PipelineBuilder(props: PipelineBuilderProps) {
  return (
    <ReactFlowProvider>
      <TooltipProvider>
        <PipelineBuilderInner {...props} />
      </TooltipProvider>
    </ReactFlowProvider>
  );
}

function PipelineBuilderInner({
  companySessionId,
  pipeline,
  availableRoles,
  availableSkills,
  onClose,
  onSaved,
}: PipelineBuilderProps) {
  const { t } = useTranslation(['agents', 'common']);

  const initial = useMemo(() => {
    const g = pipeline?.graph ?? STARTER_GRAPH;
    return {
      name: pipeline?.name ?? 'New pipeline',
      description: pipeline?.description ?? '',
      version: pipeline?.version ?? 0,
      flowNodes: graphNodesToFlow(g.nodes),
      flowEdges: graphEdgesToFlow(g.edges),
    };
  }, [pipeline]);

  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [flowNodes, setFlowNodes] = useState<FlowNode[]>(initial.flowNodes);
  const [flowEdges, setFlowEdges] = useState<FlowEdge[]>(initial.flowEdges);
  const [selected, setSelected] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationIssues, setValidationIssues] = useState<string[]>([]);

  // ─── React Flow handlers ──────────────────────────────────────

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
  const onEdgesChange = useCallback(
    (changes: EdgeChange<FlowEdge>[]) => {
      setFlowEdges((es) => applyEdgeChanges<FlowEdge>(changes, es));
      const removedEdgeIds = changes
        .filter((c): c is Extract<EdgeChange<FlowEdge>, { type: 'remove' }> => c.type === 'remove')
        .map((c) => c.id);
      if (removedEdgeIds.length > 0) {
        setSelected((cur) =>
          cur && cur.kind === 'edge' && removedEdgeIds.includes(cur.id) ? null : cur,
        );
      }
    },
    [],
  );

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
          // the shape intact across edits. (Was previously losing
          // metadata that the default React Flow node displayed.)
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

  /** Add a node at a free spot. New blank nodes drop into a sensible
   *  empty area below the current bottom-most node. */
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

  /** Add a node from a template — same flow as addNewNode but seeded. */
  const addFromTemplate = (template: PipelineTemplate) => {
    addNewNode({ ...template.spec });
  };

  // Sync flow positions back into the underlying node objects on
  // every render — without this, drag-drop changes would be lost on save.
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

  // ─── Save ────────────────────────────────────────────────────

  const handleSave = async () => {
    setError(null);
    setValidationIssues([]);
    setSaving(true);
    const graph = buildGraph();
    try {
      const validation = await apiPost<{
        ok: boolean;
        errors: Array<{ nodeId?: string; edgeId?: string; message: string }>;
      }>(`/company/pipelines/${pipeline?.id ?? 0}/validate`, {
        graph,
        session_id: companySessionId,
      });
      if (!validation.ok) {
        setValidationIssues(validation.errors.map((e) => e.message));
        setSaving(false);
        return;
      }
      let saved: Pipeline;
      if (pipeline) {
        saved = await apiPatch<Pipeline>(`/company/pipelines/${pipeline.id}`, {
          name,
          description,
          graph,
          expected_version: pipeline.version,
        });
      } else {
        saved = await apiPost<Pipeline>('/company/pipelines', {
          name,
          description,
          graph,
          company_session_id: companySessionId,
        });
      }
      onSaved(saved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // ─── Selected entity panel ───────────────────────────────────

  const selectedNode =
    selected?.kind === 'node' ? flowNodes.find((n) => n.id === selected.id) : null;
  const selectedEdge =
    selected?.kind === 'edge' ? flowEdges.find((e) => e.id === selected.id) : null;

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-background">
      <header className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            <ChevronLeft className="h-3.5 w-3.5 mr-1" /> {t('agents:pipelines.back')}
          </Button>
          <Network className="h-4 w-4 text-muted-foreground" />
          <Tooltip>
            <TooltipTrigger asChild>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-7 w-56 text-sm"
                placeholder={t('agents:pipelines.fieldName')}
              />
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t('agents:pipelines.fieldNameTip', {
                defaultValue: 'Display name shown in the chat picker.',
              })}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="h-7 w-72 text-xs"
                placeholder={t('agents:pipelines.fieldDescription')}
              />
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              {t('agents:pipelines.fieldDescriptionTip', {
                defaultValue:
                  'Short summary surfaced under the pipeline name in the picker.',
              })}
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                title={t('agents:pipelines.helpTip', { defaultValue: 'Help' })}
              >
                <HelpCircle className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-sm">
              <div className="space-y-1 text-xs">
                <div className="font-medium">
                  {t('agents:pipelines.help.title', { defaultValue: 'Building a pipeline' })}
                </div>
                <ul className="list-disc pl-4 space-y-0.5">
                  <li>
                    {t('agents:pipelines.help.tipTemplates', {
                      defaultValue: 'Click a template on the left to add a stage.',
                    })}
                  </li>
                  <li>
                    {t('agents:pipelines.help.tipDrag', {
                      defaultValue: 'Drag from a handle to wire two stages together.',
                    })}
                  </li>
                  <li>
                    {t('agents:pipelines.help.tipValidator', {
                      defaultValue:
                        'Validators have three output handles (pass/fail/review). Pull from the matching one.',
                    })}
                  </li>
                  <li>
                    {t('agents:pipelines.help.tipEdit', {
                      defaultValue:
                        'Click a stage or wire to open the editor on the right.',
                    })}
                  </li>
                  <li>
                    {t('agents:pipelines.help.tipBoxSelect', {
                      defaultValue:
                        'Drag on empty canvas to box-select; Space + drag (or middle/right button) to pan.',
                    })}
                  </li>
                  <li>
                    {t('agents:pipelines.help.tipDelete', {
                      defaultValue: 'Delete or Backspace removes the selected stage(s) and wire(s).',
                    })}
                  </li>
                </ul>
              </div>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="ghost" onClick={() => addNewNode()}>
                + {t('agents:pipelines.addNode')}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t('agents:pipelines.addNodeTip', {
                defaultValue: 'Add a blank stage you can edit afterwards.',
              })}
            </TooltipContent>
          </Tooltip>
          <Button size="sm" disabled={saving || !name.trim()} onClick={handleSave}>
            <Save className="h-3.5 w-3.5 mr-1" />
            {saving ? t('common:actions.saving') : t('common:actions.save')}
          </Button>
        </div>
      </header>

      {validationIssues.length > 0 && (
        <div className="border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
          <div className="font-medium mb-1">{t('agents:pipelines.invalidGraph')}</div>
          <ul className="list-disc pl-4">
            {validationIssues.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <div className="border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
          {error}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <PipelineTemplatesPanel onAdd={addFromTemplate} />
        <div className="flex-1 relative">
          {flowNodes.length === 0 && (
            <div className="absolute inset-0 z-10 pointer-events-none flex items-center justify-center">
              <div className="bg-card border rounded-lg shadow-md p-4 text-center pointer-events-auto max-w-sm">
                <div className="text-sm font-medium mb-1">
                  {t('agents:pipelines.empty.title', { defaultValue: 'Empty canvas' })}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t('agents:pipelines.empty.body', {
                    defaultValue:
                      'Click a template on the left to add your first stage, or drag handles between nodes to wire them together.',
                  })}
                </div>
              </div>
            </div>
          )}
          <ReactFlow<FlowNode, FlowEdge>
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelected({ kind: 'node', id: n.id })}
            onEdgeClick={(_, e) => setSelected({ kind: 'edge', id: e.id })}
            onPaneClick={() => setSelected(null)}
            fitView
            fitViewOptions={{ padding: 0.3 }}
            defaultEdgeOptions={{ type: PIPELINE_EDGE_TYPE }}
            deleteKeyCode={['Delete', 'Backspace']}
            // Rubber-band selection: plain left-drag on empty canvas
            // draws a selection box (Figma-style). Pan moves to
            // middle/right button or Space-modifier so the canvas isn't
            // unreachable. `Partial` selects nodes the box overlaps —
            // `Full` is too strict for the average user.
            selectionOnDrag
            selectionMode={SelectionMode.Partial}
            panOnDrag={[1, 2]}
            panActivationKeyCode="Space"
            multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
          >
            <Background gap={16} />
            <MiniMap pannable zoomable className="!bg-card/80" />
            <Controls />
          </ReactFlow>
        </div>

        {selectedNode && (
          <NodeEditPanel
            node={selectedNode.data.pipelineNode}
            availableRoles={availableRoles}
            availableSkills={availableSkills}
            onChange={(patch) => updateNode(selectedNode.id, patch)}
            onDelete={() => removeNode(selectedNode.id)}
          />
        )}
        {selectedEdge && (
          <EdgeEditPanel
            edge={selectedEdge.data!.pipelineEdge}
            onChange={(next) => updateEdge(selectedEdge.id, next)}
            onDelete={() => removeEdge(selectedEdge.id)}
          />
        )}
      </div>
    </div>
  );
}

// ─── Helpers: PipelineGraph ↔ React Flow ──────────────────────

function toFlowNode(n: PipelineNode): FlowNode {
  return {
    id: n.id,
    type: PIPELINE_NODE_TYPE,
    position: n.position ?? { x: 100, y: 100 },
    data: { pipelineNode: n },
  };
}

function graphNodesToFlow(nodes: PipelineNode[]): FlowNode[] {
  return nodes.map((n) => toFlowNode(n));
}

function graphEdgesToFlow(edges: PipelineEdge[]): FlowEdge[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    sourceHandle: e.kind === 'pass-fail' ? e.on : undefined,
    type: PIPELINE_EDGE_TYPE,
    data: { pipelineEdge: e },
  }));
}

function nextNodeId(existing: FlowNode[]): string {
  let i = existing.length + 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = `node_${i}`;
    if (!existing.some((n) => n.id === candidate)) return candidate;
    i++;
  }
}

// Re-export the canonical types so the panel components don't need
// to climb back up the dependency tree.
export type { PipelineNode, PipelineEdge, KanbanColumn, KanbanTag };
