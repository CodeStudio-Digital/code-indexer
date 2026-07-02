/**
 * kanban_plan_graph — PURE validation core (C4).
 *
 * The master describes a whole work graph in one call: nodes with LOCAL ids,
 * optional role hints and `depends_on` edges between local ids. This module
 * validates the graph (unique ids, resolvable deps, acyclic) and returns the
 * creation order (dependencies first) so the impure handler can create the
 * cards and wire real-id dependencies in a single pass.
 *
 * No I/O, no orchestrator coupling — exhaustively unit-testable
 * (dispatch-core.ts pattern).
 */
import type { KanbanTag } from '@mcp/company/types.js';

export const PLAN_GRAPH_MAX_NODES = 30;

const VALID_TAGS: ReadonlySet<string> = new Set(['bug', 'feature', 'refactor', 'documentation']);
const VALID_COLUMNS: ReadonlySet<string> = new Set(['backlog', 'todo']);

export interface PlanGraphNode {
  /** Local id, unique inside this call (e.g. "auth-api"). */
  id: string;
  title: string;
  description?: string;
  /** Role hint — written to the card as a `[role-hint: @x]` comment. */
  role?: string;
  tag?: KanbanTag;
  /** Local ids this node depends on (its blockers). */
  depends_on?: string[];
  /** Cards are planning artifacts: only pre-work columns are allowed. */
  column?: 'backlog' | 'todo';
}

export type PlanGraphValidation =
  | { ok: true; order: string[] }
  | { ok: false; error: string };

/** Structural pre-check of one raw node. Returns the error or null. */
function nodeError(node: unknown, index: number): string | null {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    return `nodes[${index}] must be an object.`;
  }
  const n = node as Record<string, unknown>;
  if (typeof n.id !== 'string' || !n.id.trim()) {
    return `nodes[${index}].id must be a non-empty string.`;
  }
  if (typeof n.title !== 'string' || !n.title.trim()) {
    return `nodes[${index}] ("${String(n.id)}"): title must be a non-empty string.`;
  }
  if (n.tag != null && !VALID_TAGS.has(String(n.tag))) {
    return `nodes[${index}] ("${String(n.id)}"): tag must be one of ${[...VALID_TAGS].join(', ')}.`;
  }
  if (n.column != null && !VALID_COLUMNS.has(String(n.column))) {
    return `nodes[${index}] ("${String(n.id)}"): column must be 'backlog' or 'todo'.`;
  }
  if (n.depends_on !== undefined
      && (!Array.isArray(n.depends_on) || n.depends_on.some((d) => typeof d !== 'string'))) {
    return `nodes[${index}] ("${String(n.id)}"): depends_on must be an array of local ids.`;
  }
  return null;
}

/**
 * Validate the graph and return the creation order (topological —
 * dependencies before dependents) so `kanban_add_dependency` always points
 * at an already-created card.
 */
export function validatePlanGraph(nodes: ReadonlyArray<PlanGraphNode>): PlanGraphValidation {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { ok: false, error: 'nodes must be a non-empty array.' };
  }
  if (nodes.length > PLAN_GRAPH_MAX_NODES) {
    return {
      ok: false,
      error: `Too many nodes (${nodes.length}, max ${PLAN_GRAPH_MAX_NODES}). Split the plan.`,
    };
  }

  const byId = new Map<string, PlanGraphNode>();
  for (let i = 0; i < nodes.length; i++) {
    const structural = nodeError(nodes[i], i);
    if (structural) return { ok: false, error: structural };
    const id = nodes[i].id.trim();
    if (byId.has(id)) return { ok: false, error: `Duplicate node id "${id}".` };
    byId.set(id, nodes[i]);
  }

  // Resolve deps + reject self-dependency up front.
  for (const node of nodes) {
    for (const dep of node.depends_on ?? []) {
      const depId = dep.trim();
      if (!byId.has(depId)) {
        return { ok: false, error: `Node "${node.id}" depends on unknown id "${depId}".` };
      }
      if (depId === node.id.trim()) {
        return { ok: false, error: `Node "${node.id}" cannot depend on itself.` };
      }
    }
  }

  // Iterative DFS with tri-color marking: cycle detection + topological order.
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const order: string[] = [];
  for (const id of byId.keys()) color.set(id, WHITE);

  for (const rootId of byId.keys()) {
    if (color.get(rootId) !== WHITE) continue;
    const stack: Array<{ id: string; depIndex: number }> = [{ id: rootId, depIndex: 0 }];
    color.set(rootId, GRAY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const deps = (byId.get(frame.id)?.depends_on ?? []).map((d) => d.trim());
      if (frame.depIndex < deps.length) {
        const depId = deps[frame.depIndex++];
        const c = color.get(depId);
        if (c === GRAY) {
          return { ok: false, error: `Dependency cycle detected involving "${depId}".` };
        }
        if (c === WHITE) {
          color.set(depId, GRAY);
          stack.push({ id: depId, depIndex: 0 });
        }
      } else {
        color.set(frame.id, BLACK);
        order.push(frame.id); // post-order → dependencies first
        stack.pop();
      }
    }
  }

  return { ok: true, order };
}
