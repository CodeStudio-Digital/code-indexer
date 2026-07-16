/**
 * C3 — proactive kanban endpoints:
 *
 *   POST /api/company/sessions/:id/kanban/cards/:cardId/dispatch
 *     body: { role?: string }
 *     Requires a live orchestrator (spawns the worker when needed) and runs
 *     the SAME dispatch unit the autonomous scheduler uses
 *     (orchestrator.dispatchCard → services/scheduler/dispatch-card.ts).
 *     An explicit role (quick-dispatch chip) skips the recommender.
 *
 *   POST /api/company/sessions/:id/kanban/suggest-roles
 *     For the top-N (≤5) unassigned, unblocked todo/backlog cards, runs the
 *     role recommender (same recommendRolesForSession core as
 *     /recommend-role) → { suggestions: [{ cardId, role, score }] }.
 *     Read-only — the dashboard renders the "@role" chips from this.
 */
import type { Context, Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, notFound, resolveRootSessionId } from '../_helpers.js';
import { getOrSpawnCompanyOrchestrator } from '../../../sse/companyOrchestrator.js';
import { recommendRolesForSession } from './recommend-core.js';
import {
  companySurfaceConflict,
  resolveCompanyRouteRuntime,
} from './runtime-capabilities.js';

const MAX_SUGGESTIONS = 5;

export function mountCompanyKanbanDispatchRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore } = deps;

  /** Kanban is project-wide (migration 067) — resolve to the root session. */
  const sessionRoot = (c: Context) =>
    resolveRootSessionId(companyStore, parseIdParam(c));

  // ─── Dispatch one card ──────────────────────────────────────
  app.post('/api/company/sessions/:id/kanban/cards/:cardId/dispatch', async (c) => {
    const sessionId = parseIdParam(c);
    const cardId = parseIdParam(c, 'cardId');
    const runtime = resolveCompanyRouteRuntime(companyStore, sessionId);
    if (!runtime) return notFound(c, 'Session not found');
    if (!runtime.capabilities.allowCompanyKanban) {
      return companySurfaceConflict(c, 'kanban');
    }

    let body: { role?: string } = {};
    try { body = (await c.req.json()) as typeof body; } catch { /* empty body ok */ }
    const role = typeof body.role === 'string' && body.role.trim() ? body.role.trim() : undefined;

    // The dispatch spawns a subordinate — it needs the session's worker alive.
    const { orchestrator } = await getOrSpawnCompanyOrchestrator(sessionId);
    const result = await orchestrator.dispatchCard(cardId, role);
    if (result.ok) {
      return c.json({ ok: true, agentRunId: result.agentRunId, role: result.role });
    }
    if (result.reason === 'card_not_found') return notFound(c, 'Card not found');
    return c.json(
      { ok: false, reason: result.reason, error: result.error },
      409,
    );
  });

  // ─── Role suggestions for the ready pool ────────────────────
  app.post('/api/company/sessions/:id/kanban/suggest-roles', async (c) => {
    const rootId = sessionRoot(c);
    const session = companyStore.getCompanySession(rootId);
    if (!session) return notFound(c, 'Session not found');
    const runtime = resolveCompanyRouteRuntime(companyStore, rootId);
    if (runtime && !runtime.capabilities.allowCompanyKanban) {
      return c.json({ suggestions: [] });
    }

    // Ready pool: dispatchable columns, unblocked, nobody assigned. `todo`
    // outranks `backlog`; inside a column the board position is the order.
    const columnRank: Record<string, number> = { todo: 0, backlog: 1 };
    const ready = companyStore
      .listKanbanCardsFull(rootId)
      .filter(
        (card) =>
          card.column in columnRank &&
          card.blocked_by.length === 0 &&
          !card.agents.some((a) => !a.unassigned_at),
      )
      .sort(
        (a, b) =>
          columnRank[a.column] - columnRank[b.column] || a.position - b.position,
      )
      .slice(0, MAX_SUGGESTIONS);

    const suggestions: Array<{ cardId: number; role: string; score: number }> = [];
    for (const card of ready) {
      try {
        const taskText = `${card.title}\n\n${card.description ?? ''}`.trim();
        const result = await recommendRolesForSession(deps, {
          companySessionId: rootId,
          taskText,
          k: 1,
        });
        const top = result.recommendations[0];
        if (top?.role) {
          suggestions.push({ cardId: card.id, role: top.role, score: top.score });
        }
      } catch { /* one bad card must not sink the batch */ }
    }
    return c.json({ suggestions });
  });
}
