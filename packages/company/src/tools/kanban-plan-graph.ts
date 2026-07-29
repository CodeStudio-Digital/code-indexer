/**
 * kanban_plan_graph (C4) — one call plans a whole board: creates up to 30
 * cards with dependencies (a DAG) and per-card role hints, instead of the
 * kanban_create_card → kanban_add_dependency → … turn storm.
 *
 * Validation (ids, deps, cycles, cap) lives in the PURE core
 * (`kanban-plan-graph-core.ts`); this handler only maps local ids to real
 * card ids in topological order and applies the side effects:
 *   - `kanbanCreateCard` per node (column defaults to `backlog`);
 *   - `kanbanAddDependency(realId, realDepId)` per edge;
 *   - a `[role-hint: @x]` comment per hinted node — dispatch-card reads it
 *     as the preferred role before consulting the recommender.
 *
 * Per-item resilience after validation passes: one failed create reports
 * that node and skips its edges/hints; the rest of the graph still lands.
 * Name starts with `kanban_` so the master filter keeps it (see
 * master-filter.test.ts).
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { CompanyOrchestrator } from '@mcp/company/orchestrator.js';
import {
  PLAN_GRAPH_MAX_NODES,
  validatePlanGraph,
  type PlanGraphNode,
} from './kanban-plan-graph-core.js';

export function kanbanPlanGraphTool(orchestrator: CompanyOrchestrator): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      nodes: {
        type: 'array',
        description:
          `Work graph nodes (max ${PLAN_GRAPH_MAX_NODES}). Local \`id\`s are only used to wire ` +
          '`depends_on` edges inside THIS call; the result maps them to real card ids.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Local id, unique in this call (e.g. "auth-api").' },
            title: { type: 'string', description: 'Card title — concise task name.' },
            description: { type: 'string', description: 'Technical description of the task.' },
            role: { type: 'string', description: 'Suggested role — stored as a [role-hint: @x] comment; the dispatcher prefers it over the recommender.' },
            tag: { type: 'string', enum: ['bug', 'feature', 'refactor', 'documentation'], description: 'Task category tag.' },
            depends_on: { type: 'array', items: { type: 'string' }, description: 'Local ids this card is blocked by.' },
            column: { type: 'string', enum: ['backlog', 'todo'], description: 'Starting column (default: backlog).' },
          },
          required: ['id', 'title'],
        },
      },
    },
    required: ['nodes'],
  };

  return {
    name: 'kanban_plan_graph',
    description:
      'Plan a whole work graph in ONE call: creates multiple kanban cards with dependencies ' +
      '(validated as a DAG — cycles are rejected) and optional per-card role hints. Use this ' +
      'instead of a chain of kanban_create_card + kanban_add_dependency calls when you break ' +
      `an objective into tasks (max ${PLAN_GRAPH_MAX_NODES} nodes). Returns the real card id for each local id.`,
    parameters,
    source: 'native',
    handler: async (args) => {
      const nodes = args.nodes as PlanGraphNode[];
      const validation = validatePlanGraph(nodes);
      if (!validation.ok) return err(validation.error);

      const byLocalId = new Map(nodes.map((n) => [n.id.trim(), n]));
      const realIds = new Map<string, string>();
      const lines: string[] = [];
      let failures = 0;

      // Creation follows the topological order so every dependency edge
      // points at an already-created card.
      for (const localId of validation.order) {
        const node = byLocalId.get(localId)!;
        try {
          const card = orchestrator.kanbanCreateCard({
            title: node.title.trim(),
            description: node.description,
            column: node.column ?? 'backlog',
            tag: node.tag ?? null,
            created_by: 'master',
          });
          realIds.set(localId, card.id);
          const details: string[] = [];

          for (const dep of node.depends_on ?? []) {
            const realDep = realIds.get(dep.trim());
            if (realDep == null) { details.push(`dep "${dep}" skipped (blocker failed)`); continue; }
            try {
              orchestrator.kanbanAddDependency(card.id, realDep);
              details.push(`blocked by #${realDep}`);
            } catch (e) {
              details.push(`dep #${realDep} FAILED: ${e instanceof Error ? e.message : String(e)}`);
            }
          }

          const role = node.role?.trim();
          if (role) {
            try {
              orchestrator.kanbanAddComment(card.id, 'master', null, `[role-hint: @${role}]`);
              details.push(`role-hint @${role}`);
            } catch { details.push(`role-hint @${role} FAILED`); }
          }

          lines.push(
            `${localId} → #${card.id} "${card.title}" (${card.column})` +
            (details.length ? ` — ${details.join(', ')}` : ''),
          );
        } catch (e) {
          failures += 1;
          lines.push(`${localId} → FAILED: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      const summary =
        `${realIds.size}/${nodes.length} cards created${failures ? `, ${failures} failed` : ''}. ` +
        'Use the real ids with kanban_assign_agent / kanban_move_card / spawn_subordinate_agent(kanban_card_id).';
      const body = [summary, ...lines].join('\n');
      return failures === nodes.length ? err(body) : ok(body);
    },
  };
}
