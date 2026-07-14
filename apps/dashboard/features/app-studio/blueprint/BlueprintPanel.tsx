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
 * Conectar/editar vira mutação cirúrgica na spec. Salvar direto antes da
 * aprovação de Escopo; depois, "Aplicar mudanças" cria uma revisão e envia
 * a reconciliação seletiva ao coordenador. Duplo-clique remove uma ligação.
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
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AlertTriangle, LayoutDashboard, Loader2, RotateCcw, Save } from 'lucide-react';
import { calculateBlueprintAutoLayout, specToGraph } from '@mcp/app-studio/blueprint/spec-to-graph.js';
import type { BlueprintMutation } from '@mcp/app-studio/blueprint/mutations.js';
import type { BlueprintEdge, BlueprintNodeData } from '@mcp/app-studio/blueprint/types.js';
import { confirm } from '../../../components/ui/prompt-dialog.js';
import { Button } from '../../../components/ui/button.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip.js';
import type { AppStudioSessionDetail } from '../app-studio-api.js';
import { useBlueprint } from './useBlueprint.js';
import { BLUEPRINT_NODE_TYPES } from './BlueprintNodes.js';
import { NodePalette } from './NodePalette.js';
import { NodeInspector } from './NodeInspector.js';
import { SpecOverviewPanel } from './SpecOverviewPanel.js';

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

export function BlueprintPanel({
  detail,
  onChanged,
}: {
  detail: AppStudioSessionDetail;
  onChanged: () => void;
}) {
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
  const flowRef = useRef<ReactFlowInstance<RFNode, Edge> | null>(null);
  const fitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layoutRef = useRef(bp.layout);
  layoutRef.current = bp.layout;

  useEffect(() => () => {
    if (fitTimerRef.current) window.clearTimeout(fitTimerRef.current);
  }, []);

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
        // Cards explicam gatilhos, destinos e FKs; labels nas linhas apenas
        // repetem isso e viram ruido quando o mapa e reduzido.
        label: undefined,
        type: 'smoothstep',
        interactionWidth: 18,
        style: { strokeWidth: e.kind === 'behavior-target' ? 1.5 : 1.15, opacity: 0.68 },
        zIndex: e.kind === 'behavior-target' ? 1 : 0,
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

  const organizeMap = useCallback(() => {
    if (!bp.draft) return;
    const positions = calculateBlueprintAutoLayout(bp.draft);
    setNodes((current) => current.map((node) => ({ ...node, position: positions[node.id] ?? node.position })));
    bp.setNodePositions(positions);
    if (fitTimerRef.current) window.clearTimeout(fitTimerRef.current);
    fitTimerRef.current = window.setTimeout(() => {
      void flowRef.current?.fitView({ padding: 0.12, duration: 300 });
    }, 100);
  }, [bp.draft, bp.setNodePositions]);

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
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              aria-label={t('blueprint.organize')}
              onClick={organizeMap}
            >
              <LayoutDashboard className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('blueprint.organize')}</TooltipContent>
        </Tooltip>
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
          {bp.scopeApproved ? t('blueprint.apply') : t('blueprint.save')}
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
              onInit={(instance) => { flowRef.current = instance; }}
              nodeTypes={BLUEPRINT_NODE_TYPES}
              onNodesChange={onNodesChange}
              onNodeDragStop={onNodeDragStop}
              onConnect={onConnect}
              onEdgeDoubleClick={onEdgeDoubleClick}
              onNodeClick={(_, node) => setSelectedId(node.id)}
              onPaneClick={() => setSelectedId(null)}
              deleteKeyCode={null}
              minZoom={0.2}
              fitView
              fitViewOptions={{ padding: 0.12 }}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={18} />
              <MiniMap pannable zoomable className="!bg-card/80" />
              <Controls />
            </ReactFlow>
          </ReactFlowProvider>
        </div>
        {selectedData && bp.draft ? (
          <NodeInspector data={selectedData} spec={bp.draft} onMutate={bp.mutate} onClose={() => setSelectedId(null)} />
        ) : (
          <SpecOverviewPanel spec={bp.draft} />
        )}
      </div>
      <p className="shrink-0 border-t px-3 py-1 text-[10px] text-muted-foreground">{t('blueprint.hint')}</p>
    </div>
  );
}
