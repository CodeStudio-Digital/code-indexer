import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { runCoder } from '@mcp/code-agent/index.js';
import { resolveAgentRuntimeEnv } from '@mcp/api-handlers/runtime/runtime-resolve.js';
import { ensureGlobalWorkspaceLinks } from './global-workspace.js';
import { assignWorkspaceSlugs, workspaceSlug } from '@mcp/shared/utils/workspace-slug.js';
import type { CoderAttachment, PreflightSeed } from '@mcp/code-agent/index.js';
import type { IdeContext } from '@mcp/code-agent/core/ide-context.js';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import { isAgentId, type AgentId } from '@mcp/code-agent/agents/index.js';
import { modelSupportsVision } from '@mcp/code-agent/providers/capabilities.js';
import { DEFAULT_ATTACHMENT_PROMPT, MAX_ATTACHMENT_REQUEST_BYTES } from '@mcp/shared';
import { renderPreflightHint } from '@mcp/code-agent/core/runner/assembly/preflight-hint.js';
import {
  createBus,
  publish,
  markEnded,
  setBusRunner,
  emitWorkerLog,
} from '../../../coder-bus.js';
import type { ServerDeps } from '../../deps.js';
import type { CoderRuntime } from './state.js';
import { pumpBusToSSE, parseLastEventId } from '../../../sse/pumpBusToSSE.js';
import { closePreviewWindow, closePreviewSession } from '../../../sse/closeCoderPreview.js';
import { notifyBuilderRunEnded } from '../../../sse/builder-checkpoint.js';
import {
  coderWorkerEnabled,
  getCoderWorkerPool,
} from '../../../sse/coderWorkerPoolSingleton.js';
import { parseIdParam, notFound } from '../_helpers.js';
import { normalizeDedupeKey, syntheticDoneSSE } from '../recent-message-keys.js';
import { withSessionLock } from './sessionLock.js';
import {
  binaryDocumentsHandledNatively,
  normalizeAttachmentsForModel,
  pdfHandledNatively,
} from '@mcp/services/services/docs/attachment-extract.js';
import { validateAttachments } from '@mcp/services/services/docs/attachment-validation.js';
import { getDefinition } from '@mcp/services/providers/registry.js';
import {
  cleanSessionTitleSeed,
  isAutomaticSessionTitle,
} from '@mcp/services/services/task-preflight/index.js';
import { installDocsDeepResearch } from '@mcp/docs-agent/bridges/docs-bridge.js';
import { getGlobalMcpExternalPool } from '../../../sse/McpExternalPool.js';
import { listEnabledPluginRuntime, buildPluginTools } from '@mcp/plugin-host';
import { PluginWorkerHost } from '../../../sse/PluginWorkerHost.js';
import { getPluginHostInvoke } from '../../../sse/pluginHostInvoke.js';
import {
  getRuntimeEventLog,
  installRuntimeEventLog,
  runtimeEventsToJsonl,
  summarizeRuntimeEvents,
} from '../../../sse/runtime-event-log.js';

/**
 * Cheap, stable content fingerprint for the preflight-seed cache (mig 180). A
 * collision only means a slightly-off seed is reused — same blast radius as the
 * best-effort cache itself — so a fast non-crypto hash is fine.
 */
function hashPreflightContent(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

interface SendMessageBody {
  content: string;
  max_turns?: number;
  plan_mode?: boolean;
  attachments?: CoderAttachment[];
  /** Agent preset. Takes precedence over profile/plan_mode when unset. */
  agent?: AgentId;
  /** Tool tier profile: bootstrap | navigate | full | auto. */
  profile?: 'bootstrap' | 'navigate' | 'full' | 'auto';
  /**
   * When set on the FIRST message of a fresh session, creates an isolated
   * git worktree and scopes the session into it. Ignored on resume runs.
   */
  worktree?: { name?: string; branch?: string };
  /** Enable thinking/reasoning mode for providers that support it. */
  thinking?: boolean;
  /**
   * Composer "Describe images" flag — FORCE the vision-fallback (image → text
   * description) even when the active model can see images. Auto-fallback (when
   * the model lacks the 'image' input modality) happens regardless of this.
   */
  describe_images?: boolean;
  /**
   * Opt-in: when there is already a live run for this session AND it is
   * blocked inside an interactive tool (ask_user / submit_plan / submit_tasks),
   * interrupt that wait and inject this message instead of returning 409.
   * Default false — the canonical answer path is /answer or /plan-response.
   */
  interject?: boolean;
  /**
   * Skill IDs the user manually pre-selected in the sidebar's SkillsSection.
   * Each id is expanded into an `<active_skills>` block prepended to
   * `content` so the model gets the skill body inline without needing to
   * call `get_skill_content` first.
   */
  selected_skill_ids?: string[];
  /** Structured IDE context (active file / selections / open tabs) for this send. */
  ide_context?: IdeContext;
  /**
   * Apêndice 4 Fase 2 — when true, the runner resumes from history
   * instead of pushing a new user turn. Used by the dashboard after an
   * `/answer` / `/plan-response` / `/tasks-response` returned
   * `{resumed_via_worker: true}` (the answer was appended to the DB but
   * the previous worker is gone). `content` may be empty in this mode.
   */
  resume?: boolean;
  /**
   * Client-generated idempotency key (UUID). Stable across the
   * `ReconnectingSSEClient` retries of a single send, so a retry that
   * re-POSTs the body is deduped into a bus replay instead of re-running
   * the append/push/spawn side effects. Absent → current behaviour.
   */
  client_msg_id?: string;
}

/**
 * Window during which we'll wait for `bus.runner` to become available when
 * a second POST /messages arrives during a fresh run's setup phase. Five
 * seconds is comfortably more than `runCoder` ever takes locally; if it
 * exceeds this we'd rather fail fast than block the request handler.
 */
const RUNNER_READY_TIMEOUT_MS = 5_000;
const DEFAULT_INDEX_GATE_TIMEOUT_MS = 180_000;

function structuralIndexGateTimeoutMs(): number {
  const parsed = Number.parseInt(
    process.env.CODER_INDEX_GATE_TIMEOUT_MS
      ?? process.env.CODER_GLOBAL_INDEX_GATE_TIMEOUT_MS
      ?? '',
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INDEX_GATE_TIMEOUT_MS;
}

function projectRootForSession(deps: ServerDeps, sessionId: number): string | null {
  const session = deps.sessionStore.getSession(sessionId);
  if (session?.project_id == null) return null;
  return deps.db.getProject(session.project_id)?.root_path ?? null;
}

interface ContinueBody {
  plan_mode?: boolean;
  max_turns?: number;
  agent?: AgentId;
  profile?: 'bootstrap' | 'navigate' | 'full' | 'auto';
  /** Force the vision fallback (image → text) on a resumed run. */
  describe_images?: boolean;
  /** Idempotency key — see `SendMessageBody.client_msg_id`. */
  client_msg_id?: string;
}

const attachmentBodyLimit = bodyLimit({
  maxSize: MAX_ATTACHMENT_REQUEST_BYTES,
  onError: (c) => c.json(
    { error: 'request body is too large', code: 'ATTACHMENT_REQUEST_TOO_LARGE' },
    413,
  ),
});

export function mountCoderStreamRoutes(
  app: Hono,
  deps: ServerDeps,
  runtime: CoderRuntime,
): void {
  const { sessionStore, providerStore } = deps;
  const { activeRuns, BUS_LINGER_MS, wireRunnerToBus, recentMessageKeys } = runtime;
  const semanticBusLeases = new WeakMap<ReturnType<typeof createBus>, () => void>();

  function keepSemanticProjectAlive(sessionId: number, bus: ReturnType<typeof createBus>): void {
    if (bus.ended || semanticBusLeases.has(bus)) return;
    const projectId = sessionStore.getSession(sessionId)?.project_id;
    if (projectId == null) return;
    const release = deps.semanticCoordinator.acquireCodeProjectLease(
      projectId,
      `coder:${sessionId}:${bus.busId}`,
    );
    semanticBusLeases.set(bus, release);
    bus.endListeners.add(() => {
      semanticBusLeases.delete(bus);
      release();
    });
  }

  /**
   * Whether the session's active model can consume images. Uses the provider's
   * `input_modalities` when present, else model-family heuristics
   * (`modelSupportsVision`). Deliberately does NOT use `supports_attachments`
   * (a document/PDF flag that is `true` for text-only models like GLM, which
   * silently disabled the vision fallback → blind-model hallucination). Drives
   * the vision-fallback auto path in runCoder.
   */
  function resolveModelSupportsVision(id: number): boolean | undefined {
    const session = sessionStore.getSession(id);
    if (!session?.provider || !session?.model) return undefined;
    const providerKind = providerStore.getProvider(session.provider)?.kind;
    const row = providerStore
      .listModels(session.provider)
      .find((m) => m.model_id === session.model);
    return modelSupportsVision({
      providerKind,
      modelId: session.model,
      inputModalities: row?.input_modalities,
    });
  }

  function resolveRunAgent(id: number, requested: unknown): AgentId | undefined {
    const session = sessionStore.getSession(id);
    const persisted = typeof session?.agent === 'string' && isAgentId(session.agent) ? session.agent : undefined;
    if (persisted === 'app_orchestrator') {
      return persisted;
    }
    return typeof requested === 'string' && isAgentId(requested) ? requested : undefined;
  }

  /** Resolved provider `kind` for the session (drives PDF-native gating). */
  function resolveProviderKind(id: number): string | undefined {
    const session = sessionStore.getSession(id);
    if (!session?.provider) return undefined;
    return providerStore.getProvider(session.provider)?.kind;
  }

  function resolveFileHandling(id: number) {
    const session = sessionStore.getSession(id);
    const providerKind = resolveProviderKind(id);
    const row = session?.provider && session.model
      ? providerStore.listModels(session.provider).find((m) => m.model_id === session.model)
      : undefined;
    return {
      mode: providerKind ? getDefinition(providerKind)?.capabilities?.fileInput : undefined,
      modelId: session?.model,
      supportsAttachments: row?.supports_attachments,
    };
  }

  /**
   * Whether the `preview` DevTools tier should auto-activate for this session.
   * True for any PROJECT-scoped coder session — opening/inspecting/driving the
   * project's running app is broadly relevant to project work, and a builder
   * project always wants it. Non-project / company sessions leave it
   * `undefined` and unlock on demand via `find_tools` → `expand_toolset('preview')`,
   * so the multi-agent surface isn't bloated by 16 tools per agent.
   */
  function resolvePreviewAvailable(id: number): boolean | undefined {
    const session = sessionStore.getSession(id);
    if (!session) return undefined;
    return session.project_id != null ? true : undefined;
  }

  function applyGeneratedSessionTitle(id: number, title: string | undefined): boolean {
    if (!title) return false;
    const current = sessionStore.getSession(id);
    if (!current || !isAutomaticSessionTitle(current.title)) return false;
    sessionStore.setSessionTitle(id, title);
    return true;
  }

  const sessionTitleJobs = new Map<number, Promise<void>>();

  function scheduleGeneratedSessionTitle(id: number, userMessage: string): void {
    if (sessionTitleJobs.has(id)) return;
    const job = deps.taskPreflight.generateSessionTitle({ userMessage })
      .then((result) => {
        if (result.status === 'ok') applyGeneratedSessionTitle(id, result.title);
        else if (result.status !== 'unconfigured') {
          console.warn(`[session-title] session=${id}: ${result.error ?? result.status}`);
        }
      })
      .catch((error) => {
        console.warn(`[session-title] session=${id}: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        sessionTitleJobs.delete(id);
      });
    sessionTitleJobs.set(id, job);
  }

  /**
   * Task preflight — when the `code-agent/preflight` binding is configured
   * (Admin → Pipelines), analyze the FIRST prompt of a fresh session with a
   * cheap model and seed the run: minimal profile, pinned tools, and which
   * project memories to read. Runs OUTSIDE the session lock (up to ~4s);
   * worst case two racing POSTs pay the analysis twice and the lock loser's
   * seed is discarded with its run. Fail-open by construction: any non-ok
   * status (unconfigured / timeout / provider error / unparseable output)
   * returns undefined and the session starts exactly as before.
   */
  async function maybeRunPreflight(
    id: number,
    body: SendMessageBody,
  ): Promise<PreflightSeed | undefined> {
    try {
      if (process.env.CODER_PREFLIGHT === '0') return undefined;
      // Only resume runs are never fresh tasks. An explicit agent/profile no
      // longer blocks preflight: it still runs on a fresh session to seed
      // tools + relevant memories, and its profile seed loses to the explicit
      // choice downstream (resolveSessionProfile: explicit > seed > heuristic).
      // The dashboard always sends the default agent='explore', which used to
      // suppress preflight on every chat — that's the bug this removes.
      if (body.resume) return undefined;
      if (!body.content?.trim()) return undefined;
      const session = sessionStore.getSession(id);
      if (!session) return undefined;
      // Fresh = zero messages AND no durable compaction summary (mirrors
      // runCoder's own hasHistory check) AND no live bus (attach path).
      if (session.compaction_summary) return undefined;
      if (sessionStore.getMessageCount(id) > 0) return undefined;
      const liveBus = coderWorkerEnabled()
        ? getCoderWorkerPool().getBus(id)
        : activeRuns.get(id);
      if (liveBus && !liveBus.ended) return undefined;

      const workspaceProjects = session.is_global
        ? assignWorkspaceSlugs(deps.db.listUnionProjectIds(session.project_id)).map((p) => ({
            projectId: p.project_id,
            name: p.name,
            slug: p.slug,
            rootPath: p.root_path,
            isPrimary: p.is_primary,
          }))
        : (() => {
            const project = deps.db.getProject(session.project_id);
            return project
              ? [{
                  projectId: project.id,
                  name: project.name,
                  slug: workspaceSlug(project.name),
                  rootPath: project.root_path,
                  isPrimary: true,
                }]
              : [];
          })();
      const preflightInput = {
        sessionId: id,
        projectId: session.project_id,
        userMessage: body.content,
        isGlobalWorkspace: session.is_global,
        workspaceProjects,
      };
      const capabilityFingerprint = deps.taskPreflight.getCapabilityFingerprint?.(preflightInput) ?? '';
      const cacheHash = hashPreflightContent(`${body.content}\0${capabilityFingerprint}`);

      // Idempotent reuse (mig 180): a prior fresh POST already computed + cached
      // the seed. Reuse it (no recompute, no new trail — telemetry is
      // intentionally skipped on the cache hit) so the analyzer runs at most once
      // per fresh session AND the agent still receives the <preflight> hint even
      // if an earlier run failed before persisting its first message (the symptom
      // behind "preflight em loop"). Reuse ONLY when the cached entry matches the
      // CURRENT prompt — an edit-and-resend on a still-fresh session must not
      // deliver a seed scoped to the discarded text. Corrupt / shape-drifted /
      // content-mismatched cache → clear + recompute.
      if (session.preflight_seed_json) {
        try {
          const cached = JSON.parse(session.preflight_seed_json) as { h?: string; seed?: PreflightSeed };
          if (cached && cached.seed && cached.h === cacheHash) {
            applyGeneratedSessionTitle(id, cached.seed.sessionTitle);
            return cached.seed;
          }
        } catch { /* fall through to clear + recompute */ }
        try { sessionStore.setSessionPreflightSeed(id, null); } catch { /* best-effort */ }
      }

      const result = await deps.taskPreflight.run(preflightInput);
      if (result.status === 'unconfigured') return undefined;

      if (result.status === 'ok') {
        applyGeneratedSessionTitle(id, result.seed?.sessionTitle);
      }

      // Input-tab trail (kind 'preflight') — hint body on success, short
      // diagnostic on failure; meta feeds the effectiveness funnel.
      try {
        sessionStore.recordSessionInput({
          session_id: id,
          kind: 'preflight',
          source_label: 'turn-start',
          content: result.status === 'ok' && result.seed
            ? renderPreflightHint(result.seed)
            : (result.error ?? result.status),
          meta: {
            status: result.status,
            latency_ms: result.latencyMs,
            provider_id: result.providerId ?? null,
            model_id: result.modelId ?? null,
            resolved_from: result.resolvedFrom ?? null,
            session_title: result.seed?.sessionTitle ?? null,
            task_kind: result.seed?.taskKind ?? null,
            profile: result.seed?.profile ?? null,
            tools: result.seed?.pinTools ?? [],
            // External MCP tools the analyzer pinned (subset of pinTools) —
            // distinguishes MCP suggestions from native pins in the funnel.
            ext_tools: result.seed?.pinTools?.filter((t) => t.startsWith('ext_')) ?? [],
            skills: result.seed?.suggestedSkills?.map((s) => s.id) ?? [],
            target_projects: result.seed?.targetProjects?.map((p) => p.slug) ?? [],
            memories: result.seed?.memories?.map((m) => m.title) ?? [],
          },
        });
      } catch { /* input log is best-effort */ }

      // Cache the seed for reuse on the next fresh POST (mig 180). Best-effort —
      // a failed cache write just means the next POST recomputes.
      if (result.status === 'ok' && result.seed) {
        try {
          sessionStore.setSessionPreflightSeed(
            id,
            JSON.stringify({ h: cacheHash, seed: result.seed }),
          );
        } catch { /* cache is best-effort */ }
      }

      return result.status === 'ok' ? result.seed : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Reattach to an in-flight run via SSE. Replays buffered events from
   * (Last-Event-ID + 1) and then forwards live events until the run ends
   * or the client disconnects.
   */
  app.get('/api/coder/sessions/:id/attach', (c) => {
    const id = parseIdParam(c);
    const bus = activeRuns.get(id);
    if (!bus) return c.json({ error: 'no active run' }, 404);

    const lastEventId = parseLastEventId(c);
    emitWorkerLog(bus, 'info', 'route', 'GET /attach', {
      last_event_id: lastEventId,
      buffer_size: bus.buffer.length,
    });
    return pumpBusToSSE(c, bus, { since: lastEventId });
  });

  /**
   * Tool-call breakdown for a session — used by the "Tool Stats" modal
   * in the chat header. Single round-trip diagnosis when the user
   * suspects the agent is looping (session 722: 67 update_todo calls
   * dominating 31% of the run). Cap `recent` via query string for
   * heavier debug sessions.
   */
  app.get('/api/coder/sessions/:id/tool-stats', (c) => {
    const id = parseIdParam(c);
    const session = sessionStore.getSession(id);
    if (!session) return c.json({ error: 'session not found' }, 404);
    const recentRaw = c.req.query('recent');
    const recent = recentRaw ? Number(recentRaw) : 30;
    const stats = sessionStore.getToolCallStats(
      id,
      Number.isFinite(recent) && recent > 0 ? recent : 30,
    );
    return c.json({ sessionId: id, ...stats });
  });

  /**
   * Diagnose endpoint — the dashboard hits this when `/attach` returns
   * 404 to disambiguate the three states that collapse into the same
   * "no active run" HTTP response:
   *
   *   - alive=false, status=idle           — fresh / completed session, normal UI
   *   - alive=false, status=in_progress    — worker died silently, session
   *                                          row is stale (boot recovery
   *                                          will fix it on next restart)
   *   - alive=true                         — race: worker exists but the
   *                                          bus was just evicted; client
   *                                          should retry attach shortly
   *
   * Mirrors the shape of the terminal-ws diagnose endpoint so the
   * dashboard hooks share the same handling pattern. Returns 404 only
   * when the session row itself doesn't exist.
   */
  app.get('/api/coder/sessions/:id/state', (c) => {
    const id = parseIdParam(c);
    const session = sessionStore.getSession(id);
    if (!session) return c.json({ error: 'session not found' }, 404);
    const alive = activeRuns.has(id);
    return c.json({
      sessionId: id,
      status: session.status,
      alive,
      updatedAt: session.updated_at,
    });
  });

  app.get('/api/coder/sessions/:id/events.jsonl', (c) => {
    const id = parseIdParam(c);
    const events = getRuntimeEventLog('coder', id);
    return new Response(runtimeEventsToJsonl(events), {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'content-disposition': `attachment; filename="coder-session-${id}-events.jsonl"`,
      },
    });
  });

  app.get('/api/coder/sessions/:id/events-summary', (c) => {
    const id = parseIdParam(c);
    return c.json(summarizeRuntimeEvents(getRuntimeEventLog('coder', id)));
  });

  app.post('/api/coder/sessions/:id/messages', attachmentBodyLimit, async (c) => {
    const id = parseIdParam(c);
    const body = await c.req.json<SendMessageBody>();
    const attachmentsCheck = validateAttachments(body.attachments);
    if (!attachmentsCheck.ok) {
      return c.json(
        { error: attachmentsCheck.error, code: attachmentsCheck.code },
        attachmentsCheck.status,
      );
    }
    body.attachments = attachmentsCheck.value;
    if (!body.resume && !body.content?.trim() && body.attachments?.length) {
      body.content = DEFAULT_ATTACHMENT_PROMPT;
    }
    // Apêndice 4 Fase 2 — resume-mode skips the content check: the
    // dashboard sends `{resume: true, content: ''}` after an
    // /answer-via-worker fallback, where the tool_result is already in
    // history and there's no new user message to attach.
    if (!body.resume && !body.content?.trim()) return c.json({ error: 'content required' }, 400);
    const runAgent = resolveRunAgent(id, body.agent);
    // The request keeps precedence for explicit callers. When omitted (for
    // example during a remount race), fall back to the conversation's sticky
    // toggle so the next run cannot silently lose the user's last choice.
    const thinking = body.thinking ?? sessionStore.getSession(id)?.thinking_enabled ?? false;
    const dedupeKey = normalizeDedupeKey(body.client_msg_id);
    // Log the route hit. The bus may not exist yet (fresh session) —
    // emitWorkerLog no-ops in that case, but if a worker is still alive
    // (attach branch) the dashboard sees the incoming POST live.
    {
      const existing = coderWorkerEnabled()
        ? getCoderWorkerPool().getBus(id)
        : activeRuns.get(id);
      emitWorkerLog(existing, 'info', 'route', 'POST /messages', {
        content_preview: body.content?.slice(0, 80) ?? '',
        resume: !!body.resume,
        agent: runAgent,
        requested_agent: body.agent ?? null,
        profile: body.profile,
        interject: !!body.interject,
        attachment_count: body.attachments?.length ?? 0,
      });
    }

    // The list of skill IDs is threaded through to the runner verbatim so it
    // can rematerialize the `<active_skills>` block per turn. We deliberately
    // do NOT inline the bodies into `body.content` anymore — that used to
    // bloat the persisted user message with thousands of tokens of skill
    // instructions on every turn. The picks are persisted alongside the
    // message in `coder_messages.selected_skill_ids_json` (migration 095).
    const selectedSkillIds =
      body.selected_skill_ids && body.selected_skill_ids.length > 0
        ? body.selected_skill_ids
        : undefined;

    // Office/OpenDocument files stay native on general file-input transports
    // (OpenAI/Codex/OpenRouter) and use a portable local text extraction path
    // elsewhere. PDFs similarly follow the declarative transport/model
    // capability. Embedded
    // figures are pulled out as image blocks only when the model has vision (or
    // the user forced the vision-fallback), so a blind model doesn't pay surprise
    // describe-image cost. Mutating `body` here covers both the worker and legacy
    // fresh paths; attachments are first-message-only, so this runs at most once.
    if (body.attachments && body.attachments.length > 0) {
      const extractImages =
        resolveModelSupportsVision(id) === true || body.describe_images === true;
      const fileHandling = resolveFileHandling(id);
      const extractPdfText = !pdfHandledNatively(fileHandling);
      body.attachments = await normalizeAttachmentsForModel(body.attachments, {
        extractImages,
        extractPdfText,
        keepBinaryDocuments: binaryDocumentsHandledNatively(fileHandling),
      });
    }

    // Structural auto-index. Only the FIRST turn claims the project lifecycle;
    // later turns rely on watcher/Monaco deltas and never schedule another
    // full reconciliation. A missing baseline gates for up to three minutes,
    // while an existing integral index is returned immediately even if its
    // stat-first reopen reconciliation is still running in the background.
    {
      const session = sessionStore.getSession(id);
      if (session?.project_id != null) {
        // Global session: rebuild the synthetic union's junctions if missing,
        // then index the union itself (session.project_id IS the synthetic
        // project whose root spans every linked project via junctions).
        if (session.is_global) ensureGlobalWorkspaceLinks(deps, session);
        const freshSession = !body.resume
          && !session.compaction_summary
          && sessionStore.getMessageCount(id) === 0;
        if (freshSession) {
          deps.projectIndexService.ensureFresh(session.project_id, 'session');
          const readiness = await deps.projectIndexService.ensureStructuralReady(
            session.project_id,
            structuralIndexGateTimeoutMs(),
            c.req.raw.signal,
          );
          if (readiness.status === 'aborted') {
            return c.json({ code: 'INDEX_WAIT_ABORTED', message: 'Envio cancelado durante a indexação.' }, 408);
          }
          if (readiness.status !== 'ready') {
            // Timeout, disabled indexing or a terminal scan error starts dumb
            // mode instead of rejecting the user's message. Tools remain in
            // the registry and observe the live DB on later calls, so this
            // same session recovers when the baseline eventually completes.
            console.warn(
              `[coder] structural index gate bypassed for session ${id}: ${readiness.status}` +
              `${readiness.error ? ` (${readiness.error})` : ''}`,
            );
          }
        }
      }
    }

    // Task preflight (fresh sessions only) — deliberately OUTSIDE the lock
    // so a slow analyzer (≤ ~4s) never serializes an attach to a live run.
    const preflight = await maybeRunPreflight(id, body);

    // Normally the preflight JSON already carries `sessionTitle`, making title
    // generation free. If preflight is disabled, unconfigured, timed out, or an
    // older cached seed lacks that field, run a non-blocking title-only call via
    // the SAME pipeline binding. Re-check-before-write protects manual renames.
    if (!preflight?.sessionTitle) {
      const titleSeed = cleanSessionTitleSeed(body.content ?? '');
      const current = sessionStore.getSession(id);
      if (titleSeed && current && isAutomaticSessionTitle(current.title)) {
        scheduleGeneratedSessionTitle(id, titleSeed);
      }
    }

    // Serialize the "do we have an active run?" decision per session so two
    // concurrent POSTs cannot both observe `activeRuns.get(id) === undefined`
    // and each spin up a fresh `runCoder`. Inside the lock we either:
    //   (a) attach to the live run by enqueueing the message + tailing the
    //       existing bus, or
    //   (b) create a brand new bus + runCoder and tail that.
    // The lock is released as soon as the synchronous setup completes — the
    // SSE stream itself is not held under the lock.
    const decide = async (): Promise<
      | { kind: 'attach'; bus: ReturnType<typeof createBus>; tailFrom: number }
      | { kind: 'fresh'; bus: ReturnType<typeof createBus> }
      | { kind: 'reject'; status: 409; body: { error: string; code: string } }
    > => {
      // P17 — worker-backed coder path. Same decision tree, but the
      // runner lives in a dedicated worker_thread. Synchronous runner
      // pokes (`isWaitingForInput`, `pushUserMessage`, `interruptWait`)
      // become RPC round-trips via `CoderWorkerPool`. We short-circuit
      // BEFORE the legacy decision tree so the rest of this function
      // stays untouched when the flag is off.
      if (coderWorkerEnabled()) {
        const pool = getCoderWorkerPool();
        const existingBus = pool.getBus(id);
        if (existingBus && !existingBus.ended) {
          if (body.attachments && body.attachments.length > 0) {
            return {
              kind: 'reject',
              status: 409,
              body: {
                error: 'attachments are only supported on the first message of a session — drop them or wait for the current run to finish',
                code: 'ATTACHMENTS_MIDRUN_UNSUPPORTED',
              },
            };
          }
          const waiting = await pool.isWaitingForInput(id).catch(() => false);
          if (waiting) {
            if (!body.interject) {
              return {
                kind: 'reject',
                status: 409,
                body: {
                  error: 'runner is waiting for an interactive answer — use /answer or /plan-response, or pass {"interject": true} to override',
                  code: 'INTERACTION_PENDING',
                },
              };
            }
            await pool.interruptWait(id).catch(() => undefined);
          }
          const userMsg: AgentMessage = {
            role: 'user',
            content: [{ type: 'text', text: body.content }],
            ...(selectedSkillIds ? { selectedSkillIds } : {}),
          };
          const roundMessageId = sessionStore.appendMessage(id, userMsg);
          await pool.pushUserMessage(id, body.content, selectedSkillIds, roundMessageId);
          return { kind: 'attach', bus: existingBus, tailFrom: existingBus.nextSeq - 1 };
        }
        // Fresh run via the worker — `runFresh` spawns the worker (if
        // needed), kicks off `runCoder()` inside it, and returns the
        // main-side mirrored bus the route can pump to SSE.
        const freshBus = await pool.runFresh(id, {
          userMessage: body.content,
          attachments: body.attachments,
          maxTurns: body.max_turns,
          planMode: body.plan_mode,
          agent: runAgent,
          profile: body.profile,
          worktree: body.worktree,
          thinking,
          modelSupportsVision: resolveModelSupportsVision(id),
          describeImages: body.describe_images,
          previewAvailable: resolvePreviewAvailable(id),
          selectedSkillIds,
          ideContext: body.ide_context,
          preflight,
          ...deps.buildAgentDecisionRuntimeOptions(),
          // Apêndice 4 Fase 2 — when the dashboard is resuming via the
          // worker-fallback path, the synthetic tool_result is already
          // in history. runCoder({resume:true}) picks up from there
          // without pushing a new user turn.
          resume: body.resume,
        });
        return { kind: 'fresh', bus: freshBus };
      }

      const existing = activeRuns.get(id);
      if (existing && !existing.ended) {
        // Attachments are intentionally not supported on enqueue-and-attach:
        // the runner's pendingUserMessages buffer is text-only and the live
        // turn already committed to whatever attachments were sent at start.
        // Reject explicitly so the caller knows to either start a new session
        // or wait for the current run to finish.
        if (body.attachments && body.attachments.length > 0) {
          return {
            kind: 'reject',
            status: 409,
            body: {
              error: 'attachments are only supported on the first message of a session — drop them or wait for the current run to finish',
              code: 'ATTACHMENTS_MIDRUN_UNSUPPORTED',
            },
          };
        }

        let runner;
        try {
          runner = await Promise.race([
            existing.runnerReady,
            new Promise<never>((_, rej) =>
              setTimeout(() => rej(new Error('runner not ready')), RUNNER_READY_TIMEOUT_MS),
            ),
          ]);
        } catch {
          // The first run failed before wiring its runner, or setup is
          // taking abnormally long. Fall through to creating a fresh run —
          // the failed bus will linger-evict on its own timer.
          return { kind: 'fresh', bus: startFreshRun() };
        }

        // Live run waiting on an interactive tool? `interject:true` means
        // "abandon the wait and process my message instead" (mirrors how
        // company subordinates wake the master from `wait_for_subordinates`).
        // Without `interject` we steer callers to the canonical /answer route.
        if (runner.isWaitingForInput()) {
          if (!body.interject) {
            return {
              kind: 'reject',
              status: 409,
              body: {
                error: 'runner is waiting for an interactive answer — use /answer or /plan-response, or pass {"interject": true} to override',
                code: 'INTERACTION_PENDING',
              },
            };
          }
          runner.interruptWait();
        }

        // Persist the user message BEFORE pushing it onto the runner's
        // pendingUserMessages buffer. If the runner crashes/aborts before
        // flushing, the message is still in the DB so a future resume can
        // pick it up. The runner only consumes its in-memory history during
        // a run, so there is no DB-to-runner race here.
        const userMsg: AgentMessage = {
          role: 'user',
          content: [{ type: 'text', text: body.content }],
          ...(selectedSkillIds ? { selectedSkillIds } : {}),
        };
        const roundMessageId = sessionStore.appendMessage(id, userMsg);
        runner.pushUserMessage(body.content, { selectedSkillIds, roundMessageId });

        // Tail mode: subscribe to events from now on, no replay. The runner
        // will emit a fresh `turn_start` (and downstream tool calls) when
        // it picks up the enqueued message at the next turn boundary.
        return { kind: 'attach', bus: existing, tailFrom: existing.nextSeq - 1 };
      }

      // No live run, or the previous bus is in its 30s linger window with
      // `ended === true`. Either way, create a new run.
      return { kind: 'fresh', bus: startFreshRun() };

      // Synchronous setup of a fresh run + register in activeRuns. The
      // actual `runCoder()` call is fired into the background below so the
      // lock returns quickly.
      function startFreshRun() {
        const ctrl = new AbortController();
        const newBus = createBus(ctrl);
        installRuntimeEventLog(newBus, 'coder', id);
        activeRuns.set(id, newBus);
        return newBus;
      }
    };

    const decision = await withSessionLock(id, async (): Promise<
      | Awaited<ReturnType<typeof decide>>
      | { kind: 'replay'; bus: ReturnType<typeof createBus>; since: number }
      | { kind: 'gone' }
    > => {
      // Idempotency: a `ReconnectingSSEClient` retry re-POSTs this body. If the
      // same client_msg_id was seen and the original run's bus is still
      // reachable, replay it (a bus already ended is always safe to replay; a
      // live bus must be the currently-registered one, else waitEnded would
      // hang) instead of re-running the append/push/spawn side effects. Runs
      // BEFORE the isWaitingForInput check so a retry never triggers a spurious
      // 409 interrupt handshake.
      if (dedupeKey) {
        const hit = recentMessageKeys.lookup(id, dedupeKey);
        if (hit) {
          emitWorkerLog(hit.bus, 'info', 'route', 'POST /messages deduped (retry replay)', {
            client_msg_id: dedupeKey,
            bus_gone: !hit.bus,
          });
          return hit.bus && (hit.bus.ended || hit.bus === activeRuns.get(id))
            ? { kind: 'replay', bus: hit.bus, since: Math.max(parseLastEventId(c), hit.sinceHint) }
            : { kind: 'gone' };
        }
      }
      const d = await decide();
      // Record AFTER a successful decision, still inside the lock so a racing
      // retry observes it. If `decide()` threw (e.g. a worker RPC failed after
      // appendMessage) the key is intentionally NOT recorded, so the retry
      // reprocesses rather than replaying a run that never took hold — the
      // narrow cost being a possible duplicate append in that rare window.
      if (dedupeKey && (d.kind === 'attach' || d.kind === 'fresh')) {
        recentMessageKeys.record(id, dedupeKey, d.bus, d.kind === 'attach' ? d.tailFrom : -1);
      }
      return d;
    });

    if (decision.kind === 'reject') {
      return c.json(decision.body, decision.status);
    }
    if (decision.kind === 'replay') {
      return pumpBusToSSE(c, decision.bus, { since: decision.since });
    }
    if (decision.kind === 'gone') {
      // The retry's original run finished and its bus was evicted. Emit a
      // synthetic terminal so the client resolves cleanly and refetches the
      // persisted history (which already holds the run's output).
      return syntheticDoneSSE(c, { reason: 'completed', duplicate: true });
    }
    if (decision.kind === 'attach') {
      keepSemanticProjectAlive(id, decision.bus);
      return pumpBusToSSE(c, decision.bus, {
        since: decision.tailFrom,
      });
    }

    keepSemanticProjectAlive(id, decision.bus);

    // Fresh run. When the worker flag is on, `pool.runFresh()` already
    // kicked off `runCoder()` inside the worker — the route just
    // pumps the mirrored bus to SSE and returns.
    if (coderWorkerEnabled()) {
      return pumpBusToSSE(c, decision.bus);
    }
    // Legacy in-process fresh run: fire runCoder fire-and-forget. The
    // HTTP response only subscribes to the bus — if the client
    // disconnects, the run keeps producing events into the buffer
    // until it finishes.
    const bus = decision.bus;
    void (async () => {
      let pluginHost: PluginWorkerHost | null = null;
      try {
        const { toolPlugins, bundles } = listEnabledPluginRuntime({
          projectRoot: projectRootForSession(deps, id),
        });
        let pluginTools: ReturnType<typeof buildPluginTools> | undefined;
        if (toolPlugins.length > 0) {
          const host = new PluginWorkerHost({ bundles, hostInvoke: getPluginHostInvoke() });
          pluginHost = host;
          pluginTools = buildPluginTools(toolPlugins, (ns, name, args, ctx) =>
            host.invokeTool(ns, name, args, ctx),
          );
        }
        const handle = await runCoder({
          session: { id },
          resolveRuntimeEnv: resolveAgentRuntimeEnv,
          userMessage: body.content,
          attachments: body.attachments,
          maxTurns: body.max_turns,
          planMode: body.plan_mode,
          agent: runAgent,
          profile: body.profile,
          worktree: body.worktree,
          thinking,
          modelSupportsVision: resolveModelSupportsVision(id),
          describeImages: body.describe_images,
          previewAvailable: resolvePreviewAvailable(id),
          selectedSkillIds,
          ideContext: body.ide_context,
          preflight,
          pluginTools,
          signal: bus.ctrl.signal,
          mcpBearerResolver: deps.mcpBearerResolver,
          // Mem C — proactive project-memory injection (in-process path).
          memoryRetriever: deps.memoryRetriever,
          // Smart recall query for meta/continuation messages (in-process path).
          memoryQuerySynthesizer: deps.memoryQuerySynthesizer,
          // Mem C write-back — distill durable memory at run-end (in-process path).
          runEndMemory: deps.runEndMemory,
          // Direct agent ports — save_note scope 'project' + recall_memory.
          projectMemory: deps.projectMemory,
          // Reuse the long-lived McpExternalPool from server boot so we
          // don't reconnect every external MCP server per chat turn.
          // The pool implements IMcpServerManager directly; runCoder
          // detects the injection and skips the legacy
          // `new McpServerManager()` path.
          externalMcpManager: getGlobalMcpExternalPool() ?? undefined,
          onSnapshotRecorded: (info) => publish(bus, 'session_snapshot_changed', info),
          // Wire optional runtime decision/tool-selection hooks. Every helper is
          // default-off, so env flags disabled preserve the old runner options.
          toolSelectionFilter: deps.buildToolSelectionFilter(),
          ...deps.buildAgentDecisionRuntimeOptions(),
          // Inject docs_deep_research — the DocsAgent escalation tool.
          // The bridge singleton is installed in server.ts at boot; the
          // helper returns false when unset (e.g. headless tests) so the
          // runner just doesn't see the tool — no errors.
          onRunnerReady: (runner) => {
            installDocsDeepResearch(runner);
          },
        });
        setBusRunner(bus, handle.runner);
        publish(bus, 'session', handle.session);
        publish(bus, 'index_status', handle.indexStatus);
        wireRunnerToBus(handle.runner, bus);
        await handle.done;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        publish(bus, 'error', { message });
        markEnded(bus, 'error', { message });
      } finally {
        void pluginHost?.dispose();
        // Turn ended → free the agent's preview WINDOW now (keep any
        // preview-owned dev server up for the next turn). In-process mirror
        // of the worker pool's bus.end → closeWindow.
        closePreviewWindow(id);
        // Builder checkpoint (in-process mirror of the pool's bus.end hook).
        notifyBuilderRunEnded(id);
        // Linger in the map so a late reattach (tab closed near done) still
        // sees the full buffer. After BUS_LINGER_MS the entry is evicted —
        // at which point we also stop any preview-owned dev server.
        setTimeout(() => {
          if (activeRuns.get(id) === bus) {
            activeRuns.delete(id);
            closePreviewSession(id);
          }
        }, BUS_LINGER_MS);
      }
    })();

    return pumpBusToSSE(c, bus);
  });

  /**
   * Continue a session that was paused on a pending plan/question after the
   * dashboard answered it via /plan-response or /answer with `{resumed:true}`.
   * Mirrors POST /messages but calls runCoder with `resume: true` so no new
   * user message is pushed — the runner picks up from history (which now ends
   * with the just-appended tool_result) and runs the next turn.
   */
  app.post('/api/coder/sessions/:id/continue', async (c) => {
    const id = parseIdParam(c);
    let body: ContinueBody = {};
    try {
      body = await c.req.json();
    } catch {
      /* empty body is fine */
    }

    const data = sessionStore.loadSessionWithMessages(id);
    if (!data) return notFound(c);
    const last = data.messages[data.messages.length - 1];
    if (!last || last.role !== 'tool') {
      return c.json({ error: 'session not in resumable state' }, 409);
    }
    const runAgent = resolveRunAgent(id, body.agent);
    const dedupeKey = normalizeDedupeKey(body.client_msg_id);
    // Pre-spawn log: bus is about to be created below. We can't emit
    // here because no bus exists yet — but the route-entry hit will
    // appear via the fresh bus's `run_started` event seq=0.

    // Take the lock so a /continue racing with a /messages can't both spin
    // up runCoder for the same session. We hold it only across the
    // synchronous setup; the SSE pump runs outside the lock.
    const decision = await withSessionLock(id, async (): Promise<
      | { kind: 'replay'; bus: ReturnType<typeof createBus>; since: number }
      | { kind: 'gone' }
      | { kind: 'attach'; bus: ReturnType<typeof createBus>; tailFrom: number }
      | { kind: 'fresh'; bus: ReturnType<typeof createBus> }
    > => {
      // Idempotency: a retry re-POSTs this body. Replay the original bus
      // instead of spinning a second runCoder (see /messages + recent-message-keys.ts).
      if (dedupeKey) {
        const hit = recentMessageKeys.lookup(id, dedupeKey);
        if (hit) {
          return hit.bus && (hit.bus.ended || hit.bus === activeRuns.get(id))
            ? { kind: 'replay', bus: hit.bus, since: Math.max(parseLastEventId(c), hit.sinceHint) }
            : { kind: 'gone' };
        }
      }
      // Hardening: a live run already owns this session (double-submit, a
      // retry without a key, or a /continue racing an in-flight run). Never
      // start a second concurrent runCoder over the same session DB — tail
      // the live bus instead. Previously this path unconditionally created a
      // fresh bus and overwrote activeRuns, orphaning the running runner.
      const live = activeRuns.get(id);
      if (live && !live.ended) {
        if (dedupeKey) recentMessageKeys.record(id, dedupeKey, live, live.nextSeq - 1);
        return { kind: 'attach', bus: live, tailFrom: live.nextSeq - 1 };
      }
      const ctrl = new AbortController();
      const newBus = createBus(ctrl);
      installRuntimeEventLog(newBus, 'coder', id);
      activeRuns.set(id, newBus);
      if (dedupeKey) recentMessageKeys.record(id, dedupeKey, newBus, -1);
      return { kind: 'fresh', bus: newBus };
    });

    if (decision.kind === 'replay') {
      return pumpBusToSSE(c, decision.bus, { since: decision.since });
    }
    if (decision.kind === 'gone') {
      return syntheticDoneSSE(c, { reason: 'completed', duplicate: true });
    }
    if (decision.kind === 'attach') {
      emitWorkerLog(decision.bus, 'warn', 'route', 'POST /continue attached to live run', {
        client_msg_id: dedupeKey ?? null,
      });
      keepSemanticProjectAlive(id, decision.bus);
      return pumpBusToSSE(c, decision.bus, { since: decision.tailFrom });
    }

    const bus = decision.bus;
    keepSemanticProjectAlive(id, bus);
    // Log the route hit on the fresh bus — the dashboard will see the
    // POST /continue entry seq=0 with the resume context.
    emitWorkerLog(bus, 'info', 'route', 'POST /continue', {
      agent: runAgent,
      requested_agent: body.agent ?? null,
      profile: body.profile,
      plan_mode: body.plan_mode,
      max_turns: body.max_turns,
    });

    void (async () => {
      let pluginHost: PluginWorkerHost | null = null;
      try {
        const { toolPlugins, bundles } = listEnabledPluginRuntime({
          projectRoot: projectRootForSession(deps, id),
        });
        let pluginTools: ReturnType<typeof buildPluginTools> | undefined;
        if (toolPlugins.length > 0) {
          const host = new PluginWorkerHost({ bundles, hostInvoke: getPluginHostInvoke() });
          pluginHost = host;
          pluginTools = buildPluginTools(toolPlugins, (ns, name, args, ctx) =>
            host.invokeTool(ns, name, args, ctx),
          );
        }
        const handle = await runCoder({
          session: { id },
          resolveRuntimeEnv: resolveAgentRuntimeEnv,
          userMessage: '',
          maxTurns: body.max_turns,
          planMode: body.plan_mode,
          agent: runAgent,
          profile: body.profile,
          resume: true,
          modelSupportsVision: resolveModelSupportsVision(id),
          describeImages: body.describe_images,
          previewAvailable: resolvePreviewAvailable(id),
          pluginTools,
          signal: bus.ctrl.signal,
          mcpBearerResolver: deps.mcpBearerResolver,
          // Mem C — proactive project-memory injection (in-process path).
          memoryRetriever: deps.memoryRetriever,
          // Smart recall query for meta/continuation messages (in-process path).
          memoryQuerySynthesizer: deps.memoryQuerySynthesizer,
          // Mem C write-back — distill durable memory at run-end (in-process path).
          runEndMemory: deps.runEndMemory,
          // Direct agent ports — save_note scope 'project' + recall_memory.
          projectMemory: deps.projectMemory,
          // Same pool reuse as the fresh-run path — `continue` resumes
          // an existing session, but we still spin a fresh runCoder()
          // call which would otherwise rebuild McpServerManager.
          externalMcpManager: getGlobalMcpExternalPool() ?? undefined,
          onSnapshotRecorded: (info) => publish(bus, 'session_snapshot_changed', info),
          // Same docs_deep_research wiring as the fresh-run path so resumed
          // sessions get the escalation tool on turn 1.
          onRunnerReady: (runner) => {
            installDocsDeepResearch(runner);
          },
          toolSelectionFilter: deps.buildToolSelectionFilter(),
          ...deps.buildAgentDecisionRuntimeOptions(),
        });
        setBusRunner(bus, handle.runner);
        publish(bus, 'session', handle.session);
        publish(bus, 'index_status', handle.indexStatus);
        wireRunnerToBus(handle.runner, bus);
        await handle.done;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        publish(bus, 'error', { message });
        markEnded(bus, 'error', { message });
      } finally {
        void pluginHost?.dispose();
        // Turn ended → free the agent's preview window (see /fresh path).
        closePreviewWindow(id);
        // Builder checkpoint (in-process mirror of the pool's bus.end hook).
        notifyBuilderRunEnded(id);
        setTimeout(() => {
          if (activeRuns.get(id) === bus) {
            activeRuns.delete(id);
            closePreviewSession(id);
          }
        }, BUS_LINGER_MS);
      }
    })();

    return pumpBusToSSE(c, bus);
  });
}
