/**
 * Proactive filesystem-backed Company Kanban endpoints.
 *
 * Dispatch uses the requested session's worker, while cards are read from the
 * root bundle shared by all child sessions. Public session/card/run ids are
 * opaque UUIDs throughout.
 */
import type { HttpContext, HttpRouter } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../../deps.js';
import { isMutationOutcomeUnknownError } from '@mcp/orchestrator-host';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import { resolveCompanySessionCapabilities } from '@mcp/company/services/session-capabilities.js';
import type { CompanySessionId } from '@mcp/session-storage';
import {
  notFound,
  parseCompanySessionIdParam,
  parseSessionRecordIdParam,
} from '../_helpers.js';
import {
  evictCompanyOrchestrator,
  getOrSpawnCompanyOrchestrator,
} from '../../../sse/companyOrchestrator.js';
import { recommendRolesForSession } from './recommend-core.js';
import { companySurfaceConflict } from './runtime-capabilities.js';
import { mountCompanyKanbanDispatchReviewRoutes } from './kanban-dispatch-review.js';
import { withSessionLock } from '../coder/sessionLock.js';

const MAX_SUGGESTIONS = 5;

interface ResolvedKanbanSession {
  requestedId: CompanySessionId;
  rootId: CompanySessionId;
  rootFiles: CompanySessionFiles;
  unavailable: boolean;
}

export function mountCompanyKanbanDispatchRoutes(
  app: HttpRouter,
  deps: ServerDeps,
): void {
  const { sessionStore } = deps;

  const resolveSession = async (
    c: HttpContext,
  ): Promise<ResolvedKanbanSession | null> => {
    const requestedId = parseCompanySessionIdParam(c);
    await sessionStore.ensureCatalog();
    let requestedFiles: CompanySessionFiles;
    try {
      requestedFiles = new CompanySessionFiles({
        companySessionId: requestedId,
        sessionStore,
      });
    } catch {
      return null;
    }
    const requested = requestedFiles.getSession();
    const rootId = requested.parent_session_id ?? requestedId;
    let rootFiles = requestedFiles;
    if (rootId !== requestedId) {
      try {
        rootFiles = new CompanySessionFiles({
          companySessionId: rootId,
          sessionStore,
        });
      } catch {
        return null;
      }
    }
    const root = rootFiles.getSession();
    const capabilities = resolveCompanySessionCapabilities(
      root.runtime_kind,
      root.runtime_kind === 'app_studio' ? rootId : null,
    );
    return {
      requestedId,
      rootId,
      rootFiles,
      unavailable: !capabilities.allowCompanyKanban,
    };
  };

  mountCompanyKanbanDispatchReviewRoutes(app, deps, resolveSession);

  app.post(
    '/api/company/sessions/:id/kanban/cards/:cardId/dispatch',
    async (c) => {
      const resolved = await resolveSession(c);
      if (!resolved) return notFound(c, 'Session not found');
      if (resolved.unavailable) return companySurfaceConflict(c, 'kanban');
      const cardId = parseSessionRecordIdParam(c, 'cardId');
      if (!resolved.rootFiles.getKanbanCardFullSync(cardId)) {
        return notFound(c, 'Card not found');
      }

      let body: { role?: string } = {};
      try {
        body = (await c.req.json()) as typeof body;
      } catch {
        // An empty body lets the role recommender choose.
      }
      const role =
        typeof body.role === 'string' && body.role.trim()
          ? body.role.trim()
          : undefined;

      return withSessionLock(resolved.requestedId, async () => {
      const { orchestrator } = await getOrSpawnCompanyOrchestrator(
        resolved.requestedId,
      );
      let result: Awaited<ReturnType<typeof orchestrator.dispatchCard>>;
      try {
        result = await orchestrator.dispatchCard(cardId, role);
      } catch (error) {
        if (isMutationOutcomeUnknownError(error)) {
          await evictCompanyOrchestrator(resolved.requestedId);
          return c.json({
            error:
              'Card dispatch outcome is unknown because its worker acknowledgement ' +
              'was lost; no subordinate was spawned again.',
            code: 'OUTCOME_UNKNOWN',
            cardId,
          }, 500);
        }
        throw error;
      }
      if (result.ok) {
        return c.json({
          ok: true,
          agentRunId: result.agentRunId,
          role: result.role,
        });
      }
      if (result.reason === 'card_not_found') {
        return notFound(c, 'Card not found');
      }
      return c.json(
        { ok: false, reason: result.reason, error: result.error },
        409,
      );
      });
    },
  );

  app.post('/api/company/sessions/:id/kanban/suggest-roles', async (c) => {
    const resolved = await resolveSession(c);
    if (!resolved) return notFound(c, 'Session not found');
    if (resolved.unavailable) return c.json({ suggestions: [] });

    const columnRank: Record<string, number> = { todo: 0, backlog: 1 };
    const ready = resolved.rootFiles
      .listKanbanCardsFullSync()
      .filter(
        (card) =>
          card.column in columnRank &&
          card.blocked_by.length === 0 &&
          !card.agents.some((agent) => !agent.unassigned_at),
      )
      .sort(
        (left, right) =>
          columnRank[left.column] - columnRank[right.column] ||
          left.position - right.position ||
          left.seq - right.seq,
      )
      .slice(0, MAX_SUGGESTIONS);

    const suggestions: Array<{
      cardId: string;
      role: string;
      score: number;
    }> = [];
    for (const card of ready) {
      try {
        const taskText = `${card.title}\n\n${card.description ?? ''}`.trim();
        const result = await recommendRolesForSession(deps, {
          companySessionId: resolved.rootId,
          taskText,
          k: 1,
        });
        const top = result.recommendations[0];
        if (top?.role) {
          suggestions.push({
            cardId: card.id,
            role: top.role,
            score: top.score,
          });
        }
      } catch {
        // One malformed card/provider response must not sink the batch.
      }
    }
    return c.json({ suggestions });
  });
}
