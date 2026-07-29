/**
 * Read-only Company recommendations over filesystem session state.
 *
 * Reusable role templates and pipeline configuration remain in SQLite. Session
 * existence, agent availability and Kanban inputs come only from bundles.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import {
  notFound,
  parseCompanySessionIdParam,
} from '../_helpers.js';
import { recommendRolesForSession } from './recommend-core.js';
import {
  createKanbanPriorityPipeline,
  prioritizeKanban,
  type KanbanCardInput,
  type KanbanColumn,
  type KanbanTag,
} from '@mcp/company/kanban-priority/index.js';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import { resolveCompanySessionCapabilities } from '@mcp/company/services/session-capabilities.js';

export function mountCompanyRecommendationsRoutes(
  app: Hono,
  deps: ServerDeps,
): void {
  const { sessionStore, pipelineTelemetrySink } = deps;

  app.post('/api/company/sessions/:id/recommend-role', async (c) => {
    const sessionId = parseCompanySessionIdParam(c);
    let body: { task?: string; k?: number };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (!body.task || typeof body.task !== 'string') {
      return c.json({ error: 'task is required' }, 400);
    }

    await sessionStore.ensureCatalog();
    try {
      new CompanySessionFiles({
        companySessionId: sessionId,
        sessionStore,
      });
    } catch {
      return notFound(c, 'session_not_found');
    }

    const result = await recommendRolesForSession(deps, {
      companySessionId: sessionId,
      taskText: body.task,
      k: body.k,
    });

    // Session-scoped counterfactual rows deliberately no longer go to SQLite.
    // Pipeline metrics are emitted through the file-backed per-session metrics
    // path by the runtime; this read-only endpoint performs no durable write.
    return c.json(result);
  });

  app.post(
    '/api/company/sessions/:id/kanban/recompute-priorities',
    async (c) => {
      const requestedId = parseCompanySessionIdParam(c);
      await sessionStore.ensureCatalog();
      let requestedFiles: CompanySessionFiles;
      try {
        requestedFiles = new CompanySessionFiles({
          companySessionId: requestedId,
          sessionStore,
        });
      } catch {
        return notFound(c, 'session_not_found');
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
          return notFound(c, 'root_session_not_found');
        }
      }
      const root = rootFiles.getSession();
      const capabilities = resolveCompanySessionCapabilities(
        root.runtime_kind,
        root.runtime_kind === 'app_studio' ? rootId : null,
      );
      if (!capabilities.allowCompanyKanban) {
        return c.json({ ordered: [], diagnostics: [] });
      }

      const cardsFull = rootFiles.listKanbanCardsFullSync();
      const blocksMap = new Map<string, string[]>();
      for (const card of cardsFull) {
        for (const dependency of card.dependencies) {
          const blocked = blocksMap.get(dependency.depends_on_id) ?? [];
          blocked.push(card.id);
          blocksMap.set(dependency.depends_on_id, blocked);
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
        assignedRoles: card.agents.map((agent) => agent.role),
        createdAtMs: new Date(card.created_at).getTime(),
        columnUpdatedAtMs: new Date(card.updated_at).getTime(),
      }));

      const idleRoles = requestedFiles
        .listAgentRunsSync()
        .filter((run) => run.status === 'idle')
        .map((run) => run.role);

      const pipeline = createKanbanPriorityPipeline({
        telemetry: pipelineTelemetrySink,
      });
      const result = await prioritizeKanban(pipeline, {
        queryId: `kanban-priority-${rootId}-${Date.now()}`,
        cards,
        idleRoles,
      });
      return c.json(result);
    },
  );
}
