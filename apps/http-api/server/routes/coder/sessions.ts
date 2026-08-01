import type { Hono } from 'hono';
import type { CoderProviderName } from '@mcp/code-agent/index.js';
import type { CoderExecutionMode } from '@mcp/code-agent/sessions/types.js';
import type { SessionId } from '@mcp/agent-runtime-contracts';
import type { JsonValue } from '@mcp/session-storage';
import { selectRuntimeModelMetadata } from '@mcp/provider-sdk';
import { TOOL_OUTPUT_CAP_LEVELS, parseToolOutputCapLevel } from '@mcp/code-agent/core/runner/output-caps.js';
import { AGENTS } from '@mcp/code-agent/agents/index.js';
import { decide } from '@mcp/code-agent/agents/decision-engine.js';
import { getAllKnownToolsMeta, getToolTier, TIER_COUNTS } from '@mcp/code-agent/tools/tiers.js';
import { getModelContextWindow } from '@mcp/code-agent/providers/capabilities.js';
import {
  cleanSessionTitleSeed,
  isAutomaticSessionTitle,
} from '@mcp/services/services/task-preflight/index.js';
import { enumerateExternalTools } from '../../../admin/mcp-servers.routes.js';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { TOOL_PERMISSION_MODES } from '@mcp/code-agent/core/permission-gate.js';
import { deriveTodosFromState, effectiveGate } from '@mcp/code-agent/tools/task-list-shared.js';
import type { ServerDeps } from '../../deps.js';
import type { CoderRuntime } from './state.js';
import {
  parseIntQuery,
  parseJsonBody,
  parseSeqParam,
  parseSeqQuery,
  parseSeqValue,
  parseSessionIdParam,
  parseSessionIdValue,
  notFound,
} from '../_helpers.js';
import {
  createGlobalWorkspaceSession,
  reuseGlobalWorkspaceSession,
  attachProjectToGlobalSession,
  detachProjectFromGlobalSession,
  GlobalWorkspaceError,
} from './global-workspace.js';
import { getCoderWorkerPool } from '../../../sse/coderWorkerPoolSingleton.js';
import {
  listCustomAgents,
  resolveAgentSelection,
  type AgentSelectionId,
} from '../../../custom-agents.js';
import { withSessionLock } from './sessionLock.js';
import {
  DEFAULT_SESSION_MAX_AUTO_CONTINUES,
  MAX_SESSION_AUTO_CONTINUES,
  MAX_SESSION_TURNS,
} from '@mcp/code-agent/sessions/run-limits.js';

/**
 * Trim heavy inline content (tool_result strings and image/document base64)
 * before serializing to the dashboard. Originals stay in the DB.
 * Extracted so both the session-detail and paginated-messages endpoints use
 * exactly the same shape.
 */
/** Allowed plan-depth values for the `plan` agent (migration 151). */
const PLAN_DEPTHS = ['simple', 'normal', 'complex'] as const;
type PlanDepth = (typeof PLAN_DEPTHS)[number];

/** Allowed output-style values (migration 178). */
const OUTPUT_STYLES = ['proactive', 'explanatory', 'learning'] as const;
type OutputStyle = (typeof OUTPUT_STYLES)[number];

/** Provider-independent agent orchestration mode (migration 241). */
const EXECUTION_MODES = ['standard', 'ultra'] as const satisfies readonly CoderExecutionMode[];

function isExecutionMode(value: unknown): value is CoderExecutionMode {
  return typeof value === 'string' && EXECUTION_MODES.includes(value as CoderExecutionMode);
}

type CreationExecutionSettings =
  | { ok: true; executionMode: CoderExecutionMode; reasoningEffort: string | null }
  | { ok: false; error: string };

/**
 * Normalize both the migration-241 contract and the legacy UI contract. Old
 * clients sent `reasoning_effort: "ultra"`; retain that intent as orchestration
 * mode while guaranteeing the literal is never persisted/forwarded as effort.
 */
function resolveCreationExecutionSettings(
  executionMode: unknown,
  rawReasoningEffort: unknown,
): CreationExecutionSettings {
  if (executionMode !== undefined && !isExecutionMode(executionMode)) {
    return { ok: false, error: `execution_mode: one of ${EXECUTION_MODES.join('|')} required` };
  }
  if (rawReasoningEffort !== undefined && rawReasoningEffort !== null && typeof rawReasoningEffort !== 'string') {
    return { ok: false, error: 'reasoning_effort:string|null required' };
  }
  const normalizedEffort = typeof rawReasoningEffort === 'string'
    ? rawReasoningEffort.trim() || null
    : null;
  const legacyUltra = normalizedEffort?.toLowerCase() === 'ultra';
  return {
    ok: true,
    // The first-class field is authoritative when both old and new clients'
    // spellings are present. The legacy sentinel only supplies a missing mode.
    executionMode: isExecutionMode(executionMode)
      ? executionMode
      : legacyUltra
        ? 'ultra'
        : 'standard',
    reasoningEffort: legacyUltra ? null : normalizedEffort,
  };
}

/** Upper bound on a response-language label (migration 177) — a language name, not prose. */
const MAX_RESPONSE_LANGUAGE_LEN = 64;

const TRIM_TOOL_RESULT = 4000;

function isSpawnAgentTool(name: unknown): boolean {
  return name === 'spawn_agent' || name === 'spawn_agents';
}

function collectToolNamesByUseId(messages: Array<{ content: unknown[] }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of messages) {
    for (const block of m.content) {
      const b = block as Record<string, unknown>;
      if (b?.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        out.set(b.id, b.name);
      }
    }
  }
  return out;
}

function compactSpawnAgentResult(content: string): string {
  const matches = [...content.matchAll(/^###\s+Agent\s+\d+:\s+.*$/gm)];
  if (matches.length === 0) return content.slice(0, TRIM_TOOL_RESULT);

  const headerStart = matches[0].index ?? 0;
  const header = content.slice(0, headerStart).trimEnd();
  const targetChars = Math.max(TRIM_TOOL_RESULT, 8000);
  const fixedOverhead = header.length + matches.length * 180;
  const bodyBudget = Math.max(260, Math.floor((targetChars - fixedOverhead) / matches.length));

  const sections: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index ?? 0;
    const nextStart = matches[i + 1]?.index ?? content.length;
    const rawSection = content
      .slice(start, nextStart)
      .replace(/\n\s*---\s*$/, '')
      .trim();
    const lines = rawSection.split('\n');
    const title = lines.shift() ?? '';
    const meta = lines.shift() ?? '';
    const body = lines.join('\n').trim();
    const preview =
      body.length > bodyBudget
        ? `${body.slice(0, bodyBudget).trimEnd()}\n\n… [agent report truncated for transport]`
        : body;
    sections.push([title, meta, preview].filter(Boolean).join('\n'));
  }

  const compact = `${header ? `${header}\n\n` : ''}${sections.join('\n\n---\n\n')}`;
  return compact.length < content.length ? compact : content;
}

function trimToolResultContent(content: string, toolName: unknown): string {
  if (content.length <= TRIM_TOOL_RESULT) return content;
  if (isSpawnAgentTool(toolName)) return compactSpawnAgentResult(content);
  return content.slice(0, TRIM_TOOL_RESULT);
}

function trimMessageBlocks<M extends { role?: string; content: unknown[] }>(messages: M[]): M[] {
  const toolNamesByUseId = collectToolNamesByUseId(messages);
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
        const toolName = typeof b.tool_use_id === 'string' ? toolNamesByUseId.get(b.tool_use_id) : undefined;
        const content = b.content as string;
        const trimmedContent = trimToolResultContent(content, toolName);
        if (trimmedContent.length >= content.length) return b;
        return {
          ...b,
          content: trimmedContent,
          _truncated: true,
          _originalLength: content.length,
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

/**
 * Read-time status repair: for tool_use blocks whose `tool_result` block is
 * absent from the loaded window, look up the recorded result in the
 * session bundle's tool-call records. The dashboard seeds these into its
 * tool-result map so the call renders its real terminal status instead of a
 * perpetual "loading" spinner. This heals sessions written before the
 * paired-persistence fix (where a mid-run compaction dropped the tool message
 * while the audit row survived). Empty for healthy sessions — every block is
 * already paired — so it adds nothing to the common-case payload.
 */
async function reconstructMissingToolResults(
  sessionStore: ServerDeps['sessionStore'],
  sessionId: SessionId,
  messages: Array<{ role?: string; content: unknown }>,
): Promise<Array<{ tool_use_id: string; content: string; is_error: boolean; _truncated?: boolean; _originalLength?: number }>> {
  const useIds = new Set<string>();
  const resIds = new Set<string>();
  const toolNamesByUseId = new Map<string, string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content as Array<Record<string, unknown>>) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        useIds.add(block.id);
        if (typeof block.name === 'string') toolNamesByUseId.set(block.id, block.name);
      }
      else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') resIds.add(block.tool_use_id);
    }
  }
  const missing = [...useIds].filter((id) => !resIds.has(id));
  if (missing.length === 0) return [];
  return (await sessionStore.getToolResultsByToolUseIds(sessionId, missing)).map((r) => {
    const content =
      r.result_text.length > TRIM_TOOL_RESULT
        ? trimToolResultContent(r.result_text, toolNamesByUseId.get(r.tool_use_id))
        : r.result_text;
    const trimmed = content.length < r.result_text.length;
    return {
      tool_use_id: r.tool_use_id,
      content,
      is_error: r.is_error,
      ...(trimmed ? { _truncated: true, _originalLength: r.result_text.length } : {}),
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

function extractTitleSeedFromBody(body: Partial<GenerateTitleBody>): string {
  return cleanSessionTitleSeed(
    textFromUnknown(body.content)
      || textFromUnknown(body.text)
      || textFromUnknown(body.message),
  );
}

function extractTitleSeedFromRow(contentJson: string): string {
  const blocks = JSON.parse(contentJson) as unknown;
  return cleanSessionTitleSeed(textFromUnknown(blocks));
}

interface CreateGlobalSessionBody {
  title: string;
  provider: CoderProviderName;
  model?: string;
  agent?: string | null;
  /** Which linked project is the native cwd. Defaults to project_ids[0]. */
  primary_project_id?: number;
  /** All linked projects (including the primary). At least one required. */
  project_ids: number[];
  /** Copy the linked roots from an existing global session. */
  reuse_session_id?: SessionId;
  /** Provider-independent orchestration mode. */
  execution_mode?: CoderExecutionMode;
  /** Native provider effort; legacy `ultra` is converted to execution_mode. */
  reasoning_effort?: string | null;
  /** Null/omitted means unlimited. */
  max_turns?: number | null;
  max_auto_continues?: number;
}

interface CreateSessionBody {
  project_id: number;
  title: string;
  provider?: CoderProviderName;
  model?: string;
  /** Prefer the most recently active provider/model; explicit values are fallback. */
  use_last_model?: boolean;
  /** Initial agent preset. Persisted on the session row. */
  agent?: AgentSelectionId;
  /** Sticky reasoning-effort override for the new session. Null = model default. */
  reasoning_effort?: string | null;
  /** Provider-independent orchestration mode. Defaults to standard. */
  execution_mode?: CoderExecutionMode;
  /** Initial sticky extended-thinking state. Defaults to false. */
  thinking_enabled?: boolean;
  /** Null/omitted means unlimited. */
  max_turns?: number | null;
  max_auto_continues?: number;
  /** Optional phase profile binding (Camada 2). Null = walk cascade. */
  phase_profile_id?: number | null;
  /** Trusted host metadata persisted with the filesystem bundle. */
  metadata?: Readonly<Record<string, JsonValue>>;
}

export function mountCoderSessionsRoutes(
  app: Hono,
  deps: ServerDeps,
  _runtime: CoderRuntime,
): void {
  const { sessionStore, providerStore } = deps;
  const workerPool = getCoderWorkerPool();

  const enabledSelectedModel = (
    selected: { provider: string; model: string } | null | undefined,
  ): { provider: string; model: string } | null => {
    if (!selected || !providerStore.getProvider(selected.provider)?.enabled) {
      return null;
    }
    const [modelId, mode = ''] = selected.model.split('::');
    const enabled = providerStore
      .listModels(selected.provider, true)
      .some((candidate) => (
        candidate.model_id === modelId
        && (!mode || candidate.mode === mode)
      ));
    return enabled ? selected : null;
  };

  const resolveLastSelectedModel = async (): Promise<{
    provider: string;
    model: string;
  } | null> => {
    const persisted = enabledSelectedModel(
      await deps.coderPreferences?.getLastSelectedModel(),
    );
    if (persisted) return persisted;
    return enabledSelectedModel(
      await sessionStore.getLastUsedProviderModel(),
    );
  };

  const rememberSelectedModel = (provider: string, model: string): void => {
    if (!provider.trim() || !model.trim()) return;
    void deps.coderPreferences
      ?.setLastSelectedModel(provider, model)
      .catch((error) => {
        console.warn(
          `[coder-preferences] could not persist last selected model: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  };

  const validateAgentSelection = (value: unknown): value is AgentSelectionId =>
    resolveAgentSelection(providerStore, value) !== null;

  // Abort a session's live worker run before trashing its bundle.
  const abortActiveRun = async (id: SessionId): Promise<void> => {
    try {
      await workerPool.abort(id);
    } catch {
      /* best-effort — teardown still proceeds */
    }
  };

  // Is a run in flight for this session? Used to reject mutations that must not
  // race a live run. Linked roots are read at run start, so mutations take
  // effect on the next run.
  const isRunActive = (id: SessionId): boolean => {
    try {
      return workerPool.isRunning(id);
    } catch {
      return false;
    }
  };

  const validateReasoningEffort = (
    provider: string,
    model: string | undefined,
    effort: string | null,
  ): string | null => {
    if (!effort) return null;
    const row = selectRuntimeModelMetadata(providerStore.listModels(provider), model ?? '');
    const supported = row?.supported_reasoning_levels;
    if (supported && supported.length > 0 && !supported.includes(effort)) {
      return `reasoning effort '${effort}' not supported for ${model ?? '(default model)'}; supported: ${supported.join(',')}`;
    }
    return null;
  };

  const validateRunLimits = (
    maxTurns: unknown,
    maxAutoContinues: unknown,
  ):
    | { ok: true; maxTurns: number | null; maxAutoContinues: number }
    | { ok: false; error: string } => {
    if (
      maxTurns !== undefined
      && maxTurns !== null
      && (
        typeof maxTurns !== 'number'
        || !Number.isSafeInteger(maxTurns)
        || maxTurns < 1
        || maxTurns > MAX_SESSION_TURNS
      )
    ) {
      return {
        ok: false,
        error: `max_turns must be null or an integer from 1 to ${MAX_SESSION_TURNS}`,
      };
    }
    if (
      maxAutoContinues !== undefined
      && (
        typeof maxAutoContinues !== 'number'
        || !Number.isSafeInteger(maxAutoContinues)
        || maxAutoContinues < 0
        || maxAutoContinues > MAX_SESSION_AUTO_CONTINUES
      )
    ) {
      return {
        ok: false,
        error: `max_auto_continues must be an integer from 0 to ${MAX_SESSION_AUTO_CONTINUES}`,
      };
    }
    return {
      ok: true,
      maxTurns: maxTurns == null ? null : maxTurns,
      maxAutoContinues:
        maxAutoContinues === undefined
          ? DEFAULT_SESSION_MAX_AUTO_CONTINUES
          : maxAutoContinues,
    };
  };

  /**
   * Global recent sessions, cross-project. Powers the main app sidebar
   * "Recent" list. NOTE: this route must be registered BEFORE the
   * /api/coder/sessions/:id routes so Hono doesn't interpret "recent" as
   * an id parameter.
   */
  app.get('/api/coder/sessions/recent', async (c) => {
    const limit = Math.max(1, Math.min(50, parseIntQuery(c, 'limit', 10)));
    return c.json(await sessionStore.listRecentSessionsGlobal(limit));
  });

  /**
   * Global (multi-project) sessions list — powers the "Sessões Globais" menu.
   * MUST be registered BEFORE the /api/coder/sessions/:id routes (same reason
   * as /recent: Hono would otherwise read "global" as an id).
   */
  app.get('/api/coder/sessions/global', async (c) => {
    const archivedQ = c.req.query('archived');
    let archived: boolean | null = false;
    if (archivedQ === '1' || archivedQ === 'true') archived = true;
    else if (archivedQ === 'all') archived = null;
    return c.json(await sessionStore.listGlobalSessions({ archived }));
  });

  /**
   * Existing global bundles whose real linked-root set can seed a new session.
   * The returned id is the source session UUID, never a synthetic project id.
   */
  app.get('/api/coder/global-workspaces', async (c) => {
    const workspaces = (await sessionStore.listGlobalSessions()).map((session) => ({
      id: session.id,
      label: session.workspace_label || session.title,
      sessionCount: 1,
    }));
    return c.json(workspaces);
  });

  /**
   * Create a global UUID bundle over real linked project roots. The primary
   * project is the default cwd; every root remains first-class in run context.
   */
  app.post('/api/coder/sessions/global', async (c) => {
    const body = await parseJsonBody<CreateGlobalSessionBody>(c);
    if (!body.title || !body.provider) {
      return c.json({ error: 'title, provider required' }, 400);
    }
    if (body.agent != null && !validateAgentSelection(body.agent)) {
      return c.json({ error: 'unknown or disabled agent' }, 400);
    }
    const execution = resolveCreationExecutionSettings(body.execution_mode, body.reasoning_effort);
    if (!execution.ok) return c.json({ error: execution.error }, 400);
    const runLimits = validateRunLimits(
      body.max_turns,
      body.max_auto_continues,
    );
    if (!runLimits.ok) return c.json({ error: runLimits.error }, 400);
    const effortError = validateReasoningEffort(body.provider, body.model, execution.reasoningEffort);
    if (effortError) return c.json({ error: effortError }, 400);
    if (body.reuse_session_id) {
      try {
        const reuseSessionId = parseSessionIdValue(
          body.reuse_session_id,
          'reuse_session_id',
        );
        const session = await reuseGlobalWorkspaceSession(deps, {
          reuseSessionId,
          title: body.title,
          provider: body.provider,
          model: body.model ?? '',
          agent: body.agent ?? null,
          execution_mode_override: execution.executionMode,
          reasoning_effort_override: execution.reasoningEffort,
          max_turns: runLimits.maxTurns,
          max_auto_continues: runLimits.maxAutoContinues,
        });
        const responseSession =
          (await sessionStore.getSession(session.id)) ?? session;
        rememberSelectedModel(
          responseSession.provider,
          responseSession.model,
        );
        return c.json(responseSession, 201);
      } catch (e) {
        return c.json({ error: `could not reuse global session: ${e instanceof Error ? e.message : String(e)}` }, 400);
      }
    }
    const projectIds = Array.isArray(body.project_ids)
      ? Array.from(new Set(body.project_ids.filter((n) => Number.isFinite(n))))
      : [];
    if (projectIds.length === 0) {
      return c.json({ error: 'project_ids must contain at least one project' }, 400);
    }
    const primaryId = body.primary_project_id && projectIds.includes(body.primary_project_id)
      ? body.primary_project_id
      : projectIds[0];
    // Resolve + validate every linked project before creating anything.
    const projects: { id: number; name: string; root_path: string; isPrimary: boolean }[] = [];
    for (const pid of projectIds) {
      const p = deps.db.getProject(pid);
      if (!p) return c.json({ error: `project ${pid} not found` }, 400);
      if (p.is_synthetic) {
        return c.json({ error: `project ${pid} is a legacy virtual workspace and cannot be linked` }, 400);
      }
      projects.push({ id: p.id, name: p.name, root_path: p.root_path, isPrimary: pid === primaryId });
    }
    let session;
    try {
      session = await createGlobalWorkspaceSession(deps, {
        title: body.title,
        provider: body.provider,
        model: body.model ?? '',
        agent: body.agent ?? null,
        execution_mode_override: execution.executionMode,
        reasoning_effort_override: execution.reasoningEffort,
        max_turns: runLimits.maxTurns,
        max_auto_continues: runLimits.maxAutoContinues,
        projects,
      });
    } catch (e) {
      return c.json({ error: `could not create global workspace: ${e instanceof Error ? e.message : String(e)}` }, 500);
    }
    const responseSession =
      (await sessionStore.getSession(session.id)) ?? session;
    rememberSelectedModel(responseSession.provider, responseSession.model);
    return c.json(responseSession, 201);
  });

  /** Built-in presets plus enabled user-defined agents for the dashboard picker. */
  app.get('/api/coder/agents', (c) => {
    const custom = listCustomAgents(providerStore)
      .filter((agent) => agent.enabled)
      .map((agent) => {
        const base = AGENTS[agent.baseAgentId];
        return {
          ...base,
          id: agent.selectionId,
          label: agent.name,
          description: agent.description || base.description,
          custom: true,
          baseAgentId: agent.baseAgentId,
          skillCount: agent.skillIds.length,
          toolMode: agent.toolNames === null ? 'inherit' : 'allowlist',
          pinnedToolCount: agent.pinnedToolNames.length,
          requiredToolTiers: agent.requiredToolTiers,
          visibleToolCap: agent.visibleToolCap,
          managedBy: agent.managedBy,
          managedVersion: agent.managedVersion,
        };
      });
    return c.json({
      agents: [...Object.values(AGENTS), ...custom],
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
    const decision = decide(message);
    const agent = decision.recommendedAgent;
    const profile = AGENTS[agent].profile;
    return c.json({
      agent,
      profile,
      confidence: 'heuristic',
      confidence_score: decision.confidence,
      intent: decision.intent,
      requires_explicit_user_intent: decision.requiresExplicitUserIntent,
    });
  });

  app.get('/api/coder/sessions', async (c) => {
    const projectId = parseIntQuery(c, 'project_id', 0);
    if (!projectId) return c.json({ error: 'project_id required' }, 400);

    const archivedQ = c.req.query('archived');
    let archived: boolean | null = false;
    if (archivedQ === '1' || archivedQ === 'true') archived = true;
    else if (archivedQ === 'all') archived = null;

    const groupQ = c.req.query('group_id');
    let groupId: string | null | undefined;
    if (groupQ === 'null') groupId = null;
    else if (groupQ !== undefined && groupQ !== '') groupId = groupQ;

    return c.json(await sessionStore.listSessions(projectId, { archived, groupId }));
  });

  app.post('/api/coder/sessions/batch-delete', async (c) => {
    const body = await parseJsonBody<{ ids?: string[] }>(c);
    const ids = Array.isArray(body.ids)
      ? body.ids.map((id) => parseSessionIdValue(id, 'ids[]'))
      : [];
    if (ids.length === 0) return c.json({ error: 'ids required' }, 400);
    for (const id of ids) {
      const session = await sessionStore.getSession(id);
      if (session?.is_global) {
        await abortActiveRun(id);
      }
    }
    const trashed = await sessionStore.trashSessionsBatch(ids);
    return c.json({
      ok: true,
      deleted: trashed.length,
      items: trashed.map((entry) => ({
        session_id: entry.location.session_id,
        trash_name: entry.trash_name,
        trashed_at: entry.trashed_at,
        scope: entry.location.scope,
      })),
    });
  });

  app.patch('/api/coder/sessions/:id/archive', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await parseJsonBody<{ archived?: boolean }>(c);
    if (typeof body.archived !== 'boolean') {
      return c.json({ error: 'archived:boolean required' }, 400);
    }
    await sessionStore.setSessionArchived(id, body.archived);
    const session = await sessionStore.getSession(id);
    if (!session) return notFound(c);
    return c.json(session);
  });

  app.patch('/api/coder/sessions/:id/favorite', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await parseJsonBody<{ favorite?: boolean }>(c);
    if (typeof body.favorite !== 'boolean') {
      return c.json({ error: 'favorite:boolean required' }, 400);
    }
    await sessionStore.setSessionFavorite(id, body.favorite);
    const session = await sessionStore.getSession(id);
    if (!session) return notFound(c);
    return c.json(session);
  });

  app.post('/api/coder/sessions/:id/generate-title', async (c) => {
    const id = parseSessionIdParam(c);
    const src = await sessionStore.loadSessionWithMessages(id);
    if (!src) return notFound(c);

    // Preflight normally titles the session before the agent run starts. This
    // endpoint remains a retry/fallback, and must never overwrite a generated
    // title or a manual rename after the request began.
    if (!isAutomaticSessionTitle(src.session.title)) {
      return c.json({ title: src.session.title, generated: false });
    }

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

    const result = await deps.taskPreflight.generateSessionTitle({ userMessage: text });
    if (result.status === 'unconfigured') {
      return c.json({ error: 'Session-title pipeline is not configured', code: 'session_title_not_configured' }, 412);
    }
    if (result.status !== 'ok' || !result.title) {
      console.warn(`[generate-title] session=${id}: pipeline title failed:`, result.error ?? result.status);
      return c.json({ error: result.error ?? `title pipeline failed: ${result.status}` }, 500);
    }

    // Re-read after the model call: a concurrent manual rename always wins.
    const current = await sessionStore.getSession(id);
    if (!current) return notFound(c);
    if (!isAutomaticSessionTitle(current.title)) {
      return c.json({ title: current.title, generated: false });
    }
    await sessionStore.setSessionTitle(id, result.title);
    return c.json({ title: result.title, generated: true });
  });

  app.patch('/api/coder/sessions/:id/title', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await parseJsonBody<{ title?: string }>(c);
    const title = (body.title ?? '').trim();
    if (!title) return c.json({ error: 'title must be a non-empty string' }, 400);
    const session = await sessionStore.getSession(id);
    if (!session) return notFound(c);
    await sessionStore.setSessionTitle(id, title);
    return c.json(await sessionStore.getSession(id));
  });

  app.post('/api/coder/sessions/:id/duplicate', async (c) => {
    const id = parseSessionIdParam(c);
    try {
      const session = await sessionStore.duplicateSession(id);
      return c.json({ session }, 201);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 400);
    }
  });

  app.post('/api/coder/sessions/:id/fork', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await parseJsonBody<{ before_seq?: number }>(c);
    const beforeSeq = parseSeqValue(body.before_seq, 'before_seq');
    try {
      const result = await sessionStore.forkSessionBeforeSeq(id, beforeSeq);
      return c.json(result, 201);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 400);
    }
  });

  app.patch('/api/coder/sessions/:id/temperature', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await parseJsonBody<{ temperature?: number | null }>(c);
    const t = body.temperature;
    if (t !== null && (typeof t !== 'number' || !Number.isFinite(t))) {
      return c.json({ error: 'temperature:number|null required' }, 400);
    }
    await sessionStore.setSessionTemperature(id, t ?? null);
    const session = await sessionStore.getSession(id);
    if (!session) return notFound(c);
    return c.json(session);
  });

  /**
   * Per-session sticky reasoning-effort override (migration 150). Orthogonal to
   * the thinking toggle. `null` clears back to the provider default. A non-null
   * value is validated against the session model's persisted
   * `supported_reasoning_levels` (mirrors the admin model PATCH) so the column
   * never holds a level the model can't accept.
   */
  app.patch('/api/coder/sessions/:id/reasoning-effort', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await parseJsonBody<{ effort?: string | null }>(c);
    const rawEffort = body.effort ?? null;
    if (rawEffort !== null && typeof rawEffort !== 'string') {
      return c.json({ error: 'effort:string|null required' }, 400);
    }
    const effort = typeof rawEffort === 'string' ? rawEffort.trim() || null : null;
    const session = await sessionStore.getSession(id);
    if (!session) return notFound(c);
    // Backward compatibility for clients that exposed Ultra as a reasoning
    // option. Do not let the unsupported literal reach a provider request.
    if (effort?.toLowerCase() === 'ultra') {
      await sessionStore.setSessionExecutionMode(id, 'ultra');
      await sessionStore.setSessionReasoningEffort(id, null);
      const updated = await sessionStore.getSession(id);
      if (!updated) return notFound(c);
      return c.json(updated);
    }
    if (effort !== null) {
      // Validate against the model's persisted supported levels. When the row
      // says null we don't know what the model accepts, so we don't gate.
      const row = selectRuntimeModelMetadata(
        providerStore.listModels(session.provider),
        session.model,
      );
      const supported = row?.supported_reasoning_levels;
      if (supported && supported.length > 0 && !supported.includes(effort)) {
        return c.json(
          {
            error: `reasoning effort '${effort}' not supported for ${session.model}; supported: ${supported.join(',')}`,
          },
          400,
        );
      }
    }
    // This endpoint is also the complete control surface for pre-241 clients:
    // after selecting the legacy Ultra pseudo-effort, choosing any native
    // effort (or model default via null) must let them leave Ultra again. New
    // clients use the dedicated execution-mode endpoint for the orthogonal axis.
    if (session.execution_mode_override === 'ultra') {
      await sessionStore.setSessionExecutionMode(id, 'standard');
    }
    await sessionStore.setSessionReasoningEffort(id, effort);
    const updated = await sessionStore.getSession(id);
    if (!updated) return notFound(c);
    return c.json(updated);
  });

  /** Persist the provider-independent execution mode for this conversation. */
  app.patch('/api/coder/sessions/:id/execution-mode', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await parseJsonBody<{ mode?: unknown }>(c);
    if (!isExecutionMode(body.mode)) {
      return c.json({ error: `mode: one of ${EXECUTION_MODES.join('|')} required` }, 400);
    }
    const session = await sessionStore.getSession(id);
    if (!session) return notFound(c);
    await sessionStore.setSessionExecutionMode(id, body.mode);
    const updated = await sessionStore.getSession(id);
    if (!updated) return notFound(c);
    return c.json(updated);
  });

  /** Persist the extended-thinking icon state for this conversation. */
  app.patch('/api/coder/sessions/:id/thinking', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await parseJsonBody<{ thinking?: unknown }>(c);
    if (typeof body.thinking !== 'boolean') {
      return c.json({ error: 'thinking:boolean required' }, 400);
    }
    const session = await sessionStore.getSession(id);
    if (!session) return notFound(c);
    await sessionStore.setSessionThinkingEnabled(id, body.thinking);
    const updated = await sessionStore.getSession(id);
    if (!updated) return notFound(c);
    return c.json(updated);
  });

  /**
   * Per-session sticky plan-depth override (migration 151) for the `plan`
   * agent: `simple` | `normal` | `complex`. `null` clears back to the runtime
   * default (`normal`). Validated against the fixed set; unlike reasoning-effort
   * there is no model-capability gate. No live-runner push — the depth is baked
   * into the system prompt at the next runner construction (like `/agent`).
   */
  app.patch('/api/coder/sessions/:id/plan-depth', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await parseJsonBody<{ depth?: string | null }>(c);
    const depth = body.depth ?? null;
    if (depth !== null && !PLAN_DEPTHS.includes(depth as PlanDepth)) {
      return c.json({ error: `depth: one of ${PLAN_DEPTHS.join('|')}|null required` }, 400);
    }
    const session = await sessionStore.getSession(id);
    if (!session) return notFound(c);
    await sessionStore.setSessionPlanDepth(id, depth);
    const updated = await sessionStore.getSession(id);
    if (!updated) return notFound(c);
    return c.json(updated);
  });

  /**
   * Per-session sticky response-language override (migration 177). A concrete
   * language name (e.g. "Português (Brasil)", "English") feeds the `# Language`
   * system-prompt block. `null` or empty clears back to the project default and
   * then the neutral "respond in the user's language" form. No live-runner push
   * — the language is baked into the system prompt at the next runner construction.
   */
  app.patch('/api/coder/sessions/:id/response-language', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await parseJsonBody<{ language?: string | null }>(c);
    const raw = typeof body.language === 'string' ? body.language.trim() : null;
    if (raw !== null && raw.length > MAX_RESPONSE_LANGUAGE_LEN) {
      return c.json({ error: `language: at most ${MAX_RESPONSE_LANGUAGE_LEN} chars` }, 400);
    }
    // Store NULL for empty/"auto" so the resolution chain (project default →
    // neutral form) kicks in rather than an empty override short-circuiting it.
    const language = raw && raw.toLowerCase() !== 'auto' ? raw : null;
    const session = await sessionStore.getSession(id);
    if (!session) return notFound(c);
    await sessionStore.setSessionResponseLanguage(id, language);
    const updated = await sessionStore.getSession(id);
    if (!updated) return notFound(c);
    return c.json(updated);
  });

  /**
   * Per-session sticky output style (migration 178): proactive | explanatory |
   * learning. `null` or `proactive` clears back to the default (no extra prompt
   * block). Validated against the fixed set; no model gate. No live-runner push
   * — baked into the system prompt at the next runner construction.
   */
  app.patch('/api/coder/sessions/:id/output-style', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await parseJsonBody<{ style?: string | null }>(c);
    // Treat empty/whitespace as a clear-to-NULL (parity with /response-language)
    // so a client resetting via `style:''` doesn't get a 400.
    const trimmed = typeof body.style === 'string' ? body.style.trim() : body.style;
    const style = trimmed ? trimmed : null;
    if (style !== null && !OUTPUT_STYLES.includes(style as OutputStyle)) {
      return c.json({ error: `style: one of ${OUTPUT_STYLES.join('|')}|null required` }, 400);
    }
    const session = await sessionStore.getSession(id);
    if (!session) return notFound(c);
    // Persist NULL for the default so the column stays clean (proactive = no block).
    await sessionStore.setSessionOutputStyle(id, style === 'proactive' ? null : style);
    const updated = await sessionStore.getSession(id);
    if (!updated) return notFound(c);
    return c.json(updated);
  });

  app.patch('/api/coder/sessions/:id/unrestricted-output', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await parseJsonBody<{ enabled?: boolean | null }>(c);
    const v = body.enabled;
    if (v !== null && v !== undefined && typeof v !== 'boolean') {
      return c.json({ error: 'enabled:boolean|null required' }, 400);
    }
    await sessionStore.setSessionUnrestrictedToolOutput(id, v ?? null);
    const session = await sessionStore.getSession(id);
    if (!session) return notFound(c);
    return c.json(session);
  });

  /**
   * Per-session sticky tool-output cap LEVEL (migration 153): economic | medium
   * | high | extra | max | ultra. Supersedes the binary `/unrestricted-output`
   * toggle. `null` clears back to the runtime default (derived from the legacy
   * boolean, else 'economic'). Validated against the fixed set; no model gate.
   * An active worker persists the value and updates its warm runner so the
   * next tool call observes the new cap without reconstructing the session.
   */
  app.patch('/api/coder/sessions/:id/tool-output-cap-level', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await parseJsonBody<{ level?: string | null }>(c);
    const level = body.level ?? null;
    const parsedLevel = parseToolOutputCapLevel(level);
    if (level !== null && parsedLevel === null) {
      return c.json({ error: `level: one of ${TOOL_OUTPUT_CAP_LEVELS.join('|')}|null required` }, 400);
    }
    const updated = await withSessionLock(id, async () => {
      const session = await sessionStore.getSession(id);
      if (!session) return null;
      const persistedByWorker = await workerPool.setToolOutputCapLevel(
        id,
        parsedLevel,
      );
      if (persistedByWorker) return sessionStore.refreshSession(id);
      await sessionStore.setSessionToolOutputCapLevel(id, parsedLevel);
      return sessionStore.getSession(id);
    });
    if (!updated) return notFound(c);
    return c.json(updated);
  });

  app.patch('/api/coder/sessions/:id/block-code-comments', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await parseJsonBody<{ enabled?: unknown }>(c);
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled:boolean required' }, 400);
    }
    const enabled = body.enabled;
    const updated = await withSessionLock(id, async () => {
      const session = await sessionStore.getSession(id);
      if (!session) return null;
      const persistedByWorker = await workerPool.setBlockCodeComments(id, enabled);
      if (persistedByWorker) return sessionStore.refreshSession(id);
      await sessionStore.setSessionBlockCodeComments(id, enabled);
      return sessionStore.getSession(id);
    });
    if (!updated) return notFound(c);
    return c.json(updated);
  });

  /**
   * Persist this conversation's execution budget. Null max_turns is the
   * default and means "run until natural completion". Auto-continues are
   * additional batches available only when a positive max_turns is enabled.
   */
  app.patch('/api/coder/sessions/:id/run-limits', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await parseJsonBody<{
      max_turns?: number | null;
      max_auto_continues?: number;
    }>(c);
    const limits = validateRunLimits(
      body.max_turns,
      body.max_auto_continues,
    );
    if (!limits.ok) return c.json({ error: limits.error }, 400);
    const updated = await withSessionLock(id, async () => {
      const session = await sessionStore.getSession(id);
      if (!session) return null;
      const persistedByWorker = await workerPool.setRunLimits(
        id,
        limits.maxTurns,
        limits.maxAutoContinues,
      );
      if (persistedByWorker) return sessionStore.refreshSession(id);
      await sessionStore.setSessionRunLimits(
        id,
        limits.maxTurns,
        limits.maxAutoContinues,
      );
      return sessionStore.getSession(id);
    });
    if (!updated) return notFound(c);
    return c.json(updated);
  });

  /**
   * Per-session tool permission mode (PermissionGate). Persists the column
   * AND pushes the change into the live worker runner,
   * so a mid-run switch applies to the next gated tool call. `null` clears
   * back to the default ('auto').
   */
  app.patch('/api/coder/sessions/:id/tool-permission-mode', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await parseJsonBody<{ mode?: 'ask' | 'auto' | 'unrestricted' | null }>(c);
    const mode = body.mode ?? null;
    if (mode !== null && !TOOL_PERMISSION_MODES.includes(mode)) {
      return c.json({ error: "mode:'ask'|'auto'|'unrestricted'|null required" }, 400);
    }
    const updated = await withSessionLock(id, async () => {
      const session = await sessionStore.getSession(id);
      if (!session) return null;
      const persistedByWorker = await workerPool.setToolPermissionMode(
        id,
        mode,
      );
      if (persistedByWorker) return sessionStore.refreshSession(id);
      await sessionStore.setSessionToolPermissionMode(id, mode);
      return sessionStore.getSession(id);
    });
    if (!updated) return notFound(c);
    return c.json(updated);
  });

  /**
   * Per-session agent/mode (built-in preset or `custom:<stable-id>`).
   * Persists the column so a manual dropdown pick is remembered even when
   * the user leaves without sending. Unlike tool-permission-mode there is NO
   * live-runner push: the agent identity (system prompt, tier seed, gates) is
   * baked into the runner at construction, so a switch applies to the NEXT
   * run — mid-run transitions (plan→build) are driven by the runner itself.
   * Real manual transitions are staged and coalesced until the next runner
   * starts. The final transition is then appended as one hidden system
   * reminder, giving that runner a fresh near-tail authority marker without
   * selector churn bloating the model context.
   * `null` clears the column.
   */
  app.patch('/api/coder/sessions/:id/agent', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await parseJsonBody<{ agent?: string | null }>(c);
    const agent = body.agent ?? null;
    if (agent !== null && !validateAgentSelection(agent)) {
      return c.json({ error: 'agent must reference an enabled built-in or custom agent, or null' }, 400);
    }
    const updated = await withSessionLock(id, async () => {
      const previous = await sessionStore.getSession(id);
      if (!previous) return null;

      // A warm/running worker owns the filesystem writer lease. Persisting
      // from the HTTP process in that state fails and makes the optimistic
      // selector snap back. Route the staged NEXT-run transition through the
      // owner; unlike a runner-driven plan→build transition, this must not
      // mutate the active runner.
      const persistedByWorker =
        await workerPool.stageManualAgentTransition(id, agent);
      if (persistedByWorker) return sessionStore.refreshSession(id);

      if (previous.agent === agent) return previous;
      await sessionStore.stageManualAgentTransition(id, agent);
      return sessionStore.getSession(id);
    });
    if (!updated) return notFound(c);
    return c.json(updated);
  });

  app.patch('/api/coder/sessions/:id/group', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await parseJsonBody<{ group_id?: string | null }>(c);
    if (body.group_id !== null && body.group_id !== undefined && typeof body.group_id !== 'string') {
      return c.json({ error: 'group_id:string|null required' }, 400);
    }
    await sessionStore.setSessionGroup(id, body.group_id ?? null);
    const session = await sessionStore.getSession(id);
    if (!session) return notFound(c);
    return c.json(session);
  });

  app.post('/api/coder/sessions', async (c) => {
    const body = await c.req.json<CreateSessionBody>();
    const lastUsed = body.use_last_model === true
      ? await resolveLastSelectedModel()
      : null;
    const provider = (lastUsed?.provider ?? body.provider) as CoderProviderName | undefined;
    const model = lastUsed?.model ?? (body.model ?? '');
    if (!body.project_id || !body.title || !provider) {
      return c.json({ error: 'project_id, title, provider required' }, 400);
    }
    if (body.agent !== undefined && !validateAgentSelection(body.agent)) {
      return c.json({ error: 'unknown or disabled agent' }, 400);
    }
    const execution = resolveCreationExecutionSettings(body.execution_mode, body.reasoning_effort);
    if (!execution.ok) return c.json({ error: execution.error }, 400);
    const runLimits = validateRunLimits(
      body.max_turns,
      body.max_auto_continues,
    );
    if (!runLimits.ok) return c.json({ error: runLimits.error }, 400);
    if (body.thinking_enabled !== undefined && typeof body.thinking_enabled !== 'boolean') {
      return c.json({ error: 'thinking_enabled:boolean required' }, 400);
    }
    const effortError = validateReasoningEffort(provider, model, execution.reasoningEffort);
    if (effortError) return c.json({ error: effortError }, 400);
    // Builder projects (projects.builder_json set) default the chat agent to
    // `builder` (persona + scope) unless the caller passed an explicit agent.
    const isBuilderProject = !!deps.db.getProject(body.project_id)?.builder_json;
    const session = await sessionStore.createSession({
      project_id: body.project_id,
      title: body.title,
      provider,
      model,
      agent: body.agent ?? (isBuilderProject ? 'builder' : null),
      execution_mode_override: execution.executionMode,
      reasoning_effort_override: execution.reasoningEffort,
      thinking_enabled: body.thinking_enabled === true,
      max_turns: runLimits.maxTurns,
      max_auto_continues: runLimits.maxAutoContinues,
      metadata: body.metadata,
    });
    // Best-effort base_commit_sha capture for Camada 4's reviewer subagent.
    // We need the project workdir to run `git rev-parse HEAD`. If the project
    // isn't a git repo, or the workdir lookup fails, leave it null and the
    // reviewer will fall back to running `git_diff` itself (or report no diff).
    const responseSession = (await sessionStore.getSession(session.id)) ?? session;
    rememberSelectedModel(responseSession.provider, responseSession.model);
    setImmediate(() => {
      void (async () => {
        try {
          const project = (deps as { projectStore?: { getProject?: (id: number) => { workdir?: string | null } | null } }).projectStore?.getProject?.(body.project_id);
          const workdir = project?.workdir;
          if (workdir) {
            // Base-commit discovery is useful for later review, but it is not
            // part of publishing a new session. Keep process startup and Git's
            // timeout entirely outside the latency observed by the + button.
            const { execFile } = await import('node:child_process');
            const { promisify } = await import('node:util');
            const { stdout } = await promisify(execFile)('git', ['rev-parse', 'HEAD'], {
              cwd: workdir,
              encoding: 'utf8',
              timeout: 2000,
            });
            const sha = stdout.trim();
            if (sha && /^[0-9a-f]{40}$/i.test(sha)) {
              await sessionStore.setSessionBaseCommit(session.id, sha);
            }
          }
        } catch {
          /* not a git repo or no workdir — fine, reviewer handles this */
        }
      })();
    });
    return c.json(responseSession, 201);
  });

  /**
   * Linked projects of a (global) session — for the "linked projects" chip and
   * the active-root switcher. Returns [] for a normal session (no junction rows).
   */
  app.get('/api/coder/sessions/:id/projects', async (c) => {
    const id = parseSessionIdParam(c);
    const session = await sessionStore.getSession(id);
    if (!session) return notFound(c);
    return c.json(await sessionStore.getSessionProjects(id));
  });

  /**
   * Attach a real project to an existing global session's virtual workspace,
   * after creation ("anexar projeto"). Rebuilds the junctions + warms the union
   * index so the file tree/search pick it up now; the agent spans the new root
   * on its NEXT run. Rejected (409) while a run is in flight. Returns the updated
   * link set. MUST stay before the `/:id` catch-all (Hono route ordering).
   */
  app.post('/api/coder/sessions/:id/projects', async (c) => {
    const id = parseSessionIdParam(c);
    if (isRunActive(id)) return c.json({ error: 'session is running' }, 409);
    const body = await parseJsonBody<{ project_id?: number }>(c);
    const projectId = Number(body.project_id);
    if (!Number.isFinite(projectId)) return c.json({ error: 'project_id required' }, 400);
    try {
      return c.json(await attachProjectToGlobalSession(deps, id, projectId));
    } catch (e) {
      if (e instanceof GlobalWorkspaceError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });

  /** Detach a real project from a global session's virtual workspace. Refuses the
   *  primary / last project. Rejected (409) while a run is in flight. */
  app.delete('/api/coder/sessions/:id/projects/:projectId', async (c) => {
    const id = parseSessionIdParam(c);
    if (isRunActive(id)) return c.json({ error: 'session is running' }, 409);
    const projectId = parseInt(c.req.param('projectId') ?? '', 10);
    if (!Number.isFinite(projectId)) return c.json({ error: 'invalid project id' }, 400);
    try {
      return c.json(await detachProjectFromGlobalSession(deps, id, projectId));
    } catch (e) {
      if (e instanceof GlobalWorkspaceError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });

  app.get('/api/coder/sessions/:id', async (c) => {
    const id = parseSessionIdParam(c);
    const full = c.req.query('full') === '1';
    const preview = c.req.query('detail') === 'preview';
    const tailQ = c.req.query('tail');
    const tail = tailQ ? Math.max(1, parseInt(tailQ, 10) || 60) : 0;

    // When ?tail=N, only parse the last N messages (avoids heap pressure on
    // large sessions). Without ?tail, load everything for backward compat.
    const data = await (tail
      ? sessionStore.loadSessionMessagesTail(id, tail)
      : sessionStore.loadSessionWithMessages(id));
    if (!data) return notFound(c);

    const total_messages = await sessionStore.getMessageCount(id);
    // Count of pre-boundary rows hidden by a manual "summarize & clear" — the
    // dashboard shows a "view earlier history" affordance when this is > 0.
    const archived_count = await sessionStore.getArchivedMessageCount(id);
    const preceding_user_seq = data.message_rows[0]
      ? await sessionStore.previousUserMessageSeq(id, data.message_rows[0].seq)
      : null;
    // Status fallback for tool calls whose tool_result block was lost (pre-fix
    // sessions). Empty for healthy sessions — costs nothing in the common case.
    const tool_results = await reconstructMissingToolResults(sessionStore, id, data.messages);

    // For a global session, surface the linked projects so the chat can render
    // the "linked projects" chip + default the file-tree root to the primary
    // (`session.project_id`). Empty for normal sessions — no extra query cost.
    const linked_projects = data.session.is_global
      ? await sessionStore.getSessionProjects(id)
      : [];

    if (full || !preview) {
      return c.json({ ...data, total_messages, archived_count, preceding_user_seq, tool_results, linked_projects });
    }

    return c.json({ ...data, messages: trimMessageBlocks(data.messages), total_messages, archived_count, preceding_user_seq, tool_results, linked_projects });
  });

  /**
   * Paginated message loading: fetch N messages before a conversation seq.
   * Used by the dashboard "Load earlier" button.
   */
  app.get('/api/coder/sessions/:id/messages', async (c) => {
    const sessionId = parseSessionIdParam(c);
    const session = await sessionStore.getSession(sessionId);
    if (!session) return notFound(c);

    let beforeSeq = parseSeqQuery(c, 'before_seq', 0);
    const limit = Math.max(1, Math.min(100, parseIntQuery(c, 'limit', 40)));
    // Cross a manual "summarize & clear" boundary to reveal the archived
    // (pre-summary) transcript — driven by the dashboard's "view earlier
    // history" button.
    const includeArchived = c.req.query('include_archived') === '1';
    const preview = c.req.query('detail') === 'preview';

    // A compacted session may have zero visible rows, so the dashboard has no
    // earliest seq to send when the user reveals the archived transcript. Use a
    // stable exclusive upper bound in that case; ordinary callers can keep
    // passing `before_seq` unchanged.
    if (!beforeSeq) beforeSeq = (await sessionStore.maxMessageSeq(sessionId)) + 1;

    const data = await sessionStore.loadMessagesBefore(
      sessionId,
      beforeSeq,
      limit,
      includeArchived,
    );
    const preceding_user_seq = data.message_rows[0]
      ? await sessionStore.previousUserMessageSeq(sessionId, data.message_rows[0].seq)
      : null;
    const tool_results = await reconstructMissingToolResults(sessionStore, sessionId, data.messages);
    return c.json({
      messages: preview ? trimMessageBlocks(data.messages) : data.messages,
      message_rows: data.message_rows,
      next_before_seq: data.next_cursor,
      has_more: data.next_cursor != null,
      preceding_user_seq,
      tool_results,
    });
  });

  app.get('/api/coder/sessions/:id/tool-results/:toolUseId/full', async (c) => {
    const sessionId = parseSessionIdParam(c);
    const session = await sessionStore.getSession(sessionId);
    if (!session) return notFound(c);
    const toolUseId = c.req.param('toolUseId');
    if (!toolUseId) return c.json({ error: 'toolUseId required' }, 400);
    const row = (await sessionStore.getToolResultsByToolUseIds(sessionId, [toolUseId]))[0];
    if (!row) return notFound(c, 'tool result not found');
    return c.json({
      tool_use_id: row.tool_use_id,
      content: row.result_text,
      is_error: row.is_error,
      duration_ms: row.duration_ms,
    });
  });

  app.get('/api/coder/sessions/:id/stats', async (c) => {
    const id = parseSessionIdParam(c);
    const stats = await sessionStore.getSessionStats(id);
    if (!stats) return notFound(c);
    // Resolve context window DB-first, then fall back to static registry.
    const session = await sessionStore.getSession(id);
    let context_window: number | null = null;
    if (session) {
      const dbModel = deps.providerStore.listModels(session.provider).find((m) => m.model_id === session.model);
      context_window = dbModel?.context_window ?? getModelContextWindow(session.model);
    }
    return c.json({ ...stats, context_window });
  });

  app.get('/api/coder/sessions/:id/messages/:seq/full', async (c) => {
    const id = parseSessionIdParam(c);
    const seq = parseSeqParam(c);
    const msg = await sessionStore.getMessageBySeq(id, seq);
    if (!msg) return notFound(c, 'message not found');
    return c.json({ seq: msg.row.seq, role: msg.role, content: msg.content });
  });

  app.delete('/api/coder/sessions/:id', async (c) => {
    const id = parseSessionIdParam(c);
    const session = await sessionStore.getSession(id);
    if (session?.is_global) await abortActiveRun(id);
    const trashed = await sessionStore.deleteSession(id);
    return c.json({
      ok: true,
      session_id: id,
      trash_name: trashed.trash_name,
      trashed_at: trashed.trashed_at,
      scope: trashed.location.scope,
    });
  });

  /**
   * Goal + active tasks summary. Single endpoint so the dashboard can pin
   * a "session header" widget without juggling two requests. Both fields
   * are nullable — a session with no goal AND no tasks returns nulls.
   */
  app.get('/api/coder/sessions/:id/state-summary', async (c) => {
    const id = parseSessionIdParam(c);
    const session = await sessionStore.getSession(id);
    if (!session) return notFound(c, 'session not found');
    const goal = await sessionStore.getSessionGoal(id);
    // Post-merge: todos + tasks share one gate-typed session file.
    // A track-gate list IS the lightweight checklist → surface it as `todos`,
    // not `tasks`. An approve-gate list → `tasks`. This makes the sidebar render
    // exactly ONE section instead of stacking a duplicate of the same items.
    const tasksState = await sessionStore.getTasksState(id);
    const gate = effectiveGate(tasksState);
    const isTrack = !!tasksState && tasksState.tasks.length > 0 && gate === 'track';

    let todos: Array<{ id?: string; content: string; activeForm: string; status: string }>;
    if (tasksState) {
      // Single source of truth: derive the checklist from the unified state
      // (empty unless it is a track list).
      todos = deriveTodosFromState(tasksState).map((td) => ({
        id: td.id,
        content: td.content,
        activeForm: td.activeForm,
        status: td.status,
      }));
    } else {
      // Pre-migration / runner-not-yet-constructed fallback: legacy todos_json.
      todos = [];
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
    }
    return c.json({
      goal: goal
        ? {
            text: goal.text,
            status: goal.status,
            budget_tokens: goal.budget_tokens,
            completion_note: goal.completion_note,
            created_at: goal.created_at,
            updated_at: goal.updated_at,
          }
        : null,
      // Only an APPROVE list renders as "Tasks". A track checklist is returned
      // via `todos` above, so `tasks` is null for it (no duplicate panel).
      tasks: tasksState && !isTrack && tasksState.tasks.length > 0
        ? {
            gate,
            summary: tasksState.summary,
            approved: tasksState.approved,
            execution_mode: tasksState.execution_mode,
            current_task_id: tasksState.current_task_id,
            tasks: tasksState.tasks.map((t) => ({
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
    const id = parseSessionIdParam(c);
    const bus = workerPool.getBus(id);
    return c.json({
      active: !!bus && !bus.ended,
      last_seq: bus ? bus.nextSeq - 1 : -1,
    });
  });

  // ─── Session Tool Config ──────────────────────────────────────

  /** List all tools (built-in + external MCP) with global + session disabled state. */
  app.get('/api/coder/sessions/:id/tools', async (c) => {
    const id = parseSessionIdParam(c);
    const session = await sessionStore.getSession(id);
    if (!session) return notFound(c, 'session not found');

    const allTools = getAllKnownToolsMeta();
    const globalDisabled = new Set(deps.providerStore.listGlobalDisabledTools());
    const sessionDisabled = await sessionStore.getSessionDisabledTools(id);

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
    const id = parseSessionIdParam(c);
    const toolName = c.req.param('name');
    const body = await c.req.json<{ disabled: boolean }>();
    if (typeof body.disabled !== 'boolean') {
      return c.json({ error: 'disabled (boolean) required' }, 400);
    }
    await sessionStore.setSessionToolDisabled(id, toolName, body.disabled);
    return c.json({ ok: true });
  });

  /** Batch toggle tools for a session. */
  app.put('/api/coder/sessions/:id/tools/bulk-disabled', async (c) => {
    const id = parseSessionIdParam(c);
    const body = await c.req.json<{
      tools: Array<{ name: string; disabled: boolean }>;
    }>();
    if (!Array.isArray(body.tools)) {
      return c.json({ error: 'tools array required' }, 400);
    }
    await Promise.all(
      body.tools.map((tool) =>
        sessionStore.setSessionToolDisabled(id, tool.name, tool.disabled),
      ),
    );
    return c.json({ ok: true });
  });

  /** Copy tool config from another session. */
  app.post('/api/coder/sessions/:id/tools/copy-from/:sourceId', async (c) => {
    const id = parseSessionIdParam(c);
    const sourceId = parseSessionIdParam(c, 'sourceId');
    const copiedCount = await sessionStore.copyToolConfig(sourceId, id);
    return c.json({ ok: true, copiedCount });
  });
}
