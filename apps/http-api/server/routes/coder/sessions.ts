import type { Hono } from 'hono';
import type { CoderProviderName } from '@mcp/code-agent/index.js';
import { AGENTS } from '@mcp/code-agent/agents/index.js';
import { getAllKnownToolsMeta, getToolTier, inferProfileFromMessage, TIER_COUNTS } from '@mcp/code-agent/tools/tiers.js';
import { getModelContextWindow } from '@mcp/code-agent/providers/capabilities.js';
import { runGeneralAi, GeneralAiNotConfiguredError } from '@mcp/services/ai-general/generalClient.js';
import { enumerateExternalTools } from '../../../admin/mcp-servers.routes.js';
import { loadConfig } from '@mcp/shared/utils/config.js';
import type { ServerDeps } from '../../deps.js';
import type { CoderRuntime } from './state.js';
import { parseIdParam, parseIntQuery, parseJsonBody, notFound } from '../_helpers.js';

/**
 * Trim heavy inline content (tool_result strings and image/document base64)
 * before serializing to the dashboard. Originals stay in the DB.
 * Extracted so both the session-detail and paginated-messages endpoints use
 * exactly the same shape.
 */
const TRIM_TOOL_RESULT = 4000;
function trimMessageBlocks<M extends { role?: string; content: unknown[] }>(messages: M[]): M[] {
  return messages.map((m) => {
    // Synthetic tool-image plumbing message (view_image / preview_screenshot →
    // a user/image block). The dashboard renders this image INLINE under the
    // tool call on reload, so keep its base64 (no upload endpoint to re-fetch
    // a tool screenshot, unlike a user upload).
    const isToolImageMsg =
      m.role !== 'assistant' &&
      m.content.some(
        (b) =>
          (b as Record<string, unknown>).type === 'text' &&
          String((b as Record<string, unknown>).text ?? '').trim() ===
            '(Image(s) attached from the tool call above.)',
      );
    return {
    ...m,
    content: m.content.map((block) => {
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > TRIM_TOOL_RESULT) {
        return {
          ...b,
          content: (b.content as string).slice(0, TRIM_TOOL_RESULT),
          _truncated: true,
          _originalLength: (b.content as string).length,
        };
      }
      // Preserve assistant-emitted images (e.g. server-managed image_generation
      // results from Codex). Stripping their base64 would lose the image on
      // session reload — there's no upload endpoint to re-fetch them from.
      // User-side image/document uploads still get trimmed: they're stored
      // verbatim and the dashboard fetches them on demand. Tool-produced images
      // (isToolImageMsg) are kept too — rendered inline, no re-fetch path.
      if (
        (b.type === 'image' || b.type === 'document') &&
        typeof b.base64 === 'string' &&
        m.role !== 'assistant' &&
        !isToolImageMsg
      ) {
        const { base64: _omit, ...rest } = b;
        void _omit;
        return { ...rest, _hasBase64: true };
      }
      return b;
    }),
    };
  });
}

type GenerateTitleBody = {
  content?: unknown;
  text?: unknown;
  message?: unknown;
};

function textFromUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const block = item as { type?: unknown; text?: unknown };
          if (block.type === 'text' && typeof block.text === 'string') return block.text;
        }
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  if (value && typeof value === 'object') {
    const block = value as { type?: unknown; text?: unknown };
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return '';
}

function cleanTitleSeed(text: string): string {
  return text
    .replace(/<file_refs>[\s\S]*?<\/file_refs>/g, '')
    .replace(/<active_skills>[\s\S]*?<\/active_skills>/g, '')
    .replace(/<active-context>[\s\S]*?<\/active-context>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function extractTitleSeedFromBody(body: Partial<GenerateTitleBody>): string {
  return cleanTitleSeed(
    textFromUnknown(body.content)
      || textFromUnknown(body.text)
      || textFromUnknown(body.message),
  );
}

function extractTitleSeedFromRow(contentJson: string): string {
  const blocks = JSON.parse(contentJson) as unknown;
  return cleanTitleSeed(textFromUnknown(blocks));
}

function cleanGeneratedTitle(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?;:]+$/g, '')
    .trim()
    .slice(0, 80);
}

interface CreateSessionBody {
  project_id: number;
  title: string;
  provider: CoderProviderName;
  model?: string;
  /** Initial agent preset (explore | plan | build | admin). Persisted on the session row. */
  agent?: 'explore' | 'plan' | 'build' | 'admin' | 'spec';
  /** Optional phase profile binding (Camada 2). Null = walk cascade. */
  phase_profile_id?: number | null;
}

export function mountCoderSessionsRoutes(
  app: Hono,
  deps: ServerDeps,
  runtime: CoderRuntime,
): void {
  const { sessionStore, providerStore } = deps;
  const { activeRuns } = runtime;

  /**
   * Global recent sessions, cross-project. Powers the main app sidebar
   * "Recent" list. NOTE: this route must be registered BEFORE the
   * /api/coder/sessions/:id routes so Hono doesn't interpret "recent" as
   * an id parameter.
   */
  app.get('/api/coder/sessions/recent', (c) => {
    const limit = Math.max(1, Math.min(50, parseIntQuery(c, 'limit', 10)));
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
    let agent: 'explore' | 'plan' | 'build' | 'admin' | 'spec';
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
    const projectId = parseIntQuery(c, 'project_id', 0);
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
    const body = await parseJsonBody<{ ids?: number[] }>(c);
    const ids = Array.isArray(body.ids) ? body.ids.filter((n) => Number.isFinite(n)) : [];
    if (ids.length === 0) return c.json({ error: 'ids required' }, 400);
    const deleted = sessionStore.deleteSessionsBatch(ids);
    return c.json({ ok: true, deleted });
  });

  app.patch('/api/coder/sessions/:id/archive', async (c) => {
    const id = parseIdParam(c);
    const body = await parseJsonBody<{ archived?: boolean }>(c);
    if (typeof body.archived !== 'boolean') {
      return c.json({ error: 'archived:boolean required' }, 400);
    }
    sessionStore.setSessionArchived(id, body.archived);
    const session = sessionStore.getSession(id);
    if (!session) return notFound(c);
    return c.json(session);
  });

  app.patch('/api/coder/sessions/:id/favorite', async (c) => {
    const id = parseIdParam(c);
    const body = await parseJsonBody<{ favorite?: boolean }>(c);
    if (typeof body.favorite !== 'boolean') {
      return c.json({ error: 'favorite:boolean required' }, 400);
    }
    sessionStore.setSessionFavorite(id, body.favorite);
    const session = sessionStore.getSession(id);
    if (!session) return notFound(c);
    return c.json(session);
  });

  app.post('/api/coder/sessions/:id/generate-title', async (c) => {
    const id = parseIdParam(c);
    const src = sessionStore.loadSessionWithMessages(id);
    if (!src) return notFound(c);

    const body = await parseJsonBody<GenerateTitleBody>(c);
    let text = extractTitleSeedFromBody(body);
    if (!text) {
      const firstUser = src.message_rows.find((r) => r.role === 'user');
      if (!firstUser) {
        console.warn(`[generate-title] session=${id}: no user messages yet and no request content`);
        return c.json({ error: 'no messages yet' }, 400);
      }
      try {
        text = extractTitleSeedFromRow(firstUser.content_json);
      } catch (e) {
        console.warn(`[generate-title] session=${id}: malformed content_json:`, e);
        return c.json({ error: 'first message content is malformed JSON' }, 400);
      }
    }
    if (!text) {
      console.warn(`[generate-title] session=${id}: no text content for title generation`);
      return c.json({ error: 'no text content for title generation' }, 400);
    }

    const prompt =
      `Generate a concise title (3-7 words, no quotes, no trailing punctuation) for a chat session that starts with this user message:\n\n${text}\n\nRespond with only the title.`;

    let title = '';
    try {
      title = await runGeneralAi(prompt, {
        system:
          'You generate short chat session titles. Respond with only the title, no quotes, no punctuation, no markdown.',
      });
    } catch (e) {
      if (e instanceof GeneralAiNotConfiguredError) {
        return c.json({ error: e.message, code: 'general_ai_not_configured' }, 412);
      }
      console.warn(
        `[generate-title] session=${id}: general AI call failed:`,
        e,
      );
      return c.json({ error: `AI call failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
    }

    title = cleanGeneratedTitle(title);
    if (!title) return c.json({ error: 'empty title generated' }, 400);

    sessionStore.setSessionTitle(id, title);
    return c.json({ title });
  });

  app.patch('/api/coder/sessions/:id/title', async (c) => {
    const id = parseIdParam(c);
    const body = await parseJsonBody<{ title?: string }>(c);
    const title = (body.title ?? '').trim();
    if (!title) return c.json({ error: 'title must be a non-empty string' }, 400);
    const session = sessionStore.getSession(id);
    if (!session) return notFound(c);
    sessionStore.setSessionTitle(id, title);
    return c.json(sessionStore.getSession(id));
  });

  app.post('/api/coder/sessions/:id/duplicate', (c) => {
    const id = parseIdParam(c);
    try {
      const session = sessionStore.duplicateSession(id);
      return c.json({ session }, 201);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 400);
    }
  });

  app.post('/api/coder/sessions/:id/fork', async (c) => {
    const id = parseIdParam(c);
    const body = await parseJsonBody<{ before_message_id?: number }>(c);
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

  app.patch('/api/coder/sessions/:id/temperature', async (c) => {
    const id = parseIdParam(c);
    const body = await parseJsonBody<{ temperature?: number | null }>(c);
    const t = body.temperature;
    if (t !== null && (typeof t !== 'number' || !Number.isFinite(t))) {
      return c.json({ error: 'temperature:number|null required' }, 400);
    }
    sessionStore.setSessionTemperature(id, t ?? null);
    const session = sessionStore.getSession(id);
    if (!session) return notFound(c);
    return c.json(session);
  });

  app.patch('/api/coder/sessions/:id/unrestricted-output', async (c) => {
    const id = parseIdParam(c);
    const body = await parseJsonBody<{ enabled?: boolean | null }>(c);
    const v = body.enabled;
    if (v !== null && v !== undefined && typeof v !== 'boolean') {
      return c.json({ error: 'enabled:boolean|null required' }, 400);
    }
    sessionStore.setSessionUnrestrictedToolOutput(id, v ?? null);
    const session = sessionStore.getSession(id);
    if (!session) return notFound(c);
    return c.json(session);
  });

  app.patch('/api/coder/sessions/:id/group', async (c) => {
    const id = parseIdParam(c);
    const body = await parseJsonBody<{ group_id?: number | null }>(c);
    if (body.group_id !== null && !Number.isFinite(body.group_id)) {
      return c.json({ error: 'group_id:number|null required' }, 400);
    }
    sessionStore.setSessionGroup(id, body.group_id ?? null);
    const session = sessionStore.getSession(id);
    if (!session) return notFound(c);
    return c.json(session);
  });

  app.post('/api/coder/sessions', async (c) => {
    const body = await c.req.json<CreateSessionBody>();
    if (!body.project_id || !body.title || !body.provider) {
      return c.json({ error: 'project_id, title, provider required' }, 400);
    }
    // Builder projects (projects.builder_json set) default the chat agent to
    // `builder` (persona + scope) unless the caller passed an explicit agent.
    const isBuilderProject = !!deps.db.getProject(body.project_id)?.builder_json;
    const session = sessionStore.createSession({
      project_id: body.project_id,
      title: body.title,
      provider: body.provider,
      model: body.model ?? '',
      agent: body.agent ?? (isBuilderProject ? 'builder' : null),
      phase_profile_id: body.phase_profile_id ?? null,
    });
    // Best-effort base_commit_sha capture for Camada 4's reviewer subagent.
    // We need the project workdir to run `git rev-parse HEAD`. If the project
    // isn't a git repo, or the workdir lookup fails, leave it null and the
    // reviewer will fall back to running `git_diff` itself (or report no diff).
    try {
      const project = (deps as { projectStore?: { getProject?: (id: number) => { workdir?: string | null } | null } }).projectStore?.getProject?.(body.project_id);
      const workdir = project?.workdir;
      if (workdir) {
        const { execSync } = await import('node:child_process');
        const sha = execSync('git rev-parse HEAD', { cwd: workdir, encoding: 'utf8', timeout: 2000 }).trim();
        if (sha && /^[0-9a-f]{40}$/i.test(sha)) {
          sessionStore.setSessionBaseCommit(session.id, sha);
        }
      }
    } catch {
      /* not a git repo or no workdir — fine, reviewer handles this */
    }
    return c.json(session, 201);
  });

  app.get('/api/coder/sessions/:id', (c) => {
    const id = parseIdParam(c);
    const full = c.req.query('full') === '1';
    const tailQ = c.req.query('tail');
    const tail = tailQ ? Math.max(1, parseInt(tailQ, 10) || 60) : 0;

    // When ?tail=N, only parse the last N messages (avoids heap pressure on
    // large sessions). Without ?tail, load everything for backward compat.
    const data = tail
      ? sessionStore.loadSessionMessagesTail(id, tail)
      : sessionStore.loadSessionWithMessages(id);
    if (!data) return notFound(c);

    const total_messages = sessionStore.getMessageCount(id);
    // Count of pre-boundary rows hidden by a manual "summarize & clear" — the
    // dashboard shows a "view earlier history" affordance when this is > 0.
    const archived_count = sessionStore.getArchivedMessageCount(id);

    if (full) return c.json({ ...data, total_messages, archived_count });

    return c.json({ ...data, messages: trimMessageBlocks(data.messages), total_messages, archived_count });
  });

  /**
   * Paginated message loading: fetch N messages before a given message id.
   * Used by the dashboard "Load earlier" button.
   */
  app.get('/api/coder/sessions/:id/messages', (c) => {
    const sessionId = parseIdParam(c);
    const session = sessionStore.getSession(sessionId);
    if (!session) return notFound(c);

    const beforeId = parseIntQuery(c, 'before_id', 0);
    const limit = Math.max(1, Math.min(100, parseIntQuery(c, 'limit', 40)));
    // Cross a manual "summarize & clear" boundary to reveal the archived
    // (pre-summary) transcript — driven by the dashboard's "view earlier
    // history" button.
    const includeArchived = c.req.query('include_archived') === '1';

    if (!beforeId) return c.json({ error: 'before_id required' }, 400);

    const data = sessionStore.loadMessagesBefore(sessionId, beforeId, limit, includeArchived);
    return c.json({ messages: trimMessageBlocks(data.messages), message_rows: data.message_rows });
  });

  app.get('/api/coder/sessions/:id/stats', (c) => {
    const id = parseIdParam(c);
    const stats = sessionStore.getSessionStats(id);
    if (!stats) return notFound(c);
    // Resolve context window DB-first, then fall back to static registry.
    const session = sessionStore.getSession(id);
    let context_window: number | null = null;
    if (session) {
      const dbModel = deps.providerStore.listModels(session.provider).find((m) => m.model_id === session.model);
      context_window = dbModel?.context_window ?? getModelContextWindow(session.model);
    }
    return c.json({ ...stats, context_window });
  });

  app.get('/api/coder/sessions/:id/messages/:mid/full', (c) => {
    const id = parseIdParam(c);
    const mid = parseIdParam(c, 'mid');
    const msg = sessionStore.getMessageById(id, mid);
    if (!msg) return notFound(c, 'message not found');
    return c.json({ id: msg.row.id, role: msg.role, content: msg.content });
  });

  app.delete('/api/coder/sessions/:id', (c) => {
    const id = parseIdParam(c);
    sessionStore.deleteSession(id);
    return c.json({ ok: true });
  });

  /**
   * Goal + active tasks summary. Single endpoint so the dashboard can pin
   * a "session header" widget without juggling two requests. Both fields
   * are nullable — a session with no goal AND no tasks returns nulls.
   */
  app.get('/api/coder/sessions/:id/state-summary', (c) => {
    const id = parseIdParam(c);
    const session = sessionStore.getSession(id);
    if (!session) return notFound(c, 'session not found');
    const goal = sessionStore.getSessionGoal(id);
    const tasks = sessionStore.getTasksState(id);
    // Parse the persisted todos JSON so a fresh dashboard mount can populate
    // the sidebar immediately, without waiting for the runner to emit a
    // todos_updated SSE event. Resolves the "estado some no resume" report.
    let todos: Array<{ id?: string; content: string; activeForm: string; status: string }> = [];
    if (session.todos_json) {
      try {
        const parsed = JSON.parse(session.todos_json) as unknown;
        if (Array.isArray(parsed)) {
          todos = parsed.map((t) => {
            const o = (t ?? {}) as Record<string, unknown>;
            return {
              id: typeof o.id === 'string' ? o.id : undefined,
              content: typeof o.content === 'string' ? o.content : '',
              activeForm: typeof o.activeForm === 'string' ? o.activeForm : '',
              status: typeof o.status === 'string' ? o.status : 'pending',
            };
          });
        }
      } catch {
        // Malformed JSON: fall through with todos = []
      }
    }
    return c.json({
      goal: goal
        ? {
            text: goal.text,
            status: goal.status,
            budget_tokens: goal.budgetTokens,
            completion_note: goal.completionNote,
            created_at: goal.createdAt,
            updated_at: goal.updatedAt,
          }
        : null,
      tasks: tasks
        ? {
            summary: tasks.summary,
            approved: tasks.approved,
            execution_mode: tasks.execution_mode,
            current_task_id: tasks.current_task_id,
            tasks: tasks.tasks.map((t) => ({
              id: t.id,
              title: t.title,
              status: t.status,
              files: t.files,
            })),
          }
        : null,
      todos,
    });
  });

  /**
   * Probe endpoint: returns whether a live run is currently attached to
   * the bus for this session. Used by the dashboard on session mount to
   * decide if it should open GET /attach instead of waiting for a new
   * POST /messages from the user.
   */
  app.get('/api/coder/sessions/:id/status', (c) => {
    const id = parseIdParam(c);
    const bus = activeRuns.get(id);
    return c.json({
      active: !!bus && !bus.ended,
      last_seq: bus ? bus.nextSeq - 1 : -1,
    });
  });

  // ─── Session Tool Config ──────────────────────────────────────

  /** List all tools (built-in + external MCP) with global + session disabled state. */
  app.get('/api/coder/sessions/:id/tools', (c) => {
    const id = parseIdParam(c);
    const session = sessionStore.getSession(id);
    if (!session) return notFound(c, 'session not found');

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
    const id = parseIdParam(c);
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
    const id = parseIdParam(c);
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
    const id = parseIdParam(c);
    const sourceId = parseIdParam(c, 'sourceId');
    const copiedCount = sessionStore.copyToolConfig(sourceId, id);
    return c.json({ ok: true, copiedCount });
  });
}
