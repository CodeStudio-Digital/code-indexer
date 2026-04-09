import type { Hono } from 'hono';
import type { CoderProviderName } from '../../../../../core/coder/index.js';
import { AGENTS } from '../../../../../core/coder/agents/index.js';
import { getAllKnownToolsMeta, getToolTier, inferProfileFromMessage, TIER_COUNTS } from '../../../../../core/coder/tools/tiers.js';
import { enumerateExternalTools } from '../../../admin/mcp-servers.routes.js';
import { loadConfig } from '../../../../../utils/config.js';
import type { ServerDeps } from '../../deps.js';
import type { CoderRuntime } from './state.js';

interface CreateSessionBody {
  project_id: number;
  title: string;
  provider: CoderProviderName;
  model?: string;
}

export function mountCoderSessionsRoutes(
  app: Hono,
  deps: ServerDeps,
  runtime: CoderRuntime,
): void {
  const { sessionStore } = deps;
  const { activeRuns } = runtime;

  /**
   * Global recent sessions, cross-project. Powers the main app sidebar
   * "Recent" list. NOTE: this route must be registered BEFORE the
   * /api/coder/sessions/:id routes so Hono doesn't interpret "recent" as
   * an id parameter.
   */
  app.get('/api/coder/sessions/recent', (c) => {
    const rawLimit = parseInt(c.req.query('limit') ?? '10', 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, rawLimit)) : 10;
    return c.json(sessionStore.listRecentSessionsGlobal(limit));
  });

  /**
   * List the built-in agent presets. The dashboard uses this to render a
   * picker when creating/starting a session. Returns static data — one
   * entry per built-in agent plus tier counts for token-budget tooltips.
   */
  app.get('/api/coder/agents', (c) => {
    return c.json({
      agents: Object.values(AGENTS),
      tierCounts: TIER_COUNTS,
    });
  });

  /**
   * Classify the intent of a pending user message and suggest an agent +
   * profile. Pure regex heuristic, no LLM call, ~microseconds.
   *
   * The dashboard calls this on message input (debounced) so the UI can
   * auto-select a sensible agent/profile before the user hits send.
   */
  app.post('/api/coder/classify-intent', async (c) => {
    const body = await c.req.json<{ message?: string }>();
    const message = String(body.message ?? '').trim();
    if (!message) {
      return c.json({ agent: 'explore', profile: 'bootstrap', confidence: 'default' });
    }
    const profile = inferProfileFromMessage(message);
    // Map profile → recommended agent. navigate without plan mode = build;
    // full = admin (but requires explicit user intent for git commits).
    let agent: 'explore' | 'plan' | 'build' | 'admin';
    switch (profile) {
      case 'bootstrap':
        agent = 'explore';
        break;
      case 'navigate':
        agent = 'build';
        break;
      case 'full':
        agent = 'admin';
        break;
    }
    return c.json({ agent, profile, confidence: 'heuristic' });
  });

  app.get('/api/coder/sessions', (c) => {
    const projectId = parseInt(c.req.query('project_id') ?? '0', 10);
    if (!projectId) return c.json({ error: 'project_id required' }, 400);

    const archivedQ = c.req.query('archived');
    let archived: boolean | null = false;
    if (archivedQ === '1' || archivedQ === 'true') archived = true;
    else if (archivedQ === 'all') archived = null;

    const groupQ = c.req.query('group_id');
    let groupId: number | null | undefined;
    if (groupQ === 'null') groupId = null;
    else if (groupQ !== undefined && groupQ !== '') groupId = parseInt(groupQ, 10);

    return c.json(sessionStore.listSessions(projectId, { archived, groupId }));
  });

  app.post('/api/coder/sessions/batch-delete', async (c) => {
    const body = await c.req.json<{ ids?: number[] }>().catch(() => ({}) as { ids?: number[] });
    const ids = Array.isArray(body.ids) ? body.ids.filter((n) => Number.isFinite(n)) : [];
    if (ids.length === 0) return c.json({ error: 'ids required' }, 400);
    const deleted = sessionStore.deleteSessionsBatch(ids);
    return c.json({ ok: true, deleted });
  });

  app.patch('/api/coder/sessions/:id/archive', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const body = await c.req.json<{ archived?: boolean }>().catch(() => ({}) as { archived?: boolean });
    if (typeof body.archived !== 'boolean') {
      return c.json({ error: 'archived:boolean required' }, 400);
    }
    sessionStore.setSessionArchived(id, body.archived);
    const session = sessionStore.getSession(id);
    if (!session) return c.json({ error: 'Not found' }, 404);
    return c.json(session);
  });

  app.patch('/api/coder/sessions/:id/favorite', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const body = await c.req
      .json<{ favorite?: boolean }>()
      .catch(() => ({}) as { favorite?: boolean });
    if (typeof body.favorite !== 'boolean') {
      return c.json({ error: 'favorite:boolean required' }, 400);
    }
    sessionStore.setSessionFavorite(id, body.favorite);
    const session = sessionStore.getSession(id);
    if (!session) return c.json({ error: 'Not found' }, 404);
    return c.json(session);
  });

  app.post('/api/coder/sessions/:id/fork', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const body = await c.req
      .json<{ before_message_id?: number }>()
      .catch(() => ({}) as { before_message_id?: number });
    const beforeId = body.before_message_id;
    if (typeof beforeId !== 'number' || !Number.isFinite(beforeId)) {
      return c.json({ error: 'before_message_id:number required' }, 400);
    }
    try {
      const result = sessionStore.forkSessionBeforeMessage(id, beforeId);
      return c.json(result, 201);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 400);
    }
  });

  app.patch('/api/coder/sessions/:id/group', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const body = await c.req
      .json<{ group_id?: number | null }>()
      .catch(() => ({}) as { group_id?: number | null });
    if (body.group_id !== null && !Number.isFinite(body.group_id)) {
      return c.json({ error: 'group_id:number|null required' }, 400);
    }
    sessionStore.setSessionGroup(id, body.group_id ?? null);
    const session = sessionStore.getSession(id);
    if (!session) return c.json({ error: 'Not found' }, 404);
    return c.json(session);
  });

  app.post('/api/coder/sessions', async (c) => {
    const body = await c.req.json<CreateSessionBody>();
    if (!body.project_id || !body.title || !body.provider) {
      return c.json({ error: 'project_id, title, provider required' }, 400);
    }
    const session = sessionStore.createSession({
      project_id: body.project_id,
      title: body.title,
      provider: body.provider,
      model: body.model ?? '',
    });
    return c.json(session, 201);
  });

  app.get('/api/coder/sessions/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const full = c.req.query('full') === '1';
    const tailQ = c.req.query('tail');
    const tail = tailQ ? Math.max(1, parseInt(tailQ, 10) || 60) : 0;

    // When ?tail=N, only parse the last N messages (avoids heap pressure on
    // large sessions). Without ?tail, load everything for backward compat.
    const data = tail
      ? sessionStore.loadSessionMessagesTail(id, tail)
      : sessionStore.loadSessionWithMessages(id);
    if (!data) return c.json({ error: 'Not found' }, 404);

    const total_messages = sessionStore.getMessageCount(id);

    if (full) return c.json({ ...data, total_messages });

    // Trim heavy content for the dashboard list view. Originals stay in the DB.
    const TRIM_TOOL_RESULT = 4000;
    const trimmedMessages = data.messages.map((m) => ({
      ...m,
      content: m.content.map((block) => {
        const b = block as unknown as Record<string, unknown>;
        if (b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > TRIM_TOOL_RESULT) {
          return {
            ...b,
            content: (b.content as string).slice(0, TRIM_TOOL_RESULT),
            _truncated: true,
            _originalLength: (b.content as string).length,
          };
        }
        if ((b.type === 'image' || b.type === 'document') && typeof b.base64 === 'string') {
          const { base64: _omit, ...rest } = b;
          void _omit;
          return { ...rest, _hasBase64: true };
        }
        return b;
      }),
    }));
    return c.json({ ...data, messages: trimmedMessages, total_messages });
  });

  /**
   * Paginated message loading: fetch N messages before a given message id.
   * Used by the dashboard "Load earlier" button.
   */
  app.get('/api/coder/sessions/:id/messages', (c) => {
    const sessionId = parseInt(c.req.param('id'), 10);
    const session = sessionStore.getSession(sessionId);
    if (!session) return c.json({ error: 'Not found' }, 404);

    const beforeId = parseInt(c.req.query('before_id') ?? '0', 10);
    const limit = Math.max(1, Math.min(100, parseInt(c.req.query('limit') ?? '40', 10)));

    if (!beforeId) return c.json({ error: 'before_id required' }, 400);

    const data = sessionStore.loadMessagesBefore(sessionId, beforeId, limit);

    // Apply same trimming as the main endpoint
    const TRIM_TOOL_RESULT = 4000;
    const trimmedMessages = data.messages.map((m) => ({
      ...m,
      content: m.content.map((block) => {
        const b = block as unknown as Record<string, unknown>;
        if (b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > TRIM_TOOL_RESULT) {
          return {
            ...b,
            content: (b.content as string).slice(0, TRIM_TOOL_RESULT),
            _truncated: true,
            _originalLength: (b.content as string).length,
          };
        }
        if ((b.type === 'image' || b.type === 'document') && typeof b.base64 === 'string') {
          const { base64: _omit, ...rest } = b;
          void _omit;
          return { ...rest, _hasBase64: true };
        }
        return b;
      }),
    }));
    return c.json({ messages: trimmedMessages, message_rows: data.message_rows });
  });

  app.get('/api/coder/sessions/:id/stats', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const stats = sessionStore.getSessionStats(id);
    if (!stats) return c.json({ error: 'Not found' }, 404);
    return c.json(stats);
  });

  app.get('/api/coder/sessions/:id/messages/:mid/full', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const mid = parseInt(c.req.param('mid'), 10);
    const msg = sessionStore.getMessageById(id, mid);
    if (!msg) return c.json({ error: 'message not found' }, 404);
    return c.json({ id: msg.row.id, role: msg.role, content: msg.content });
  });

  app.delete('/api/coder/sessions/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    sessionStore.deleteSession(id);
    return c.json({ ok: true });
  });

  /**
   * Probe endpoint: returns whether a live run is currently attached to
   * the bus for this session. Used by the dashboard on session mount to
   * decide if it should open GET /attach instead of waiting for a new
   * POST /messages from the user.
   */
  app.get('/api/coder/sessions/:id/status', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const bus = activeRuns.get(id);
    return c.json({
      active: !!bus && !bus.ended,
      last_seq: bus ? bus.nextSeq - 1 : -1,
    });
  });

  // ─── Session Tool Config ──────────────────────────────────────

  /** List all tools (built-in + external MCP) with global + session disabled state. */
  app.get('/api/coder/sessions/:id/tools', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const session = sessionStore.getSession(id);
    if (!session) return c.json({ error: 'session not found' }, 404);

    const allTools = getAllKnownToolsMeta();
    const globalDisabled = new Set(deps.providerStore.listGlobalDisabledTools());
    const sessionDisabled = sessionStore.getSessionDisabledTools(id);

    // Include cached external MCP server tools (populated by test/connect)
    let externalTools: ReturnType<typeof enumerateExternalTools>['tools'] = [];
    try {
      const config = loadConfig();
      const result = enumerateExternalTools(config.dbPath);
      externalTools = result.tools;
    } catch {
      // Best-effort — don't break the tool list
    }

    const tools = [...allTools, ...externalTools].map((t) => ({
      name: t.name,
      tier: t.tier,
      source: t.source,
      description: t.description,
      globallyDisabled: globalDisabled.has(t.name),
      sessionDisabled: sessionDisabled.has(t.name),
    }));
    return c.json({ tools, disabledCount: sessionDisabled.size });
  });

  /** Toggle a single tool for a session. */
  app.put('/api/coder/sessions/:id/tools/:name/disabled', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const toolName = c.req.param('name');
    const body = await c.req.json<{ disabled: boolean }>();
    if (typeof body.disabled !== 'boolean') {
      return c.json({ error: 'disabled (boolean) required' }, 400);
    }
    sessionStore.setSessionToolDisabled(id, toolName, body.disabled);
    return c.json({ ok: true });
  });

  /** Batch toggle tools for a session. */
  app.put('/api/coder/sessions/:id/tools/bulk-disabled', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const body = await c.req.json<{
      tools: Array<{ name: string; disabled: boolean }>;
    }>();
    if (!Array.isArray(body.tools)) {
      return c.json({ error: 'tools array required' }, 400);
    }
    const tx = (() => {
      for (const t of body.tools) {
        sessionStore.setSessionToolDisabled(id, t.name, t.disabled);
      }
    });
    tx();
    return c.json({ ok: true });
  });

  /** Copy tool config from another session. */
  app.post('/api/coder/sessions/:id/tools/copy-from/:sourceId', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const sourceId = parseInt(c.req.param('sourceId'), 10);
    const copiedCount = sessionStore.copyToolConfig(sourceId, id);
    return c.json({ ok: true, copiedCount });
  });
}
