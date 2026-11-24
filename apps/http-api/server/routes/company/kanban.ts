import type { HttpContext, HttpRouter } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../../deps.js';
import { z } from 'zod';
import { taskControl } from '@mcp/company-contracts/models/kanban.js';
import { sessionRoles } from './session-role-roster.js';
import { publish } from '../../../coder-bus.js';
import { activeOrchestrators } from './stream.js';
import {
  KANBAN_COLUMNS,
  type KanbanColumn,
  type KanbanTag,
} from '@mcp/company/types.js';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import { resolveCompanySessionCapabilities } from '@mcp/company/services/session-capabilities.js';
import { assertUuid, type CompanySessionId } from '@mcp/session-storage';
import {
  notFound,
  parseCompanySessionIdParam,
  parseJsonBody,
  parseSessionRecordIdParam,
} from '../_helpers.js';
import { companySurfaceConflict } from './runtime-capabilities.js';

interface KanbanContext {
  requestedId: CompanySessionId;
  rootId: CompanySessionId;
  files: CompanySessionFiles;
  unavailable: boolean;
}

const KANBAN_TAGS = new Set<KanbanTag>([
  'bug',
  'feature',
  'refactor',
  'documentation',
]);

function parseColumn(value: unknown, required = false): KanbanColumn | undefined {
  if (value == null && !required) return undefined;
  if (
    typeof value !== 'string' ||
    !KANBAN_COLUMNS.includes(value as KanbanColumn)
  ) {
    throw new TypeError('column must be a valid Company kanban column');
  }
  return value as KanbanColumn;
}

function parseTag(value: unknown): KanbanTag | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || !KANBAN_TAGS.has(value as KanbanTag)) {
    throw new TypeError('tag must be a valid Company kanban tag');
  }
  return value as KanbanTag;
}

export function mountCompanyKanbanRoutes(app: HttpRouter, deps: ServerDeps): void {
  const { sessionStore } = deps;

  /**
   * Child sessions keep their own transcript/agents/inbox but share Kanban
   * with their root Company bundle. The root is resolved exclusively from
   * `session.json`; no SQLite lookup or compatibility fallback is involved.
   */
  const resolveKanban = async (c: HttpContext): Promise<KanbanContext | null> => {
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
    let files = requestedFiles;
    if (rootId !== requestedId) {
      try {
        files = new CompanySessionFiles({
          companySessionId: rootId,
          sessionStore,
        });
      } catch {
        return null;
      }
    }
    const root = files.getSession();
    const capabilities = resolveCompanySessionCapabilities(
      root.runtime_kind,
      root.runtime_kind === 'app_studio' ? rootId : null,
    );
    return {
      requestedId,
      rootId,
      files,
      unavailable: !capabilities.allowCompanyKanban,
    };
  };

  function publishKanbanEvent(
    sessionId: CompanySessionId,
    event: string,
    data: unknown,
  ): void {
    const orchestrator = activeOrchestrators.get(sessionId);
    if (orchestrator) publish(orchestrator.metaBus, event, data);
  }

  function findChecklistItem(files: CompanySessionFiles, itemId: string) {
    for (const card of files.listKanbanCardsFullSync()) {
      const item = card.checklist.find((candidate) => candidate.id === itemId);
      if (item) return { card, item };
    }
    return null;
  }

  app.get('/api/company/sessions/:id/task-options', async c => {
    const resolved = await resolveKanban(c);
    if (!resolved || resolved.unavailable) return notFound(c);
    const session = resolved.files.getSession();
    return c.json({
      roles: sessionRoles(deps,session).filter(r => r.role !== 'master' && r.enabled !== false).map(r => r.role),
      projects: session.project_ids.map(project_id => ({project_id,project_name:deps.db.getProject(project_id)?.name ?? String(project_id)})),
    });
  });

  app.get('/api/company/sessions/:id/kanban', async (c) => {
    const resolved = await resolveKanban(c);
    if (!resolved) return notFound(c, 'Session not found');
    if (resolved.unavailable) return c.json([]);
    let column: KanbanColumn | undefined;
    try {
      column = parseColumn(c.req.query('column'));
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
    return c.json(resolved.files.listKanbanCardsFullSync({ column }));
  });

  app.get('/api/company/sessions/:id/kanban/:cardId', async (c) => {
    const resolved = await resolveKanban(c);
    if (!resolved) return notFound(c, 'Session not found');
    if (resolved.unavailable) return companySurfaceConflict(c, 'kanban');
    const cardId = parseSessionRecordIdParam(c, 'cardId');
    const card = resolved.files.getKanbanCardFullSync(cardId);
    return card ? c.json(card) : notFound(c, 'Card not found');
  });

  app.post('/api/company/sessions/:id/kanban', async (c) => {
    const resolved = await resolveKanban(c);
    if (!resolved) return notFound(c, 'Session not found');
    if (resolved.unavailable) return companySurfaceConflict(c, 'kanban');
    const body = await parseJsonBody<{
      title?: string;
      description?: string;
      column?: unknown;
      tag?: unknown;
      checklist?: unknown;
    }>(c);
    if (typeof body.title !== 'string' || !body.title.trim()) {
      return c.json({ error: 'title is required' }, 400);
    }
    if (
      body.checklist !== undefined &&
      (
        !Array.isArray(body.checklist) ||
        body.checklist.some((item) => typeof item !== 'string')
      )
    ) {
      return c.json({ error: 'checklist must be an array of strings' }, 400);
    }
    try {
      const full = resolved.files.createKanbanCardSync({
        title: body.title,
        description: body.description,
        column: parseColumn(body.column),
        tag: parseTag(body.tag),
        checklist: body.checklist as string[] | undefined,
        createdBy: 'human',
      });
      publishKanbanEvent(resolved.rootId, 'kanban_card_created', full);
      return c.json(full, 201);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.patch('/api/company/sessions/:id/kanban/:cardId', async (c) => {
    const resolved = await resolveKanban(c);
    if (!resolved) return notFound(c, 'Session not found');
    if (resolved.unavailable) return companySurfaceConflict(c, 'kanban');
    const cardId = parseSessionRecordIdParam(c, 'cardId');
    const body = await parseJsonBody<{
      title?: string;
      description?: string;
      tag?: unknown;
    }>(c);
    try {
      const patch = {
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(body.description === undefined
          ? {}
          : { description: body.description }),
        ...(body.tag === undefined ? {} : { tag: parseTag(body.tag) }),
      };
      const card = resolved.files.updateKanbanCardSync(cardId, patch);
      if (!card) return notFound(c, 'Card not found');
      publishKanbanEvent(resolved.rootId, 'kanban_card_updated', {
        cardId,
        patch,
      });
      return c.json(card);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.post('/api/company/sessions/:id/kanban/:cardId/control', async c => {
    const resolved = await resolveKanban(c);
    if (!resolved) return notFound(c);
    if (resolved.unavailable) return companySurfaceConflict(c,'kanban');
    const id = parseSessionRecordIdParam(c,'cardId');
    const input = z.object({expectedUpdatedAt:z.string(),control:taskControl}).safeParse(await c.req.json());
    if (!input.success) return c.json({error:'Revise os critérios, o projeto e o responsável.'},400);
    const card = resolved.files.getKanbanCardFullSync(id);
    if (!card) return notFound(c,'Card not found');
    if (card.updated_at !== input.data.expectedUpdatedAt) return c.json({error:'A tarefa mudou. Reabra a tarefa antes de salvar.'},409);
    const control = input.data.control;
    const session = resolved.files.getSession();
    const roster = sessionRoles(deps,session);
    const owner = roster.find(r => r.role === control.owner && r.role !== 'master' && r.enabled !== false);
    if (control.owner && !owner) return c.json({error:'Responsável indisponível.'},400);
    if (control.projectId && (!session.project_ids.includes(control.projectId)
      || (owner?.projectIds?.length && !owner.projectIds.includes(control.projectId)))) return c.json({error:'Projeto fora do escopo do papel.'},400);
    if (card.agents.some(a => !a.unassigned_at) && (control.owner !== (card.control?.owner ?? null) || control.projectId !== (card.control?.projectId ?? null))) {
      return c.json({error:'A atribuição só pode mudar após encerrar a tentativa ativa.'},409);
    }
    if (card.column === 'done' && control.acceptance.some(item => !item.evidence)) return c.json({error:'Reabra a tarefa para alterar o aceite.'},409);
    const changed = resolved.files.updateKanbanCardSync(id,{control});
    publishKanbanEvent(resolved.rootId,'kanban_card_updated',{cardId:id,patch:{control}});
    return c.json(changed);
  });

  app.post('/api/company/sessions/:id/kanban/:cardId/move', async (c) => {
    const resolved = await resolveKanban(c);
    if (!resolved) return notFound(c, 'Session not found');
    if (resolved.unavailable) return companySurfaceConflict(c, 'kanban');
    const cardId = parseSessionRecordIdParam(c, 'cardId');
    const body = await parseJsonBody<{
      column?: unknown;
      position?: number;
      reason?: string;
    }>(c);
    try {
      const column = parseColumn(body.column, true)!;
      const before = resolved.files.getKanbanCardFullSync(cardId);
      if (!before) return notFound(c, 'Card not found');
      if (
        ['in_progress', 'review', 'done'].includes(column) &&
        before.column !== column &&
        before.blocked_by.length > 0
      ) {
        return c.json({
          error: `Card is blocked by cards: ${before.blocked_by.join(', ')}`,
          blocked_by: before.blocked_by,
        }, 409);
      }
      const card = resolved.files.moveKanbanCardSync(
        cardId,
        column,
        body.position,
        'human',
        typeof body.reason === 'string' ? body.reason.slice(0,2000) : undefined,
      )!;
      publishKanbanEvent(resolved.rootId, 'kanban_card_moved', {
        cardId,
        fromColumn: before.column,
        toColumn: column,
        position: card.position,
      });
      return c.json(card);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.delete('/api/company/sessions/:id/kanban/:cardId', async (c) => {
    const resolved = await resolveKanban(c);
    if (!resolved) return notFound(c, 'Session not found');
    if (resolved.unavailable) return companySurfaceConflict(c, 'kanban');
    const cardId = parseSessionRecordIdParam(c, 'cardId');
    try {
      if (!resolved.files.deleteKanbanCardSync(cardId)) {
        return notFound(c, 'Card not found');
      }
      publishKanbanEvent(resolved.rootId, 'kanban_card_deleted', { cardId });
      return c.json({ ok: true, recoverable: true });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 409);
    }
  });

  app.post('/api/company/sessions/:id/kanban/:cardId/comments', async (c) => {
    const resolved = await resolveKanban(c);
    if (!resolved) return notFound(c, 'Session not found');
    if (resolved.unavailable) return companySurfaceConflict(c, 'kanban');
    const cardId = parseSessionRecordIdParam(c, 'cardId');
    const body = await parseJsonBody<{ content?: string }>(c);
    if (typeof body.content !== 'string' || !body.content.trim()) {
      return c.json({ error: 'content is required' }, 400);
    }
    try {
      const comment = resolved.files.addKanbanCommentSync(
        cardId,
        'human',
        null,
        body.content,
      );
      publishKanbanEvent(resolved.rootId, 'kanban_comment_added', {
        cardId,
        comment,
      });
      return c.json(comment, 201);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 404);
    }
  });

  app.get('/api/company/sessions/:id/kanban/:cardId/comments', async (c) => {
    const resolved = await resolveKanban(c);
    if (!resolved) return notFound(c, 'Session not found');
    if (resolved.unavailable) return c.json([]);
    const cardId = parseSessionRecordIdParam(c, 'cardId');
    return c.json(
      resolved.files.getKanbanCardFullSync(cardId)?.comments ?? [],
    );
  });

  app.post('/api/company/sessions/:id/kanban/:cardId/checklist', async (c) => {
    const resolved = await resolveKanban(c);
    if (!resolved) return notFound(c, 'Session not found');
    if (resolved.unavailable) return companySurfaceConflict(c, 'kanban');
    const cardId = parseSessionRecordIdParam(c, 'cardId');
    const body = await parseJsonBody<{ text?: string }>(c);
    if (typeof body.text !== 'string' || !body.text.trim()) {
      return c.json({ error: 'text is required' }, 400);
    }
    const card = resolved.files.getKanbanCardFullSync(cardId);
    if (!card) return notFound(c, 'Card not found');
    const items = resolved.files.updateKanbanChecklistSync(cardId, [
      ...card.checklist,
      { text: body.text, checked: false },
    ]);
    const item = items.at(-1)!;
    publishKanbanEvent(resolved.rootId, 'kanban_checklist_updated', {
      cardId,
      items: [item],
    });
    return c.json(item, 201);
  });

  app.patch('/api/company/sessions/:id/kanban/checklist/:itemId', async (c) => {
    const resolved = await resolveKanban(c);
    if (!resolved) return notFound(c, 'Session not found');
    if (resolved.unavailable) return companySurfaceConflict(c, 'kanban');
    const itemId = parseSessionRecordIdParam(c, 'itemId');
    const found = findChecklistItem(resolved.files, itemId);
    if (!found) return notFound(c, 'Item not found');
    const body = await parseJsonBody<{
      text?: string;
      checked?: boolean;
    }>(c);
    const items = resolved.files.updateKanbanChecklistSync(
      found.card.id,
      found.card.checklist.map((item) =>
        item.id === itemId
          ? {
              ...item,
              ...(body.text === undefined ? {} : { text: body.text }),
              ...(body.checked === undefined
                ? {}
                : { checked: body.checked }),
            }
          : item,
      ),
    );
    const item = items.find((candidate) => candidate.id === itemId)!;
    publishKanbanEvent(resolved.rootId, 'kanban_checklist_updated', {
      cardId: found.card.id,
      items: [item],
    });
    return c.json(item);
  });

  app.delete('/api/company/sessions/:id/kanban/checklist/:itemId', async (c) => {
    const resolved = await resolveKanban(c);
    if (!resolved) return notFound(c, 'Session not found');
    if (resolved.unavailable) return companySurfaceConflict(c, 'kanban');
    const itemId = parseSessionRecordIdParam(c, 'itemId');
    const found = findChecklistItem(resolved.files, itemId);
    if (!found) return notFound(c, 'Item not found');
    resolved.files.updateKanbanChecklistSync(
      found.card.id,
      found.card.checklist.filter((item) => item.id !== itemId),
    );
    publishKanbanEvent(resolved.rootId, 'kanban_checklist_removed', {
      cardId: found.card.id,
      itemId,
    });
    return c.json({ ok: true });
  });

  app.post('/api/company/sessions/:id/kanban/:cardId/dependencies', async (c) => {
    const resolved = await resolveKanban(c);
    if (!resolved) return notFound(c, 'Session not found');
    if (resolved.unavailable) return companySurfaceConflict(c, 'kanban');
    const cardId = parseSessionRecordIdParam(c, 'cardId');
    const body = await parseJsonBody<{
      depends_on_card_id?: unknown;
    }>(c);
    try {
      if (typeof body.depends_on_card_id !== 'string') {
        throw new TypeError('depends_on_card_id must be a canonical UUID');
      }
      const dependsOnId = assertUuid(
        body.depends_on_card_id,
        'depends_on_card_id',
      );
      const dependency = resolved.files.addKanbanDependencySync(
        cardId,
        dependsOnId,
      );
      publishKanbanEvent(resolved.rootId, 'kanban_dependency_added', {
        cardId,
        dependency,
      });
      return c.json(dependency, 201);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.delete(
    '/api/company/sessions/:id/kanban/:cardId/dependencies/:depCardId',
    async (c) => {
      const resolved = await resolveKanban(c);
      if (!resolved) return notFound(c, 'Session not found');
      if (resolved.unavailable) return companySurfaceConflict(c, 'kanban');
      const cardId = parseSessionRecordIdParam(c, 'cardId');
      const dependsOnId = parseSessionRecordIdParam(c, 'depCardId');
      const dependency = resolved.files.removeKanbanDependencySync(
        cardId,
        dependsOnId,
      );
      if (!dependency) return notFound(c, 'Dependency not found');
      publishKanbanEvent(resolved.rootId, 'kanban_dependency_removed', {
        cardId,
        dependencyId: dependency.id,
        dependsOnId,
      });
      return c.json({ ok: true });
    },
  );
}
