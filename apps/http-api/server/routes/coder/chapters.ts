import type { Context, Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { notFound, parseIdParam, parseIntQuery, parseJsonBody } from '../_helpers.js';

interface ChapterPage<T = unknown> {
  items: T[];
  next_cursor: string | null;
}

/**
 * Kept structural on purpose: chapter persistence lives in code-agent and can
 * be disabled during a rolling upgrade. The routes return 501 instead of
 * crashing an older process whose store has not been migrated yet.
 */
interface ConversationChapterStore {
  listConversationChapters?: (
    sessionId: number,
    options: { limit: number; cursor?: string },
  ) => ChapterPage;
  searchConversationChapters?: (
    sessionId: number,
    query: string,
    options: { limit: number; cursor?: string },
  ) => ChapterPage;
  getConversationChapter?: (sessionId: number, chapterId: number) => unknown | null;
  listConversationChapterSource?: (
    sessionId: number,
    chapterId: number,
    options: { limit: number; cursor?: string },
  ) => ChapterPage;
}

export interface RebuildConversationChaptersInput {
  /** Rebuild only the transcript that predates the current durable boundary. */
  archived_only?: boolean;
}

export interface CoderChapterRoutesOptions {
  /**
   * Rebuild needs an LLM/provider and therefore does not belong to the store.
   * The compaction service can inject the orchestrator here when available.
   */
  rebuild?: (sessionId: number, input: RebuildConversationChaptersInput) => Promise<unknown>;
}

function validCursor(raw: string | undefined): string | undefined {
  const cursor = raw?.trim();
  if (!cursor) return undefined;
  return cursor.slice(0, 200);
}

function chapterStore(deps: ServerDeps): ConversationChapterStore {
  return deps.sessionStore as unknown as ConversationChapterStore;
}

function unavailable(c: Context) {
  return c.json({ error: 'conversation chapters are not available' }, 501);
}

/** Mount the append-only conversation chapter read/rebuild API. */
export function mountCoderChapterRoutes(
  app: Hono,
  deps: ServerDeps,
  options: CoderChapterRoutesOptions = {},
): void {
  app.get('/api/coder/sessions/:id/chapters', (c) => {
    const sessionId = parseIdParam(c);
    if (!deps.sessionStore.getSession(sessionId)) return notFound(c);

    const limit = Math.max(1, Math.min(50, parseIntQuery(c, 'limit', 10)));
    const cursor = validCursor(c.req.query('cursor'));
    const query = (c.req.query('q') ?? '').trim().slice(0, 500);
    const store = chapterStore(deps);

    if (query) {
      if (!store.searchConversationChapters) return unavailable(c);
      return c.json(store.searchConversationChapters(sessionId, query, { limit, cursor }));
    }
    if (!store.listConversationChapters) return unavailable(c);
    return c.json(store.listConversationChapters(sessionId, { limit, cursor }));
  });

  // Register the static path before `:chapterId` so rebuild can never be
  // mistaken for an id by routers that prefer declaration order.
  app.post('/api/coder/sessions/:id/chapters/rebuild', async (c) => {
    const sessionId = parseIdParam(c);
    if (!deps.sessionStore.getSession(sessionId)) return notFound(c);
    if (!options.rebuild) {
      return c.json({ error: 'conversation chapter rebuild is not configured' }, 501);
    }
    const body = await parseJsonBody<RebuildConversationChaptersInput>(c);
    try {
      const result = await options.rebuild(sessionId, { archived_only: body.archived_only !== false });
      return c.json(result, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const active = message.includes('run is active');
      return c.json({ error: message, code: active ? 'run_active' : 'rebuild_failed' }, active ? 409 : 502);
    }
  });

  app.get('/api/coder/sessions/:id/chapters/:chapterId', (c) => {
    const sessionId = parseIdParam(c);
    if (!deps.sessionStore.getSession(sessionId)) return notFound(c);
    const chapterId = parseIdParam(c, 'chapterId');
    if (!Number.isInteger(chapterId) || chapterId <= 0) {
      return c.json({ error: 'invalid chapter id' }, 400);
    }
    const store = chapterStore(deps);
    if (!store.getConversationChapter) return unavailable(c);
    const chapter = store.getConversationChapter(sessionId, chapterId);
    return chapter ? c.json(chapter) : notFound(c, 'chapter not found');
  });

  app.get('/api/coder/sessions/:id/chapters/:chapterId/messages', (c) => {
    const sessionId = parseIdParam(c);
    if (!deps.sessionStore.getSession(sessionId)) return notFound(c);
    const chapterId = parseIdParam(c, 'chapterId');
    if (!Number.isInteger(chapterId) || chapterId <= 0) {
      return c.json({ error: 'invalid chapter id' }, 400);
    }
    const limit = Math.max(1, Math.min(100, parseIntQuery(c, 'limit', 40)));
    const cursor = validCursor(c.req.query('cursor'));
    const store = chapterStore(deps);
    if (!store.listConversationChapterSource) return unavailable(c);
    if (store.getConversationChapter && !store.getConversationChapter(sessionId, chapterId)) {
      return notFound(c, 'chapter not found');
    }
    return c.json(store.listConversationChapterSource(sessionId, chapterId, { limit, cursor }));
  });
}
