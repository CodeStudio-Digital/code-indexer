/**
 * Company recommendations — non-blocking endpoints the dashboard or master
 * agent can hit to get pipeline-backed suggestions.
 *
 *   POST /api/company/sessions/:id/recommend-role
 *     body: { task: string }
 *     → { recommendations: [{ role, kind, agentRunId?, score, signals }] }
 *
 *   POST /api/company/sessions/:id/kanban/recompute-priorities
 *     → { ordered: KanbanCardInput[], diagnostics: [...] }
 *
 * These are READ-side endpoints: they observe current session state, run a
 * pipeline, and return the result. No mutations to durable storage — the
 * caller decides what to do with the recommendation.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam } from '../_helpers.js';
import { recommendRolesForSession } from './recommend-core.js';
import {
  createKanbanPriorityPipeline,
  prioritizeKanban,
  type KanbanCardInput,
  type KanbanColumn,
  type KanbanTag,
} from '@mcp/company/kanban-priority/index.js';

/** FNV-1a hash — matches the hash used by the ToolSelection shadow producer
 *  so role-pipeline shadow rows correlate cleanly with future analytics. */
function fnv1aHash(text: string): string {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16);
}

export function mountCompanyRecommendationsRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore, pipelineTelemetrySink } = deps;

  // ─── POST /api/company/sessions/:id/recommend-role ──────────────────
  app.post('/api/company/sessions/:id/recommend-role', async (c) => {
    const sessionId = parseIdParam(c);
    let body: { task?: string; k?: number };
    try { body = (await c.req.json()) as typeof body; }
    catch { return c.json({ error: 'invalid_json' }, 400); }
    if (!body.task || typeof body.task !== 'string') {
      return c.json({ error: 'task is required' }, 400);
    }

    const session = companyStore.getCompanySession(sessionId);
    if (!session) return c.json({ error: 'session_not_found' }, 404);

    // Shared "brain" — the SAME pipeline run the autonomous scheduler uses via
    // the worker→main `recommend` shim (recommend-core.ts), so dashboard and
    // scheduler never drift apart.
    const result = await recommendRolesForSession(deps, {
      companySessionId: sessionId,
      taskText: body.task,
      k: body.k,
    });

    // Shadow producer for the role pipeline — fires a counterfactual
    // row with `pipeline_name='role_pipeline'` so the feedback collector
    // can later record what role the master ACTUALLY spawned. The
    // `queryHash` is the same FNV-1a we use for tool-selection: stable
    // across endpoint and spawn observer.
    try {
      const queryHash = fnv1aHash(body.task);
      deps.toolSelectionShadowRunner; // (unused — distinct runner per pipeline)
      deps.feedbackCollector; // ensure imported
      // We use the counterfactual store directly here because the role
      // pipeline doesn't have its own ShadowTrafficRunner instance yet
      // (the ToolSelection one is per-pipeline). Insert a single row
      // representing the production choice.
      if (result.recommendations.length > 0) {
        deps.counterfactualLogStore.insert({
          session_id: null,
          company_session_id: sessionId,
          pipeline_name: 'role_pipeline',
          shadow_variant: 'production',
          query_hash: queryHash,
          production_choice: {
            recommendations: result.recommendations.map((r) => ({
              role: r.role,
              kind: r.kind,
              score: r.score,
            })),
          },
          shadow_prediction: null,
        });
      }
    } catch {
      // Counterfactual logging must never break the response.
    }

    return c.json(result);
  });

  // ─── POST /api/company/sessions/:id/kanban/recompute-priorities ─────
  app.post('/api/company/sessions/:id/kanban/recompute-priorities', async (c) => {
    const sessionId = parseIdParam(c);
    const session = companyStore.getCompanySession(sessionId);
    if (!session) return c.json({ error: 'session_not_found' }, 404);

    const cardsFull = companyStore.listKanbanCardsFull(sessionId);
    // Build a reverse-blocks map: who does each card block? Iterate all
    // dependencies once to construct it efficiently.
    const blocksMap = new Map<number, number[]>();
    for (const card of cardsFull) {
      for (const dep of card.dependencies) {
        // `dep` lives on this card and points to `depends_on_id` — so
        // `depends_on_id` BLOCKS this card. Reverse: depends_on_id → [card.id].
        const list = blocksMap.get(dep.depends_on_id) ?? [];
        list.push(card.id);
        blocksMap.set(dep.depends_on_id, list);
      }
    }
    const cards: KanbanCardInput[] = cardsFull.map((card) => ({
      id: card.id,
      title: card.title,
      description: card.description ?? '',
      column: card.column as KanbanColumn,
      tag: (card.tag ?? null) as KanbanTag,
      blocks: blocksMap.get(card.id) ?? [],
      blockedBy: card.blocked_by ?? [],
      assignedRoles: (card.agents ?? []).map((a) => a.role),
      createdAtMs: card.created_at ? new Date(card.created_at).getTime() : undefined,
      columnUpdatedAtMs: card.updated_at ? new Date(card.updated_at).getTime() : undefined,
    }));

    // Idle roles drive the role-availability boost.
    const activeRuns = companyStore.listAgentRuns(sessionId);
    const idleRoles = activeRuns
      .filter((r) => r.status === 'idle')
      .map((r) => r.role);

    const pipeline = createKanbanPriorityPipeline({
      telemetry: pipelineTelemetrySink,
    });
    const result = await prioritizeKanban(pipeline, {
      queryId: `kanban-priority-${sessionId}-${Date.now()}`,
      cards,
      idleRoles,
    });
    return c.json(result);
  });
}
