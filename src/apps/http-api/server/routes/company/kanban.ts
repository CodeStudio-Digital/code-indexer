import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { publish } from '../../../coder-bus.js';
import { activeOrchestrators } from './stream.js';
import type { KanbanColumn, KanbanTag } from '../../../../../core/coder/company/types.js';
import { parseIdParam, notFound } from '../_helpers.js';

export function mountCompanyKanbanRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore } = deps;

  /** Helper: publish a kanban event through the active orchestrator's metaBus if available. */
  function publishKanbanEvent(sessionId: number, event: string, data: unknown): void {
    const orchestrator = activeOrchestrators.get(sessionId);
    if (orchestrator) {
      publish(orchestrator.metaBus, event, data);
    }
  }

  // ─── List all cards (full) ──────────────────────────────────

  app.get('/api/company/sessions/:id/kanban', (c) => {
    const id = parseIdParam(c);
    const column = c.req.query('column') as KanbanColumn | undefined;
    if (column) {
      const cards = companyStore.listKanbanCardsFull(id).filter(c => c.column === column);
      return c.json(cards);
    }
    return c.json(companyStore.listKanbanCardsFull(id));
  });

  // ─── Get single card (full) ─────────────────────────────────

  app.get('/api/company/sessions/:id/kanban/:cardId', (c) => {
    const cardId = parseIdParam(c, 'cardId');
    const card = companyStore.getKanbanCardFull(cardId);
    if (!card) return notFound(c, 'Card not found');
    return c.json(card);
  });

  // ─── Create card ────────────────────────────────────────────

  app.post('/api/company/sessions/:id/kanban', async (c) => {
    const sessionId = parseIdParam(c);
    const body = await c.req.json<{
      title: string;
      description?: string;
      column?: KanbanColumn;
      tag?: KanbanTag;
      checklist?: string[];
    }>();

    if (!body.title) return c.json({ error: 'title is required' }, 400);

    const card = companyStore.createKanbanCard(sessionId, {
      title: body.title,
      description: body.description,
      column: body.column,
      tag: body.tag,
      created_by: 'human',
    });

    // Add checklist items if provided
    if (body.checklist) {
      for (let i = 0; i < body.checklist.length; i++) {
        companyStore.addChecklistItem(card.id, body.checklist[i], i);
      }
    }

    const full = companyStore.getKanbanCardFull(card.id)!;
    publishKanbanEvent(sessionId, 'kanban_card_created', full);
    return c.json(full, 201);
  });

  // ─── Update card ────────────────────────────────────────────

  app.patch('/api/company/sessions/:id/kanban/:cardId', async (c) => {
    const sessionId = parseIdParam(c);
    const cardId = parseIdParam(c, 'cardId');
    const body = await c.req.json<{
      title?: string;
      description?: string;
      tag?: KanbanTag | null;
    }>();

    const card = companyStore.updateKanbanCard(cardId, body);
    if (!card) return notFound(c, 'Card not found');

    publishKanbanEvent(sessionId, 'kanban_card_updated', { cardId, patch: body });
    return c.json(card);
  });

  // ─── Move card ──────────────────────────────────────────────

  app.post('/api/company/sessions/:id/kanban/:cardId/move', async (c) => {
    const sessionId = parseIdParam(c);
    const cardId = parseIdParam(c, 'cardId');
    const body = await c.req.json<{
      column: KanbanColumn;
      position?: number;
    }>();

    if (!body.column) return c.json({ error: 'column is required' }, 400);

    // Validate dependency constraints
    if (['in_progress', 'review', 'done'].includes(body.column)) {
      const full = companyStore.getKanbanCardFull(cardId);
      if (full && full.blocked_by.length > 0) {
        return c.json({
          error: `Card is blocked by cards: ${full.blocked_by.join(', ')}`,
          blocked_by: full.blocked_by,
        }, 409);
      }
    }

    try {
      const before = companyStore.getKanbanCard(cardId);
      const card = companyStore.moveKanbanCard(cardId, body.column, body.position);
      publishKanbanEvent(sessionId, 'kanban_card_moved', {
        cardId,
        fromColumn: before?.column,
        toColumn: body.column,
        position: card.position,
      });
      return c.json(card);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // ─── Delete card ────────────────────────────────────────────

  app.delete('/api/company/sessions/:id/kanban/:cardId', (c) => {
    const sessionId = parseIdParam(c);
    const cardId = parseIdParam(c, 'cardId');
    const ok = companyStore.deleteKanbanCard(cardId);
    if (!ok) return notFound(c, 'Card not found');

    publishKanbanEvent(sessionId, 'kanban_card_deleted', { cardId });
    return c.json({ ok: true });
  });

  // ─── Add comment ────────────────────────────────────────────

  app.post('/api/company/sessions/:id/kanban/:cardId/comments', async (c) => {
    const sessionId = parseIdParam(c);
    const cardId = parseIdParam(c, 'cardId');
    const body = await c.req.json<{ content: string }>();

    if (!body.content) return c.json({ error: 'content is required' }, 400);

    const comment = companyStore.addKanbanComment(cardId, 'human', null, body.content);
    publishKanbanEvent(sessionId, 'kanban_comment_added', { cardId, comment });
    return c.json(comment, 201);
  });

  // ─── List comments ──────────────────────────────────────────

  app.get('/api/company/sessions/:id/kanban/:cardId/comments', (c) => {
    const cardId = parseIdParam(c, 'cardId');
    return c.json(companyStore.listKanbanComments(cardId));
  });

  // ─── Add checklist item ─────────────────────────────────────

  app.post('/api/company/sessions/:id/kanban/:cardId/checklist', async (c) => {
    const sessionId = parseIdParam(c);
    const cardId = parseIdParam(c, 'cardId');
    const body = await c.req.json<{ text: string }>();

    if (!body.text) return c.json({ error: 'text is required' }, 400);

    const item = companyStore.addChecklistItem(cardId, body.text);
    publishKanbanEvent(sessionId, 'kanban_checklist_updated', { cardId, items: [item] });
    return c.json(item, 201);
  });

  // ─── Update checklist item ──────────────────────────────────

  app.patch('/api/company/sessions/:id/kanban/checklist/:itemId', async (c) => {
    const sessionId = parseIdParam(c);
    const itemId = parseIdParam(c, 'itemId');
    const body = await c.req.json<{
      text?: string;
      checked?: boolean;
    }>();

    const item = companyStore.updateChecklistItem(itemId, body);
    if (!item) return notFound(c, 'Item not found');

    publishKanbanEvent(sessionId, 'kanban_checklist_updated', { cardId: item.card_id, items: [item] });
    return c.json(item);
  });

  // ─── Delete checklist item ──────────────────────────────────

  app.delete('/api/company/sessions/:id/kanban/checklist/:itemId', (c) => {
    const sessionId = parseIdParam(c);
    const itemId = parseIdParam(c, 'itemId');
    const ok = companyStore.removeChecklistItem(itemId);
    if (!ok) return notFound(c, 'Item not found');

    return c.json({ ok: true });
  });

  // ─── Add dependency ─────────────────────────────────────────

  app.post('/api/company/sessions/:id/kanban/:cardId/dependencies', async (c) => {
    const sessionId = parseIdParam(c);
    const cardId = parseIdParam(c, 'cardId');
    const body = await c.req.json<{ depends_on_card_id: number }>();

    if (!body.depends_on_card_id) return c.json({ error: 'depends_on_card_id is required' }, 400);

    try {
      const dep = companyStore.addCardDependency(cardId, body.depends_on_card_id);
      publishKanbanEvent(sessionId, 'kanban_dependency_added', { cardId, dependsOnId: body.depends_on_card_id });
      return c.json(dep, 201);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // ─── Remove dependency ──────────────────────────────────────

  app.delete('/api/company/sessions/:id/kanban/:cardId/dependencies/:depCardId', (c) => {
    const sessionId = parseIdParam(c);
    const cardId = parseIdParam(c, 'cardId');
    const depCardId = parseIdParam(c, 'depCardId');
    const ok = companyStore.removeCardDependency(cardId, depCardId);
    if (!ok) return notFound(c, 'Dependency not found');

    publishKanbanEvent(sessionId, 'kanban_dependency_removed', { cardId, dependsOnId: depCardId });
    return c.json({ ok: true });
  });
}
