/**
 * PipelineService — CRUD + pure graph validator over the pipeline tables.
 *
 * The validator is intentionally separated from execution so it can be
 * called from the dashboard (live as the user edits) and from the
 * `start_pipeline` tool without spinning up a `PipelineExecutor`.
 *
 * The orchestrator exposes thin wrappers (`pipelineList`, `pipelineGet`,
 * etc.) so HTTP routes and master tools never depend on this class
 * directly — same pattern as `KanbanService`.
 */

import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type {
  Pipeline,
  PipelineEdge,
  PipelineGraph,
  PipelineId,
  PipelineNode,
} from '@mcp/company/types.js';

export interface PipelineValidationIssue {
  /** Set when the issue is anchored to a specific node. */
  nodeId?: string;
  /** Set when the issue is anchored to a specific edge. */
  edgeId?: string;
  message: string;
}

export interface PipelineValidationResult {
  ok: boolean;
  errors: PipelineValidationIssue[];
}

export class PipelineService {
  constructor(private readonly ctx: SessionContext) {}

  // ─── CRUD ──────────────────────────────────────────────────────

  list(opts?: {
    /** When set, returns pipelines bound to this session OR globals (NULL). */
    companySessionId?: string | null;
    templateId?: number | null;
  }): Promise<Pipeline[]> {
    return this.ctx.companyStore.listPipelines(opts);
  }

  get(id: PipelineId): Promise<Pipeline | null> {
    return this.ctx.companyStore.getPipeline(id);
  }

  create(input: {
    name: string;
    description?: string;
    graph: PipelineGraph;
    companySessionId?: string | null;
    templateId?: number | null;
  }): Promise<Pipeline> {
    return this.ctx.companyStore.createPipeline(input);
  }

  update(
    id: PipelineId,
    patch: { name?: string; description?: string; graph?: PipelineGraph },
    opts?: { expectedVersion?: number },
  ): Promise<Pipeline | null> {
    return this.ctx.companyStore.updatePipeline(id, patch, opts);
  }

  delete(id: PipelineId): Promise<boolean> {
    return this.ctx.companyStore.deletePipeline(id);
  }

  // ─── Validator ────────────────────────────────────────────────

  /**
   * Pure validation over a graph definition. `validRoles` is the set of
   * roles configured for the session — passed in so this method has no
   * dependency on the master/orchestrator and stays trivially testable.
   * Pass `null` to skip the role check (useful when validating templates
   * not yet bound to a session).
   */
  validate(graph: PipelineGraph, validRoles: ReadonlySet<string> | null): PipelineValidationResult {
    return validatePipelineGraph(graph, validRoles);
  }
}

/**
 * Standalone validator. Exported so unit tests can hit it directly without
 * instantiating the full service.
 */
export function validatePipelineGraph(
  graph: PipelineGraph,
  validRoles: ReadonlySet<string> | null,
): PipelineValidationResult {
  const errors: PipelineValidationIssue[] = [];

  if (graph.version !== 1) {
    errors.push({ message: `Unsupported pipeline graph version ${graph.version}; expected 1.` });
  }
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    errors.push({ message: 'Pipeline must have at least one node.' });
    return { ok: false, errors };
  }
  if (!Array.isArray(graph.edges)) {
    errors.push({ message: 'Pipeline edges must be an array.' });
    return { ok: false, errors };
  }

  const nodeIds = new Set<string>();
  const nodesById = new Map<string, PipelineNode>();
  for (const node of graph.nodes) {
    if (!node.id || typeof node.id !== 'string') {
      errors.push({ message: 'Node is missing a string id.' });
      continue;
    }
    if (nodeIds.has(node.id)) {
      errors.push({ nodeId: node.id, message: `Duplicate node id "${node.id}".` });
      continue;
    }
    nodeIds.add(node.id);
    nodesById.set(node.id, node);
    const kind = node.kind ?? 'agent';
    if (!node.role || typeof node.role !== 'string') {
      errors.push({ nodeId: node.id, message: `Node "${node.id}" is missing role.` });
    } else if (validRoles && !validRoles.has(node.role) && kind !== 'validate') {
      // Validators don't dispatch to a role-bound subordinate, so an
      // unknown role on a validator is harmless. We still leave the
      // field on the node so the dashboard list view stays consistent.
      errors.push({
        nodeId: node.id,
        message: `Node "${node.id}" references unknown role "${node.role}".`,
      });
    }
    if (!node.taskTemplate || typeof node.taskTemplate !== 'string') {
      errors.push({ nodeId: node.id, message: `Node "${node.id}" is missing taskTemplate.` });
    }
    if (typeof node.maxAttempts === 'number' && node.maxAttempts < 1) {
      errors.push({ nodeId: node.id, message: `Node "${node.id}" maxAttempts must be ≥ 1.` });
    }
    if (kind === 'validate') {
      if (node.branchMode && node.branchMode !== 'pass-fail') {
        errors.push({
          nodeId: node.id,
          message: `Validator node "${node.id}" must use branchMode='pass-fail' (got '${node.branchMode}').`,
        });
      }
      if (!node.validatorPrompt || typeof node.validatorPrompt !== 'string' || !node.validatorPrompt.trim()) {
        errors.push({
          nodeId: node.id,
          message: `Validator node "${node.id}" requires a non-empty validatorPrompt.`,
        });
      }
    }
    if (kind === 'fan-out') {
      if (node.branchMode && node.branchMode !== 'linear') {
        errors.push({
          nodeId: node.id,
          message: `Fan-out node "${node.id}" must use branchMode='linear' (got '${node.branchMode}').`,
        });
      }
      const fo = node.fanOut;
      if (!fo || (fo.mode !== 'explicit' && fo.mode !== 'each-project')) {
        errors.push({ nodeId: node.id, message: `Fan-out node "${node.id}" requires fanOut.mode 'explicit' or 'each-project'.` });
      } else if (fo.mode === 'explicit') {
        if (!Array.isArray(fo.branches) || fo.branches.length === 0) {
          errors.push({ nodeId: node.id, message: `Fan-out node "${node.id}" (explicit) needs at least one branch.` });
        } else if (fo.branches.some((b) => !b.role || typeof b.role !== 'string')) {
          errors.push({ nodeId: node.id, message: `Every branch of fan-out node "${node.id}" needs a role.` });
        }
      } else if (fo.mode === 'each-project' && (!fo.role || typeof fo.role !== 'string')) {
        errors.push({ nodeId: node.id, message: `Fan-out node "${node.id}" (each-project) requires fanOut.role.` });
      }
    }
  }

  const edgeIds = new Set<string>();
  const passByFrom = new Map<string, number>();
  const failByFrom = new Map<string, number>();
  const reviewByFrom = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!edge.id || typeof edge.id !== 'string') {
      errors.push({ message: 'Edge is missing a string id.' });
      continue;
    }
    if (edgeIds.has(edge.id)) {
      errors.push({ edgeId: edge.id, message: `Duplicate edge id "${edge.id}".` });
      continue;
    }
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.from)) {
      errors.push({ edgeId: edge.id, message: `Edge "${edge.id}" from-node "${edge.from}" not found.` });
    }
    if (!nodeIds.has(edge.to)) {
      errors.push({ edgeId: edge.id, message: `Edge "${edge.id}" to-node "${edge.to}" not found.` });
    }
    if (edge.kind === 'pass-fail') {
      const map =
        edge.on === 'pass' ? passByFrom : edge.on === 'fail' ? failByFrom : reviewByFrom;
      map.set(edge.from, (map.get(edge.from) ?? 0) + 1);
      // A 'review' verdict is only emitted by validator-kind nodes. Edge
      // routing for it on a non-validator from-node is unreachable at
      // runtime — flag it so the author catches the mistake before the
      // execution starts.
      if (edge.on === 'review') {
        const fromNode = nodesById.get(edge.from);
        if (fromNode && (fromNode.kind ?? 'agent') !== 'validate') {
          errors.push({
            edgeId: edge.id,
            message: `Edge "${edge.id}" with on='review' must originate from a validator node ("${edge.from}" is kind='${fromNode.kind ?? 'agent'}').`,
          });
        }
      }
    }
  }

  for (const [from, count] of passByFrom) {
    if (count > 1) {
      errors.push({ nodeId: from, message: `Node "${from}" has more than one 'pass' branch.` });
    }
  }
  for (const [from, count] of failByFrom) {
    if (count > 1) {
      errors.push({ nodeId: from, message: `Node "${from}" has more than one 'fail' branch.` });
    }
  }
  for (const [from, count] of reviewByFrom) {
    if (count > 1) {
      errors.push({ nodeId: from, message: `Node "${from}" has more than one 'review' branch.` });
    }
  }

  // Determine the start node — explicit takes precedence.
  if (graph.startNodeId) {
    if (!nodeIds.has(graph.startNodeId)) {
      errors.push({ message: `startNodeId "${graph.startNodeId}" not found in nodes.` });
    }
  } else {
    const incoming = new Map<string, number>();
    for (const node of graph.nodes) incoming.set(node.id, 0);
    for (const edge of graph.edges) {
      if (incoming.has(edge.to)) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    }
    const roots = [...incoming.entries()].filter(([, c]) => c === 0).map(([id]) => id);
    if (roots.length === 0) {
      errors.push({ message: 'No root node found (every node has an incoming edge). Set startNodeId or break a cycle.' });
    } else if (roots.length > 1) {
      errors.push({
        message: `Multiple root nodes [${roots.join(', ')}]; set startNodeId explicitly.`,
      });
    }
  }

  // Cycles are allowed only when reached through a conditional edge
  // (`pass-fail` on='fail', `by-tag`, or `by-text-match`). A pure
  // `linear`-only cycle would never escape — flag it.
  const cycle = findForbiddenCycle(graph);
  if (cycle) {
    errors.push({ message: `Forbidden cycle detected: ${cycle.join(' → ')}. Pure linear cycles never terminate; route at least one back-edge through a conditional branch.` });
  }

  return { ok: errors.length === 0, errors };
}

/**
 * DFS over `linear` edges only. Any cycle reachable through that
 * subgraph is forbidden — it would loop forever with no condition to
 * exit through. Cycles that include at least one conditional
 * (`pass-fail` on='fail', `by-tag`, `by-text-match`) edge are allowed
 * because the executor's `maxAttempts` guard caps them.
 */
function findForbiddenCycle(graph: PipelineGraph): string[] | null {
  const adj = new Map<string, Array<{ to: string; edge: PipelineEdge }>>();
  for (const node of graph.nodes) adj.set(node.id, []);
  for (const edge of graph.edges) {
    if (edge.kind !== 'linear') continue;
    adj.get(edge.from)?.push({ to: edge.to, edge });
  }
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();
  for (const node of graph.nodes) color.set(node.id, WHITE);

  const dfs = (start: string): string[] | null => {
    const stack: Array<{ id: string; iter: Iterator<{ to: string; edge: PipelineEdge }> }> = [];
    color.set(start, GREY);
    parent.set(start, null);
    stack.push({ id: start, iter: (adj.get(start) ?? [])[Symbol.iterator]() });
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const next = top.iter.next();
      if (next.done) {
        color.set(top.id, BLACK);
        stack.pop();
        continue;
      }
      const child = next.value.to;
      const c = color.get(child) ?? WHITE;
      if (c === WHITE) {
        color.set(child, GREY);
        parent.set(child, top.id);
        stack.push({ id: child, iter: (adj.get(child) ?? [])[Symbol.iterator]() });
      } else if (c === GREY) {
        const path: string[] = [child];
        let cur: string | null = top.id;
        while (cur && cur !== child) { path.push(cur); cur = parent.get(cur) ?? null; }
        path.push(child);
        return path.reverse();
      }
    }
    return null;
  };

  for (const node of graph.nodes) {
    if (color.get(node.id) === WHITE) {
      const cycle = dfs(node.id);
      if (cycle) return cycle;
    }
  }
  return null;
}

/**
 * Resolve the start node from a graph: explicit `startNodeId` if set,
 * else the unique node with no incoming edge. Returns null when no
 * single root exists (validator already rejects this case).
 */
export function resolveStartNode(graph: PipelineGraph): PipelineNode | null {
  if (graph.startNodeId) {
    return graph.nodes.find((n) => n.id === graph.startNodeId) ?? null;
  }
  const incoming = new Map<string, number>();
  for (const node of graph.nodes) incoming.set(node.id, 0);
  for (const edge of graph.edges) {
    if (incoming.has(edge.to)) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }
  const roots = [...incoming.entries()].filter(([, c]) => c === 0).map(([id]) => id);
  if (roots.length !== 1) return null;
  return graph.nodes.find((n) => n.id === roots[0]) ?? null;
}

/**
 * Render a node task template with the standard placeholders. V0 uses
 * three slots: `{{initial_input}}`, `{{previous_output}}`, and
 * `{{vars.<nodeId>.output}}`. Anything else is left literal so node
 * authors can include curly braces in instructions safely.
 */
export function renderNodeTask(args: {
  template: string;
  initialInput: string;
  previousOutput: string;
  vars: Record<string, { output?: string; outcome?: string }>;
}): string {
  let out = args.template;
  out = out.replace(/\{\{\s*initial_input\s*\}\}/g, args.initialInput);
  out = out.replace(/\{\{\s*previous_output\s*\}\}/g, args.previousOutput);
  out = out.replace(/\{\{\s*vars\.([\w-]+)\.output\s*\}\}/g, (_m, nodeId: string) => {
    return args.vars[nodeId]?.output ?? '';
  });
  return out;
}
