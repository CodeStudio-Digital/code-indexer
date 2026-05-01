/**
 * Visual builder for pipelines on top of `@xyflow/react`.
 *
 * Two modes:
 *   - Editing an existing pipeline (`pipeline` prop): preserves
 *     `version` for optimistic-concurrency PATCHes
 *   - Creating a new one (`pipeline === null`): blank canvas, first
 *     save POSTs and switches to edit mode
 *
 * The graph is the source of truth: nodes/edges in xyflow state mirror
 * `PipelineGraph.nodes/edges` 1:1 (with extra layout fields). On save
 * we round-trip through `validatePipelineGraph` so a misconfigured
 * graph never reaches the executor.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type OnConnect,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ChevronLeft, Save, Network } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Textarea } from '../../../components/ui/textarea.js';
import { apiPost, apiPatch } from '../../../hooks/useApi.js';
import type {
  KanbanColumn,
  KanbanTag,
  Pipeline,
  PipelineEdge,
  PipelineGraph,
  PipelineNode,
} from '../../../../../core/coder/company/types.js';
import { NodeEditPanel } from './NodeEditPanel.js';
import { EdgeEditPanel } from './EdgeEditPanel.js';

interface PipelineBuilderProps {
  companySessionId: number;
  pipeline: Pipeline | null;
  availableRoles: string[];
  availableSkills: string[];
  onClose: () => void;
  onSaved: (pipeline: Pipeline) => void;
}

interface NodeData extends Record<string, unknown> {
  pipelineNode: PipelineNode;
}

interface EdgeData extends Record<string, unknown> {
  pipelineEdge: PipelineEdge;
}

type FlowNode = Node<NodeData>;
type FlowEdge = Edge<EdgeData>;

const STARTER_GRAPH: PipelineGraph = {
  version: 1,
  nodes: [
    {
      id: 'investigate',
      label: 'Investigate',
      role: 'investigator',
      taskTemplate: '{{initial_input}}',
      branchMode: 'linear',
      position: { x: 80, y: 80 },
    },
    {
      id: 'implement',
      label: 'Implement',
      role: 'backend',
      taskTemplate: 'Implement based on:\n\n{{previous_output}}',
      branchMode: 'linear',
      position: { x: 360, y: 80 },
    },
  ],
  edges: [{ kind: 'linear', id: 'e1', from: 'investigate', to: 'implement' }],
};

export function PipelineBuilder(props: PipelineBuilderProps) {
  return (
    <ReactFlowProvider>
      <PipelineBuilderInner {...props} />
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
    (changes: NodeChange<FlowNode>[]) => setFlowNodes((ns) => applyNodeChanges<FlowNode>(changes, ns)),
    [],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange<FlowEdge>[]) => setFlowEdges((es) => applyEdgeChanges<FlowEdge>(changes, es)),
    [],
  );

  const onConnect: OnConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return;
      const id = `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const edge: PipelineEdge = { kind: 'linear', id, from: conn.source, to: conn.target };
      setFlowEdges((es) =>
        addEdge<FlowEdge>(
          {
            id,
            source: conn.source!,
            target: conn.target!,
            data: { pipelineEdge: edge },
            label: 'linear',
          },
          es,
        ),
      );
    },
    [],
  );

  // ─── Mutators applied to the underlying PipelineNode/Edge ────

  const updateNode = (nodeId: string, patch: Partial<PipelineNode>) => {
    setFlowNodes((ns) =>
      ns.map((n) => {
        if (n.id !== nodeId) return n;
        const merged: PipelineNode = { ...n.data.pipelineNode, ...patch };
        return {
          ...n,
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
          label: edgeLabel(next),
          source: next.from,
          target: next.to,
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

  const addNewNode = () => {
    const id = nextNodeId(flowNodes);
    const node: PipelineNode = {
      id,
      label: id,
      role: availableRoles[0] ?? 'subordinate',
      taskTemplate: '{{previous_output}}',
      branchMode: 'linear',
      position: { x: 200, y: 200 + flowNodes.length * 30 },
    };
    setFlowNodes((ns) => [...ns, toFlowNode(node)]);
  };

  // Sync flow positions back into the underlying node objects on
  // every render — without this, drag-drop changes would be lost on save.
  const flowNodesWithPos: FlowNode[] = useMemo(
    () =>
      flowNodes.map((n) => ({
        ...n,
        data: { pipelineNode: { ...n.data.pipelineNode, position: { x: n.position.x, y: n.position.y } } },
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

  const selectedNode = selected?.kind === 'node' ? flowNodes.find((n) => n.id === selected.id) : null;
  const selectedEdge = selected?.kind === 'edge' ? flowEdges.find((e) => e.id === selected.id) : null;

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-background">
      <header className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            <ChevronLeft className="h-3.5 w-3.5 mr-1" /> {t('agents:pipelines.back')}
          </Button>
          <Network className="h-4 w-4 text-muted-foreground" />
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-7 w-56 text-sm"
            placeholder={t('agents:pipelines.fieldName')}
          />
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="h-7 w-72 text-xs"
            placeholder={t('agents:pipelines.fieldDescription')}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={addNewNode}>
            + {t('agents:pipelines.addNode')}
          </Button>
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
        <div className="flex-1 relative">
          <ReactFlow<FlowNode, FlowEdge>
            nodes={flowNodes}
            edges={flowEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelected({ kind: 'node', id: n.id })}
            onEdgeClick={(_, e) => setSelected({ kind: 'edge', id: e.id })}
            onPaneClick={() => setSelected(null)}
            fitView
          >
            <Background />
            <MiniMap pannable zoomable />
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
    type: 'default',
    position: n.position ?? { x: 100, y: 100 },
    data: { pipelineNode: n, label: nodeLabel(n) } as NodeData,
    width: 180,
    style: {
      borderRadius: 8,
      padding: 6,
      fontSize: 12,
      width: 180,
    },
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
    label: edgeLabel(e),
    data: { pipelineEdge: e },
  }));
}

function nodeLabel(n: PipelineNode): string {
  const mode = n.branchMode && n.branchMode !== 'linear' ? ` · ${n.branchMode}` : '';
  return `${n.label}\n@${n.role}${mode}`;
}

function edgeLabel(e: PipelineEdge): string {
  switch (e.kind) {
    case 'linear':
      return '→';
    case 'pass-fail':
      return e.on === 'pass' ? '✓ pass' : '✗ fail';
    case 'by-tag':
      return `tag: ${e.tag}`;
    case 'by-text-match':
      return `match: ${e.pattern.slice(0, 16)}${e.pattern.length > 16 ? '…' : ''}`;
  }
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
