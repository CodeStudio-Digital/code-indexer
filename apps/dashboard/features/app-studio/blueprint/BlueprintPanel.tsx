/**
 * Aba "Mapa" — o canvas Blueprint (React Flow) sobre a AppSpec.
 *
 * Modelo de estado (anti-flicker): a ESTRUTURA vem da spec (specToGraph)
 * e re-seeda o estado local de nós/edges SÓ quando o draft muda
 * (mutação/reload). O DRAG flui inteiro pelo estado local via
 * `applyNodeChanges` (barato, in-place) — nunca re-deriva o grafo por
 * frame — e a posição persiste apenas no drag-stop (layout + PUT
 * debounced). Round-trip de posição por mousemove foi a causa do flicker.
 *
 * Conectar/editar vira mutação cirúrgica na spec. Salvar direto quando o
 * discovery está destravado; "Aplicar mudanças" (reopen + reconcile via
 * chat) quando travado. Duplo-clique numa ligação remove (com confirm).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  applyNodeChanges,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AlertTriangle, Loader2, RotateCcw, Save } from 'lucide-react';
import { specToGraph } from '@mcp/app-studio/blueprint/spec-to-graph.js';
import type { BlueprintMutation } from '@mcp/app-studio/blueprint/mutations.js';
import type { BlueprintEdge, BlueprintNodeData } from '@mcp/app-studio/blueprint/types.js';
import { confirm } from '../../../components/ui/prompt-dialog.js';
import { Button } from '../../../components/ui/button.js';
import type { AppStudioSessionDetail } from '../app-studio-api.js';
import { useBlueprint } from './useBlueprint.js';
import { BLUEPRINT_NODE_TYPES } from './BlueprintNodes.js';
import { NodePalette } from './NodePalette.js';
import { NodeInspector } from './NodeInspector.js';

type RFNode = Node<BlueprintNodeData & Record<string, unknown>>;

/** Conexão nova (par de kinds pelos prefixos dos ids) → mutação. */
function connectionMutation(source: string, target: string): BlueprintMutation | null {
  const kind = (id: string): string => (id === 'auth' ? 'auth' : id.split(':')[0]);
  const ref = (id: string): string => id.slice(id.indexOf(':') + 1);
  const pair = `${kind(source)}->${kind(target)}`;
  switch (pair) {
    case 'feature->screen': return { op: 'connect-feature-screen', feature_id: ref(source), screen_id: ref(target) };
    case 'auth->screen': return { op: 'protect-screen', screen_id: ref(target) };
    case 'entity->entity': return { op: 'set-field-reference', entity: ref(source), target: ref(target) };
    case 'behavior->entity': return { op: 'add-behavior-action', behavior_id: ref(source), action: { kind: 'save', entity: ref(target) } };
    case 'behavior->screen': return { op: 'add-behavior-action', behavior_id: ref(source), action: { kind: 'navigate', screen_id: ref(target) } };
    default: return null;
  }
}

/** Duplo-clique numa edge → mutação de desligamento (null = não removível aqui). */
function edgeRemovalMutation(edge: BlueprintEdge): BlueprintMutation | null {
  const parts = edge.id.split(':');
  switch (edge.kind) {
    case 'feature-screen': return { op: 'disconnect-feature-screen', feature_id: parts[2], screen_id: parts[3] };
    case 'auth-screen': return { op: 'unprotect-screen', screen_id: parts[2] };
    case 'entity-ref': return { op: 'update-field', entity: parts[2], field: parts[3], patch: { references: null } };
    case 'behavior-target': return { op: 'remove-behavior-action', behavior_id: parts[2], index: Number(parts[4]) };
    default: return null; // screen-behavior: remova pelo painel do nó
  }
}

export function BlueprintPanel({ detail, onChanged }: { detail: AppStudioSessionDetail; onChanged: () => void }) {
  const { t } = useTranslation('appStudio');
  const bp = useBlueprint(detail, t, onChanged);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Estado LOCAL do canvas — o drag vive aqui (applyNodeChanges), nunca
  // no ciclo spec→grafo. Refs espelham o estado para o re-seed ler as
  // posições correntes sem entrar nas dependências do efeito.
  const [nodes, setNodes] = useState<RFNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [bpEdges, setBpEdges] = useState<BlueprintEdge[]>([]);
  const nodesRef = useRef<RFNode[]>([]);
  nodesRef.current = nodes;
  const layoutRef = useRef(bp.layout);
  layoutRef.current = bp.layout;

  // Re-seed SÓ quando a ESTRUTURA muda (mutação/reload/troca de sessão).
  // Posições correntes do canvas vencem (o usuário pode estar organizando);
  // depois vem o layout salvo; por último o auto-layout em colunas.
  useEffect(() => {
    if (!bp.draft) {
      setNodes([]);
      setEdges([]);
      setBpEdges([]);
      return;
    }
    const current = new Map(nodesRef.current.map((n) => [n.id, n.position]));
    const graph = specToGraph(bp.draft, layoutRef.current);
    setNodes(
      graph.nodes.map((n) => ({
        ...n,
        position: current.get(n.id) ?? n.position,
        data: n.data as RFNode['data'],
      })),
    );
    setBpEdges(graph.edges);
    setEdges(
      graph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label,
        animated: e.kind === 'behavior-target',
      })),
    );
  }, [bp.draft]);

  // Drag/seleção: mudanças aplicadas in-place no estado local (padrão RF).
  const onNodesChange = useCallback((changes: NodeChange<RFNode>[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  // Persistência da posição SÓ no fim do drag (layout + PUT debounced).
  const onNodeDragStop = useCallback(
    (_: unknown, node: RFNode) => {
      bp.setNodePosition(node.id, node.position);
    },
    [bp],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return;
      const m = connectionMutation(conn.source, conn.target);
      if (m) void bp.mutate(m);
    },
    [bp],
  );

  const onEdgeDoubleClick = useCallback(
    (_: unknown, edge: Edge) => {
      const bpEdge = bpEdges.find((e) => e.id === edge.id);
      if (!bpEdge) return;
      const m = edgeRemovalMutation(bpEdge);
      if (!m) return;
      void confirm({ title: t('blueprint.removeEdgeTitle'), confirmLabel: t('blueprint.inspector.remove') }).then(
        (go) => go && void bp.mutate(m),
      );
    },
    [bpEdges, bp, t],
  );

  const selectedData = (nodes.find((n) => n.id === selectedId)?.data ?? null) as
    | (RFNode['data'] & BlueprintNodeData)
    | null;

  if (!bp.draft) {
    return <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">{t('blueprint.noSpec')}</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-2 py-1.5">
        <NodePalette spec={bp.draft} onMutate={bp.mutate} />
        <div className="min-w-4 flex-1" />
        {bp.issues.length > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-amber-600" title={bp.issues.join('\n')}>
            <AlertTriangle className="h-3 w-3" /> {t('blueprint.issues', { count: bp.issues.length })}
          </span>
        )}
        {bp.dirty && (
          <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={bp.busy} onClick={bp.reload}>
            <RotateCcw className="mr-1 h-3 w-3" /> {t('blueprint.discard')}
          </Button>
        )}
        <Button size="sm" className="h-7 text-xs" disabled={!bp.dirty || bp.busy || bp.issues.length > 0} onClick={() => void bp.save()}>
          {bp.busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Save className="mr-1 h-3 w-3" />}
          {bp.discoveryApproved ? t('blueprint.apply') : t('blueprint.save')}
        </Button>
      </div>

      {bp.conflict && (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-400/40 bg-amber-500/10 px-3 py-1.5 text-xs">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
          <span className="min-w-0 flex-1">{t('blueprint.conflictBody')}</span>
          <Button size="sm" variant="outline" className="h-6 text-[11px]" onClick={bp.reload}>
            {t('blueprint.conflictReload')}
          </Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1">
          <ReactFlowProvider>
            <ReactFlow<RFNode, Edge>
              nodes={nodes}
              edges={edges}
              nodeTypes={BLUEPRINT_NODE_TYPES}
              onNodesChange={onNodesChange}
              onNodeDragStop={onNodeDragStop}
              onConnect={onConnect}
              onEdgeDoubleClick={onEdgeDoubleClick}
              onNodeClick={(_, node) => setSelectedId(node.id)}
              onPaneClick={() => setSelectedId(null)}
              deleteKeyCode={null}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={18} />
              <MiniMap pannable zoomable className="!bg-card/80" />
              <Controls />
            </ReactFlow>
          </ReactFlowProvider>
        </div>
        {selectedData && bp.draft && (
          <NodeInspector data={selectedData} spec={bp.draft} onMutate={bp.mutate} onClose={() => setSelectedId(null)} />
        )}
      </div>
      <p className="shrink-0 border-t px-3 py-1 text-[10px] text-muted-foreground">{t('blueprint.hint')}</p>
    </div>
  );
}
