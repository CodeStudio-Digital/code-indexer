import type { Edge, Node } from '@xyflow/react';
import type { WorkerLogEntry } from '../../hooks/agent-stream/types.js';

interface ExecNodeData extends Record<string, unknown> {
  label: string;
  status: string;
  detail: Record<string, unknown>;
}

export type ExecNode = Node<ExecNodeData>;

export function buildExecutionGraph(entries: readonly WorkerLogEntry[]): {
  nodes: ExecNode[];
  edges: Edge[];
  relatedEvents: Map<string, WorkerLogEntry[]>;
} {
  const nodes = new Map<string, ExecNode>();
  const edges = new Map<string, Edge>();
  const relatedEvents = new Map<string, WorkerLogEntry[]>();
  upsertNode(nodes, 'run', 'Run', 'running', 0, 0, {});

  for (const entry of entries) {
    const data = asRecord(entry.data);
    if (entry.event === 'agents_group_start') {
      const groupId = String(data.groupId ?? 'agents');
      upsertNode(nodes, `group:${groupId}`, `${agentCount(data)} agents`, 'running', 260, 0, data);
      addEdge(edges, 'run', `group:${groupId}`);
      addRelated(relatedEvents, `group:${groupId}`, entry);
      const agents = Array.isArray(data.agents) ? data.agents : [];
      agents.forEach((raw, i) => {
        const agent = asRecord(raw);
        const id = `agent:${groupId}:${String(agent.index ?? i)}`;
        upsertNode(nodes, id, String(agent.label ?? `Agent ${i + 1}`), 'pending', 520, i * 105, agent);
        addEdge(edges, `group:${groupId}`, id);
        addRelated(relatedEvents, id, entry);
      });
    }
    if (entry.event === 'agent_progress') {
      const groupId = String(data.groupId ?? 'agents');
      const index = String(data.agentIndex ?? 0);
      const id = `agent:${groupId}:${index}`;
      upsertNode(
        nodes,
        id,
        String(data.label ?? `Agent ${index}`),
        String(data.status ?? data.event ?? 'running'),
        520,
        Number(index) * 105,
        data,
      );
      addEdge(edges, `group:${groupId}`, id);
      addRelated(relatedEvents, id, entry);
      addRelated(relatedEvents, `group:${groupId}`, entry);
    }
    if (entry.event.startsWith('operation_')) {
      const opId = String(data.opId ?? entry.event);
      const id = `op:${opId}`;
      const kind = String(data.kind ?? 'op');
      upsertNode(nodes, id, `${kind}: ${String(data.label ?? opId)}`, String(data.status ?? 'running'), 780, nodes.size * 70, data);
      addEdge(edges, data.parentOpId ? `op:${String(data.parentOpId)}` : 'run', id);
      addRelated(relatedEvents, id, entry);
    }
    if (entry.event.startsWith('tool_')) {
      const toolId = String(data.id ?? data.name ?? entry.event);
      const id = `tool:${toolId}`;
      upsertNode(nodes, id, `tool: ${String(data.name ?? toolId)}`, toolStatus(entry.event, data), 780, nodes.size * 70, data);
      addEdge(edges, 'run', id);
      addRelated(relatedEvents, id, entry);
    }
  }

  if (entries.some((e) => e.event === 'done' || e.event === 'error')) {
    const run = nodes.get('run');
    if (run) run.data = { ...run.data, status: 'completed' };
  }
  return { nodes: Array.from(nodes.values()), edges: Array.from(edges.values()), relatedEvents };
}

function upsertNode(
  nodes: Map<string, ExecNode>,
  id: string,
  label: string,
  status: string,
  x: number,
  y: number,
  detail: Record<string, unknown>,
): void {
  const prev = nodes.get(id);
  nodes.set(id, {
    id,
    position: prev?.position ?? { x, y },
    data: { label, status, detail: { ...(prev?.data.detail ?? {}), ...detail } },
    className: nodeClass(status),
  });
}

function addEdge(edges: Map<string, Edge>, source: string, target: string): void {
  if (source === target) return;
  const id = `${source}->${target}`;
  if (!edges.has(id)) edges.set(id, { id, source, target, animated: true });
}

function addRelated(map: Map<string, WorkerLogEntry[]>, id: string, entry: WorkerLogEntry): void {
  const list = map.get(id) ?? [];
  list.push(entry);
  map.set(id, list.slice(-50));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function agentCount(data: Record<string, unknown>): number {
  return Array.isArray(data.agents) ? data.agents.length : 0;
}

function toolStatus(event: string, data: Record<string, unknown>): string {
  if (event === 'tool_call_result') return asRecord(data.result).isError ? 'error' : 'completed';
  return 'running';
}

function nodeClass(status: string): string {
  if (status === 'completed' || status === 'done') return 'border border-emerald-500 bg-emerald-950/20 text-xs p-2 rounded';
  if (status === 'error' || status === 'failed' || status === 'timed_out' || status === 'aborted') {
    return 'border border-red-500 bg-red-950/20 text-xs p-2 rounded';
  }
  return 'border border-amber-500 bg-amber-950/20 text-xs p-2 rounded';
}
