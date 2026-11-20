import type { HttpContext, HttpRouter } from '@mcp/shared/http/router.js';
import { HttpError } from '@mcp/shared/http/context.js';
import type { SessionId } from '@mcp/agent-runtime-contracts';
import { reconstructMissingToolResults, type ToolResultLookup } from './session-message-preview.js';
import {
  notFound,
  parseIntQuery,
  parseJsonBody,
  parseSessionRecordIdParam,
  parseSessionIdParam,
} from '../_helpers.js';

interface ChapterPage<T = unknown> {
  items: T[];
  next_cursor: string | null;
}

function chapterPreview<T>(page: ChapterPage<T>): ChapterPage<T> {
  return {
    ...page,
    items: page.items.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      const {
        chapter_json: _chapterJson,
        chapter_text: _chapterText,
        resume_json: _resumeJson,
        resume_text: _resumeText,
        metrics_json: _metricsJson,
        ...preview
      } = item as Record<string, unknown>;
      return preview as T;
    }),
  };
}

type MaybePromise<T> = T | Promise<T>;

/**
 * Kept structural on purpose: chapter persistence lives in code-agent and can
 * be disabled during a rolling upgrade. The routes return 501 instead of
 * crashing an older process whose store has not been migrated yet.
 */
interface ConversationChapterStore extends Partial<ToolResultLookup> {
  getSession: (sessionId: SessionId) => MaybePromise<unknown | null>;
  previousUserMessageSeq?: (sessionId: SessionId, beforeSeq: number) => MaybePromise<number | null>;
  getConversationChapterStatus?: (
    sessionId: SessionId,
  ) => MaybePromise<unknown>;
  listConversationChapters?: (
    sessionId: SessionId,
    options: { limit: number; cursor?: string },
  ) => MaybePromise<ChapterPage>;
  searchConversationChapters?: (
    sessionId: SessionId,
    query: string,
    options: { limit: number; cursor?: string },
  ) => MaybePromise<ChapterPage>;
  getConversationChapter?: (
    sessionId: SessionId,
    chapterId: string,
  ) => MaybePromise<unknown | null>;
  listConversationChapterSource?: (
    sessionId: SessionId,
    chapterId: string,
    options: { limit: number; cursor?: string },
  ) => MaybePromise<ChapterPage>;
}

export interface RebuildConversationChaptersInput {
  scope?: 'archived' | 'visible' | 'all';
  /** Rebuild only the transcript that predates the current durable boundary. */
  archived_only?: boolean;
}

interface CoderChapterRoutesOptions {
  /**
   * Rebuild needs an LLM/provider and therefore does not belong to the store.
   * The compaction service can inject the orchestrator here when available.
   */
  rebuild?: (sessionId: SessionId, input: RebuildConversationChaptersInput) => Promise<unknown>;
}

function chapterCursor(
  c: HttpContext,
  prefix: 'chapter' | 'search' | 'message',
): string | undefined {
  const raw = c.req.query('cursor');
  if (raw == null || raw === '') return undefined;
  const match = new RegExp(`^${prefix}:(0|[1-9][0-9]*)$`).exec(raw);
  const seq = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(seq)) {
    throw new HttpError(400, {
      message: `cursor must be a ${prefix} sequence cursor`,
    });
  }
  return `${prefix}:${seq}`;
}

interface CoderChapterRouteDeps {
  readonly sessionStore: ConversationChapterStore;
}

function unavailable(c: HttpContext) {
  return c.json({ error: 'conversation chapters are not available' }, 501);
}

/** Mount the append-only conversation chapter read/rebuild API. */
export function mountCoderChapterRoutes(
  app: HttpRouter,
  deps: CoderChapterRouteDeps,
  options: CoderChapterRoutesOptions = {},
): void {
  app.get('/api/coder/sessions/:id/chapters', async (c) => {
    const sessionId = parseSessionIdParam(c);
    if (!await deps.sessionStore.getSession(sessionId)) return notFound(c);

    const limit = Math.max(1, Math.min(50, parseIntQuery(c, 'limit', 10)));
    const query = (c.req.query('q') ?? '').trim().slice(0, 500);
    const store = deps.sessionStore;

    if (query) {
      if (!store.searchConversationChapters) return unavailable(c);
      const cursor = chapterCursor(c, 'search');
      const page = await store.searchConversationChapters(
        sessionId,
        query,
        { limit, cursor },
      );
      return c.json({
        ...page,
        ...(store.getConversationChapterStatus
          ? { status: await store.getConversationChapterStatus(sessionId) }
          : {}),
      });
    }
    if (!store.listConversationChapters) return unavailable(c);
    const cursor = chapterCursor(c, 'chapter');
    const loadedPage = await store.listConversationChapters(
      sessionId,
      { limit, cursor },
    );
    const page = c.req.query('detail') === 'preview'
      ? chapterPreview(loadedPage)
      : loadedPage;
    return c.json({
      ...page,
      ...(store.getConversationChapterStatus
        ? { status: await store.getConversationChapterStatus(sessionId) }
        : {}),
    });
  });

  // Register the static path before `:chapterId` so rebuild can never be
  // mistaken for an id by routers that prefer declaration order.
  app.post('/api/coder/sessions/:id/chapters/rebuild', async (c) => {
    const sessionId = parseSessionIdParam(c);
    if (!await deps.sessionStore.getSession(sessionId)) return notFound(c);
    if (!options.rebuild) {
      return c.json({ error: 'conversation chapter rebuild is not configured' }, 501);
    }
    const body = await parseJsonBody<RebuildConversationChaptersInput>(c);
    const scope = body.scope
      ?? (body.archived_only === false ? 'all' : 'archived');
    if (scope !== 'archived' && scope !== 'visible' && scope !== 'all') {
      return c.json({ error: 'scope must be archived, visible, or all' }, 400);
    }
    try {
      const result = await options.rebuild(sessionId, {
        archived_only: body.archived_only,
        scope,
      });
      return c.json(result, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const active = message.includes('run is active');
      return c.json({ error: message, code: active ? 'run_active' : 'rebuild_failed' }, active ? 409 : 502);
    }
  });

  app.get('/api/coder/sessions/:id/chapters/:chapterId', async (c) => {
    const sessionId = parseSessionIdParam(c);
    if (!await deps.sessionStore.getSession(sessionId)) return notFound(c);
    const chapterId = parseSessionRecordIdParam(c, 'chapterId');
    const store = deps.sessionStore;
    if (!store.getConversationChapter) return unavailable(c);
    const chapter = await store.getConversationChapter(sessionId, chapterId);
    return chapter ? c.json(chapter) : notFound(c, 'chapter not found');
  });

  app.get('/api/coder/sessions/:id/chapters/:chapterId/messages', async (c) => {
    const sessionId = parseSessionIdParam(c);
    if (!await deps.sessionStore.getSession(sessionId)) return notFound(c);
    const chapterId = parseSessionRecordIdParam(c, 'chapterId');
    const limit = Math.max(1, Math.min(100, parseIntQuery(c, 'limit', 40)));
    const cursor = chapterCursor(c, 'message');
    const store = deps.sessionStore;
    if (!store.listConversationChapterSource) return unavailable(c);
    if (
      store.getConversationChapter &&
      !await store.getConversationChapter(sessionId, chapterId)
    ) {
      return notFound(c, 'chapter not found');
    }
    const page = await store.listConversationChapterSource(
      sessionId,
      chapterId,
      { limit, cursor },
    );
    // A page can end between a tool call and its result. Resolve only the
    // missing calls in this bounded window; never drain subsequent pages.
    const messages = page.items.filter((item): item is { content: unknown } =>
      typeof item === 'object' && item !== null && 'content' in item);
    const tool_results = store.getToolResultsByToolUseIds
      ? await reconstructMissingToolResults({ getToolResultsByToolUseIds: store.getToolResultsByToolUseIds.bind(store) }, sessionId, messages)
      : [];
    const first = page.items[0] as { seq?: unknown } | undefined;
    const preceding_user_seq = typeof first?.seq === 'number' && store.previousUserMessageSeq
      ? await store.previousUserMessageSeq(sessionId, first.seq)
      : null;
    return c.json({ ...page, tool_results, preceding_user_seq });
  });
}
