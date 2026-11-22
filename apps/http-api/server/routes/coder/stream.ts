import type { HttpRouter } from '@mcp/shared/http/router.js';
import { sessionRecoveryFailure } from '../../../control-plane-recovery-error.js';
import { bodyLimit } from '@mcp/shared/http/middleware.js';
import { isAbsolute, relative, resolve } from 'node:path';
import { assignWorkspaceSlugs } from '@mcp/shared/utils/workspace-slug.js';
import type { CoderAttachment, PreflightSeed } from '@mcp/code-agent/index.js';
import {
  resolveSessionProjectAuthority,
  type FsCoderSession,
} from '@mcp/session-storage/fs-store/index.js';
import { isUncertainToolOutcomeError } from '@mcp/code-agent/core/uncertain-tool-outcome.js';
import { isWorkspaceRuntimeConflict } from '@mcp/code-agent/runtime/workspace-runtime-error.js';
import type { IdeContext } from '@mcp/code-agent/core/ide-context.js';
import {
  classifyCoderTerminalOutcome,
  normalizeCoderTerminalSignal,
  type SessionId,
} from '@mcp/agent-runtime-contracts';
import { hashControlPlanePayload } from '@mcp/store/control-plane/index.js';
import { modelSupportsVision } from '@mcp/code-agent/providers/capabilities.js';
import { DEFAULT_ATTACHMENT_PROMPT, MAX_ATTACHMENT_REQUEST_BYTES } from '@mcp/shared';
import { renderPreflightHint } from '@mcp/code-agent/core/runner/assembly/preflight-hint.js';
import {
  normalizeSessionMaxAutoContinues,
  normalizeSessionMaxTurns,
} from '@mcp/session-storage/run-limits.js';
import {
  emitWorkerLog,
  type CoderRunBus,
} from '../../../coder-bus.js';
import type { ServerDeps } from '../../deps.js';
import type { CoderRuntime } from './state.js';
import { pumpBusToSSE, parseLastEventId } from '../../../sse/pumpBusToSSE.js';
import { getGlobalPreviewDevtools } from '@mcp/code-agent/tools/preview/index.js';
import { getCoderWorkerPool } from '../../../sse/coderWorkerPoolSingleton.js';
import { coderSetupFailure, isCoderStartupUncertainError } from '../../../sse/coder-runtime-errors.js';
import { parseSessionIdParam, notFound } from '../_helpers.js';
import {
  normalizeDedupeKey,
  syntheticDoneSSE,
  syntheticTerminalSSE,
  type RecentMessageLookup,
} from '../recent-message-keys.js';
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
import {
  getRuntimeEventLog,
  runtimeEventsToJsonl,
  summarizeRuntimeEvents,
} from '../../../sse/runtime-event-log.js';
import {
  resolveAgentSelection,
  type AgentSelectionId,
  type ResolvedAgentSelection,
} from '../../../custom-agents.js';
import {
  acceptLocalCoderCommand,
  bindLocalCommandBus,
  fingerprintLocalCoderMessage,
  terminalizeLocalCoderCommand,
  type LocalCoderShadowAcceptance,
} from '../../../control-plane-shadow.js';

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
  /** JSON admission receipt; the client keeps its existing SSE subscription. */
  response_mode?: 'json';
  /** A parked task must not silently turn into steering if another run starts. */
  only_when_idle?: boolean;
  content: string;
  max_turns?: number;
  max_auto_continues?: number;
  plan_mode?: boolean;
  attachments?: CoderAttachment[];
  /** Agent preset. Takes precedence over profile/plan_mode when unset. */
  agent?: AgentSelectionId;
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
  /** Override the session's default code-comment policy for this run. */
  block_code_comments?: boolean;
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

interface ContinueBody {
  plan_mode?: boolean;
  max_turns?: number;
  max_auto_continues?: number;
  agent?: AgentSelectionId;
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
  app: HttpRouter,
  deps: ServerDeps,
  runtime: CoderRuntime,
): void {
  const { sessionStore, providerStore } = deps;
  const { activeRuns, recentMessageKeys } = runtime;
  const workerPool = getCoderWorkerPool();
  const controlPlaneStore = deps.controlPlaneStore ?? null;
  const semanticBusLeases = new WeakMap<CoderRunBus, () => void>();

  function currentProjectAuthority(session: FsCoderSession) {
    return resolveSessionProjectAuthority(session, (projectId) => {
      const project = deps.db.getProjectCatalogEntry(projectId);
      return project && !project.is_synthetic
        ? {
            project_id: project.id,
            name: project.name,
            root_path: project.root_path,
          }
        : null;
    });
  }

  type EarlyCommandClaim =
    | {
        kind: 'owner';
        acceptance: LocalCoderShadowAcceptance | null;
        claimGuard?: { token: symbol; fingerprintHash: string };
      }
    | { kind: 'pending'; settled: Promise<RecentMessageLookup<CoderRunBus>> }
    | { kind: 'replay'; bus: CoderRunBus; since: number }
    | { kind: 'terminal'; event: 'done' | 'error'; data: Record<string, unknown> }
    | {
        kind: 'reject';
        status: 409 | 503;
        body: { error: string; code: string; retry_after_ms?: number };
        retryAfterMs?: number;
      };

  function terminalForPersistedCommand(
    acceptance: LocalCoderShadowAcceptance,
  ): { event: 'done' | 'error'; data: Record<string, unknown> } | null {
    const status = acceptance.commandStatus;
    if (status === 'succeeded') {
      return { event: 'done', data: { reason: 'completed', duplicate: true, persisted: true } };
    }
    if (status === 'failed' || status === 'cancelled' || status === 'rejected') {
      const details = coderSetupFailure(acceptance.commandReasonCode ?? '');
      return {
        event: 'error',
        data: { ...(details.message ? details : { reason: `command-${status}` }), duplicate: true, persisted: true },
      };
    }
    return null;
  }

  /**
   * Claim the durable command before attachment extraction, index gates,
   * preflight, append, push or worker spawn. The in-memory pending settlement
   * handles same-process races; the filesystem control plane is the restart-safe
   * authority whenever it is available.
   */
  async function claimCoderCommand(input: {
    sessionId: SessionId;
    kind: 'start' | 'send_message' | 'resume';
    dedupeKey?: string;
    fingerprint: Record<string, unknown>;
    createRun: boolean;
    linkedAgentRunId?: Parameters<typeof acceptLocalCoderCommand>[0]['linkedAgentRunId'];
    role: string;
    agentDefinitionId: string;
    requestedProvider?: string;
    requestedModel?: string;
    requestedReasoningEffort?: string;
    requestedPreset?: string;
    requestedCapabilityProfile: string;
    lastEventId: number;
  }): Promise<EarlyCommandClaim> {
    const fingerprintHash = hashControlPlanePayload(input.fingerprint);
    const memoryClaim = input.dedupeKey
      ? recentMessageKeys.claim(input.sessionId, input.dedupeKey, fingerprintHash)
      : null;
    const claimGuard = memoryClaim?.kind === 'owner'
      ? { token: memoryClaim.token, fingerprintHash }
      : undefined;

    // Capacity is a pre-acceptance admission decision. Never create a durable
    // accepted command unless this process can retain its live owner token.
    if (memoryClaim?.kind === 'capacity_exhausted') {
      return {
        kind: 'reject',
        status: 503,
        body: {
          error: 'idempotency owner capacity exhausted; retry later',
          code: 'IDEMPOTENCY_CAPACITY_EXHAUSTED',
          retry_after_ms: memoryClaim.retryAfterMs,
        },
        retryAfterMs: memoryClaim.retryAfterMs,
      };
    }

    // The in-process owner already bound this key to an exact fingerprint.
    // A same-process duplicate must wait BEFORE touching the durable ledger:
    // otherwise it can win durable acceptance, then make the real owner see an
    // `existing` command with no bus and falsely terminalize it as interrupted.
    if (memoryClaim?.kind === 'payload_conflict') {
      return {
        kind: 'reject',
        status: 409,
        body: {
          error: 'client_msg_id is already bound to a different payload',
          code: 'IDEMPOTENCY_PAYLOAD_CONFLICT',
        },
      };
    }
    if (memoryClaim?.kind === 'existing') {
      return { kind: 'pending', settled: memoryClaim.settled };
    }

    let storageFailure: ReturnType<typeof sessionRecoveryFailure>;
    const acceptance = await acceptLocalCoderCommand({
      store: controlPlaneStore,
      sessionId: input.sessionId,
      kind: input.kind,
      idempotencyKey: input.dedupeKey,
      fingerprint: input.fingerprint,
      createRun: input.createRun,
      linkedAgentRunId: input.linkedAgentRunId,
      role: input.role,
      agentDefinitionId: input.agentDefinitionId,
      requestedProvider: input.requestedProvider,
      requestedModel: input.requestedModel,
      requestedReasoningEffort: input.requestedReasoningEffort,
      requestedPreset: input.requestedPreset,
      requestedCapabilityProfile: input.requestedCapabilityProfile,
      onUnavailable: (error) => { storageFailure = sessionRecoveryFailure(error); },
    });

    if (
      acceptance?.outcome === 'payload_conflict'
    ) {
      if (input.dedupeKey && memoryClaim?.kind === 'owner') {
        recentMessageKeys.rejectClaim(input.sessionId, input.dedupeKey, memoryClaim.token, fingerprintHash, {
          event: 'error',
          data: { reason: 'payload_conflict', duplicate: true },
        });
      }
      return {
        kind: 'reject',
        status: 409,
        body: {
          error: 'client_msg_id is already bound to a different payload',
          code: 'IDEMPOTENCY_PAYLOAD_CONFLICT',
        },
      };
    }

    // Production always supplies the store. If it is temporarily unavailable,
    // every command fails closed: even callers without a client key receive a
    // server-generated durable key, so there is no non-authoritative execution
    // path hiding behind the legacy request shape.
    if (!acceptance) {
      if (input.dedupeKey && claimGuard) {
        // No worker/input effect has started. Release the transient owner so
        // the same message can retry admission after storage recovers.
        recentMessageKeys.rejectClaim(input.sessionId, input.dedupeKey, claimGuard.token, claimGuard.fingerprintHash, {
          event: 'error',
          data: { reason: storageFailure?.code ?? 'idempotency-authority-unavailable', duplicate: false, retryable: true },
        });
      }
      return {
        kind: 'reject',
        status: 503,
        body: storageFailure ?? {
          error: 'idempotency authority unavailable; request was not executed',
          code: 'IDEMPOTENCY_AUTHORITY_UNAVAILABLE',
        },
      };
    }

    if (acceptance.outcome === 'version_conflict') {
      if (input.dedupeKey) {
        recentMessageKeys.recordTerminal(input.sessionId, input.dedupeKey, {
          event: 'error',
          data: { reason: acceptance.outcome, duplicate: true },
        }, -1, claimGuard);
      }
      return {
        kind: 'reject',
        status: 409,
        body: {
          error: 'session version changed while accepting the command',
          code: 'COMMAND_VERSION_CONFLICT',
        },
      };
    }

    if (acceptance.outcome === 'existing') {
      const terminal = terminalForPersistedCommand(acceptance);
      if (terminal) {
        if (input.dedupeKey) {
          recentMessageKeys.recordTerminal(input.sessionId, input.dedupeKey, terminal, -1, claimGuard);
        }
        return { kind: 'terminal', ...terminal };
      }

      const live = workerPool.getBus(input.sessionId);
      const liveContext = workerPool.getControlPlaneRunContext?.(input.sessionId);
      const correlatedLive = live
        && !live.ended
        && (
          (acceptance.agentRunId && liveContext?.agentRunId === acceptance.agentRunId)
          || acceptance.executionBusId === live.busId
        )
        ? live
        : null;
      if (correlatedLive) {
        // Durable recovery must honor the caller cursor. Advancing to the
        // current tail would silently skip buffered events after cache loss.
        const sinceHint = input.lastEventId;
        if (input.dedupeKey) {
          recentMessageKeys.record(
            input.sessionId,
            input.dedupeKey,
            correlatedLive,
            sinceHint,
            claimGuard,
          );
        }
        return {
          kind: 'replay',
          bus: correlatedLive,
          since: input.lastEventId,
        };
      }

      // An accepted/running command without its executor bus cannot safely be
      // replayed. Persist interruption and return a terminal; never attempt the
      // append/provider side effects again after a process restart.
      await terminalizeLocalCoderCommand(controlPlaneStore, acceptance, {
        status: 'failed',
        reason: 'executor-bus-unavailable',
        errorRef: 'error:executor-bus-unavailable',
      });
      const interrupted = {
        event: 'error' as const,
        data: {
          reason: 'executor-bus-unavailable',
          duplicate: true,
          persisted: true,
        },
      };
      if (input.dedupeKey) {
        recentMessageKeys.recordTerminal(
          input.sessionId,
          input.dedupeKey,
          interrupted,
          -1,
          claimGuard,
        );
      }
      return { kind: 'terminal', ...interrupted };
    }

    return { kind: 'owner', acceptance, ...(claimGuard ? { claimGuard } : {}) };
  }

  /**
   * A fresh command represents the whole run, not merely worker admission.
   * Keep it non-terminal while its exact bus is live, then persist the actual
   * bus outcome. This prevents a retry from seeing synthetic success while
   * the provider/tools are still running.
   */
  function bindFreshCommandCompletion(
    sessionId: SessionId,
    dedupeKey: string | undefined,
    acceptance: LocalCoderShadowAcceptance | null,
    bus: CoderRunBus,
    claimGuard?: { token: symbol; fingerprintHash: string },
  ): void {
    // AgentRun-backed commands are terminalized centrally by CoderWorkerPool.
    // This listener covers the always-on ledger when the optional AgentRun
    // shadow projection is disabled.
    if (!acceptance?.commandContext || acceptance.runContext) return;
    let settled = false;
    const settle = async (): Promise<void> => {
      if (settled || !bus.ended) return;
      if (
        acceptance.commandStatus === 'succeeded'
        || acceptance.commandStatus === 'failed'
        || acceptance.commandStatus === 'cancelled'
        || acceptance.commandStatus === 'rejected'
      ) {
        settled = true;
        return;
      }
      settled = true;
      const end = bus.endReason ?? {
        event: 'error' as const,
        data: { reason: 'missing-bus-outcome' },
      };
      const data = end.data && typeof end.data === 'object'
        ? end.data as Record<string, unknown>
        : {};
      const normalized = normalizeCoderTerminalSignal(end.event, data);
      const terminal = classifyCoderTerminalOutcome({
        event: normalized.event,
        reason: normalized.data.reason,
        error: normalized.data.error,
        message: normalized.data.message,
      });
      const status = terminal.classification === 'completed'
        ? 'succeeded'
        : terminal.classification === 'cancelled'
          ? 'cancelled'
          : 'failed';
      await terminalizeLocalCoderCommand(controlPlaneStore, acceptance, {
        status,
        reason: terminal.reason,
      });
      if (dedupeKey) {
        recentMessageKeys.recordTerminal(sessionId, dedupeKey, {
          event: normalized.event,
          data: {
            ...normalized.data,
            reason: terminal.reason,
            duplicate: true,
            persisted: true,
          },
        }, -1, claimGuard);
      }
    };
    if (bus.ended) void settle();
    else bus.endListeners.add(() => void settle());
  }

  function contains(root: string, candidate: string): boolean {
    const rel = relative(resolve(root), candidate);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  }

  /**
   * Persist the narrowest possible grant for a path-backed attachment. A
   * reference inside the active project/worktree needs no extra grant; an
   * external reference authorizes that exact file (never its parent folder).
   */
  async function authorizeAttachmentReferences(
    sessionId: SessionId,
    paths: readonly string[],
    enteringWorktree: boolean,
  ): Promise<string | null> {
    if (paths.length === 0) return null;
    const session = await sessionStore.getSession(sessionId);
    if (!session) return 'session not found';
    const authority = currentProjectAuthority(session);
    const projectRoots = enteringWorktree
      ? []
      : [
          ...(authority
            && session.project_id === authority.primary.project_id
            ? [session.worktree_path]
            : []),
          ...(authority?.projects.map((project) => project.root_path) ?? []),
        ].filter((root): root is string => typeof root === 'string' && root.length > 0);
    const existing = await sessionStore.listSessionFilesystemRoots(sessionId);

    for (const path of new Set(paths)) {
      if (projectRoots.some((root) => contains(root, path))) continue;
      if (existing.some((root) => contains(root.root_path, path))) continue;
      if (existing.length >= 16) {
        return 'session filesystem reference limit reached (16); remove an old filesystem grant first';
      }
      const row = await sessionStore.upsertSessionFilesystemRoot(sessionId, path, 'read');
      existing.push(row);
    }
    return null;
  }

  async function keepSemanticProjectAlive(sessionId: SessionId, bus: CoderRunBus): Promise<void> {
    if (bus.ended || semanticBusLeases.has(bus)) return;
    const session = await sessionStore.getSession(sessionId);
    if (!session) return;
    const projectIds = currentProjectAuthority(session)?.projects.map(
      (project) => project.project_id,
    ) ?? [];
    if (projectIds.length === 0) return;
    const releases = projectIds.map((projectId) =>
      deps.semanticCoordinator.acquireCodeProjectLease(
        projectId,
        `coder:${sessionId}:${bus.busId}`,
      ));
    const release = (): void => {
      for (const releaseProject of releases.splice(0)) releaseProject();
    };
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
  async function resolveModelSupportsVision(id: SessionId): Promise<boolean | undefined> {
    const session = await sessionStore.getSession(id);
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

  async function resolveRunAgent(
    id: SessionId,
    requested: unknown,
  ): Promise<ResolvedAgentSelection | null> {
    const session = await sessionStore.getSession(id);
    const persisted = resolveAgentSelection(providerStore, session?.agent);
    const resolved = resolveAgentSelection(providerStore, requested) ?? persisted;
    if (resolved) return resolved;
    // A disabled/deleted custom agent can still be referenced by an old
    // session. Resume it as Explore and let runCoder persist that fallback so
    // the picker and runtime converge instead of constructing an agentless run.
    if (typeof session?.agent === 'string' && session.agent.startsWith('custom:')) {
      return resolveAgentSelection(providerStore, 'explore');
    }
    return null;
  }

  async function resolveFileHandling(id: SessionId) {
    const session = await sessionStore.getSession(id);
    const providerKind = session?.provider
      ? providerStore.getProvider(session.provider)?.kind
      : undefined;
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
   * True for a PROJECT-scoped coder session only when the desktop process has
   * actually installed the Preview DevTools backend. This avoids advertising
   * browser tools in headless/API runs where every call would fail.
   */
  async function resolvePreviewAvailable(id: SessionId): Promise<boolean | undefined> {
    const session = await sessionStore.getSession(id);
    if (!session) return undefined;
    return currentProjectAuthority(session) && getGlobalPreviewDevtools()
      ? true
      : undefined;
  }

  function resolveBrowserAvailable(): boolean | undefined {
    try {
      const config = deps.chromeServiceStore.getConfig();
      return config.enabled && config.status === 'running' ? true : undefined;
    } catch {
      return undefined;
    }
  }

  async function applyGeneratedSessionTitle(
    id: SessionId,
    title: string | undefined,
  ): Promise<boolean> {
    if (!title) return false;
    const current = await sessionStore.getSession(id);
    if (!current || !isAutomaticSessionTitle(current.title)) return false;
    await sessionStore.setSessionTitle(id, title);
    return true;
  }

  const sessionTitleJobs = new Map<SessionId, Promise<void>>();

  function scheduleGeneratedSessionTitle(id: SessionId, userMessage: string): void {
    if (sessionTitleJobs.has(id)) return;
    const job = deps.taskPreflight.generateSessionTitle({ userMessage })
      .then(async (result) => {
        if (result.status === 'ok') {
          await applyGeneratedSessionTitle(id, result.title);
        }
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
   * cheap model and seed the run: title, task kind, minimal profile, skills
   * and which project memories to read. Runs OUTSIDE the session lock (up to ~4s);
   * worst case two racing POSTs pay the analysis twice and the lock loser's
   * seed is discarded with its run. Fail-open by construction: any non-ok
   * status (unconfigured / timeout / provider error / unparseable output)
   * returns undefined and the session starts exactly as before.
   */
  async function maybeRunPreflight(
    id: SessionId,
    body: SendMessageBody,
  ): Promise<PreflightSeed | undefined> {
    try {
      // Only resume runs are never fresh tasks. An explicit agent/profile no
      // longer blocks preflight: it still runs on a fresh session to seed
      // relevant skills + memories, and its profile seed loses to the explicit
      // choice downstream (resolveSessionProfile: explicit > seed > heuristic).
      // The dashboard always sends the default agent='explore', which used to
      // suppress preflight on every chat — that's the bug this removes.
      if (body.resume) return undefined;
      if (!body.content?.trim()) return undefined;
      const session = await sessionStore.getSession(id);
      if (!session) return undefined;
      // Fresh = zero messages AND no durable compaction summary (mirrors
      // runCoder's own hasHistory check) AND no live bus (attach path).
      if (session.compaction_summary) return undefined;
      if ((await sessionStore.getMessageCount(id)) > 0) return undefined;
      const liveBus = workerPool.getBus(id);
      if (liveBus && !liveBus.ended) return undefined;

      const authority = currentProjectAuthority(session);
      const workspaceProjects = assignWorkspaceSlugs(authority?.projects ?? []).map(project => ({
        projectId: project.project_id,
        name: project.name,
        slug: project.slug,
        rootPath: project.root_path,
        isPrimary: project.is_primary,
      }));
      const preflightInput = {
        sessionId: id,
        projectId: authority?.primary.project_id ?? null,
        userMessage: body.content,
        isGlobalWorkspace: session.is_global,
        workspaceProjects,
        activeSkillIds: Array.isArray(
          session.state?.tools?.active_skills,
        )
          ? session.state.tools.active_skills.filter(
              (skill): skill is string => typeof skill === 'string',
            )
          : undefined,
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
          const cached = JSON.parse(session.preflight_seed_json) as {
            h?: string;
            seed?: PreflightSeed;
          };
          if (cached && cached.seed && cached.h === cacheHash) {
            // Seeds cached before tool pins were retired still carry `pinTools`.
            const { pinTools: _retiredPins, ...seed } = cached.seed as PreflightSeed & { pinTools?: unknown };
            await applyGeneratedSessionTitle(id, seed.sessionTitle);
            return seed;
          }
        } catch { /* fall through to clear + recompute */ }
        try {
          await sessionStore.setSessionPreflightSeed(id, null);
        } catch { /* best-effort */ }
      }

      const result = await deps.taskPreflight.run(preflightInput);
      if (result.status === 'unconfigured') return undefined;

      if (result.status === 'ok') {
        await applyGeneratedSessionTitle(id, result.seed?.sessionTitle);
      }

      // Input-tab trail (kind 'preflight') — hint body on success, short
      // diagnostic on failure; meta feeds the effectiveness funnel.
      try {
        await sessionStore.recordSessionInput({
          session_id: id,
          kind: 'preflight',
          source_label: 'turn-start',
          content: result.status === 'ok' && result.seed
            ? renderPreflightHint(result.seed, { bugWorkflow: false })
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
          await sessionStore.setSessionPreflightSeed(
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
    const id = parseSessionIdParam(c);
    const bus = activeRuns.get(id);
    if (!bus) return c.json({ error: 'no active run' }, 404);

    const lastEventId = parseLastEventId(c);
    emitWorkerLog(bus, 'info', 'route', 'GET /attach', {
      last_event_id: lastEventId,
      buffer_size: bus.buffer.length,
    });
    // Perf W2 — a cursorless attach (fresh mount) gets the trimmed replay:
    // cross-turn state + live tail instead of the whole 2000-event ring.
    return pumpBusToSSE(c, bus, { since: lastEventId, trimReplay: true });
  });

  /**
   * Tool-call breakdown for a session — used by the "Tool Stats" modal
   * in the chat header. Single round-trip diagnosis when the user
   * suspects the agent is looping (session 722: 67 update_todo calls
   * dominating 31% of the run). Cap `recent` via query string for
   * heavier debug sessions.
   */
  app.get('/api/coder/sessions/:id/tool-stats', async (c) => {
    const id = parseSessionIdParam(c);
    const session = await sessionStore.getSession(id);
    if (!session) return c.json({ error: 'session not found' }, 404);
    const recentRaw = c.req.query('recent');
    const recent = recentRaw ? Number(recentRaw) : 30;
    const stats = await sessionStore.getToolCallStats(
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
  app.get('/api/coder/sessions/:id/state', async (c) => {
    const id = parseSessionIdParam(c);
    const session = await sessionStore.getSession(id);
    if (!session) return c.json({ error: 'session not found' }, 404);
    const bus = activeRuns.get(id);
    const alive = !!bus && !bus.ended;
    return c.json({
      sessionId: id,
      status: session.status,
      alive,
      hasReplay: !!bus,
      updatedAt: session.updated_at,
    });
  });

  app.get('/api/coder/sessions/:id/events.jsonl', async (c) => {
    const id = parseSessionIdParam(c);
    const context = await getCoderWorkerPool().resolveRuntimeContext(id);
    const events = await getRuntimeEventLog(
      'coder',
      id,
      { bundlePath: context.bundlePath },
    );
    return new Response(runtimeEventsToJsonl(events), {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'content-disposition': `attachment; filename="coder-session-${id}-events.jsonl"`,
      },
    });
  });

  app.get('/api/coder/sessions/:id/events-summary', async (c) => {
    const id = parseSessionIdParam(c);
    const context = await getCoderWorkerPool().resolveRuntimeContext(id);
    return c.json(summarizeRuntimeEvents(await getRuntimeEventLog(
      'coder',
      id,
      { bundlePath: context.bundlePath },
    )));
  });

  app.post('/api/coder/sessions/:id/messages', attachmentBodyLimit, async (c) => {
    const id = parseSessionIdParam(c);
    const body = await c.req.json<SendMessageBody>();
    const replyBus = (bus: CoderRunBus, options?: Parameters<typeof pumpBusToSSE>[2], started = false, messageId?: number) =>
      body.response_mode === 'json'
        ? c.json({ accepted: true, bus_id: bus.busId, active: !bus.ended, started, message_id: messageId,
          ...(bus.ended && bus.endReason ? { terminal: bus.endReason } : {}) })
        : pumpBusToSSE(c, bus, options);
    const replyTerminal = (event: 'done' | 'error', data: Record<string, unknown>) =>
      body.response_mode === 'json'
        ? c.json({ accepted: true, active: false, terminal: { event, data } })
        : syntheticTerminalSSE(c, event, data);
    const attachmentsCheck = validateAttachments(body.attachments, { allowFileReferences: true });
    if (!attachmentsCheck.ok) {
      return c.json(
        { error: attachmentsCheck.error, code: attachmentsCheck.code },
        attachmentsCheck.status,
      );
    }
    body.attachments = attachmentsCheck.value;
    const attachmentReferencePaths = body.attachments
      ?.flatMap((attachment) => attachment.path ? [attachment.path] : [])
      ?? [];
    if (!body.resume && !body.content?.trim() && body.attachments?.length) {
      body.content = DEFAULT_ATTACHMENT_PROMPT;
    }
    // Apêndice 4 Fase 2 — resume-mode skips the content check: the
    // dashboard sends `{resume: true, content: ''}` after an
    // /answer-via-worker fallback, where the tool_result is already in
    // history and there's no new user message to attach.
    if (!body.resume && !body.content?.trim()) return c.json({ error: 'content required' }, 400);
    const resolvedAgent = await resolveRunAgent(id, body.agent);
    const runAgent = resolvedAgent?.baseAgentId;
    const agentSelectionId = resolvedAgent?.selectionId;
    const customAgent = resolvedAgent?.custom;
    // The request keeps precedence for explicit callers. When omitted (for
    // example during a remount race), fall back to the conversation's sticky
    // toggle so the next run cannot silently lose the user's last choice.
    const claimSession = await sessionStore.getSession(id);
    if (!claimSession) return notFound(c);
    const thinking = body.thinking ?? claimSession.thinking_enabled ?? false;
    const blockCodeComments = typeof body.block_code_comments === 'boolean'
      ? body.block_code_comments
      : claimSession.block_code_comments !== false;
    // The filesystem session is authoritative. Keep an explicit request value
    // as a compatibility override for non-dashboard callers, but never inject
    // a hidden default turn ceiling.
    const requestedMaxTurns =
      normalizeSessionMaxTurns(body.max_turns ?? claimSession.max_turns)
      ?? undefined;
    const requestedMaxAutoContinues = normalizeSessionMaxAutoContinues(
      body.max_auto_continues ?? claimSession.max_auto_continues,
    );
    const dedupeKey = normalizeDedupeKey(body.client_msg_id);
    // Log the route hit. The bus may not exist yet (fresh session) —
    // emitWorkerLog no-ops in that case, but if a worker is still alive
    // (attach branch) the dashboard sees the incoming POST live.
    {
      const existing = workerPool.getBus(id);
      emitWorkerLog(existing, 'info', 'route', 'POST /messages', {
        content_preview: body.content?.slice(0, 80) ?? '',
        resume: !!body.resume,
        agent: agentSelectionId ?? runAgent,
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
    // message in the filesystem conversation record.
    const selectedSkillIds = (() => {
      const combined = [...(customAgent?.skillIds ?? []), ...(body.selected_skill_ids ?? [])];
      const unique = [...new Set(combined.map((id) => id.trim()).filter(Boolean))];
      return unique.length > 0 ? unique : undefined;
    })();

    const liveAtClaim = workerPool.getBus(id, true);
    // Command identity cannot depend on mutable transcript state: after the
    // first append, a retry must still resolve the same durable row. Historical
    // first-message `start` rows are handled transactionally as an alias by the
    // control-plane adapter.
    const commandKind = body.resume ? 'resume' as const : 'send_message' as const;
    let earlyClaim = await withSessionLock(id, async () => claimCoderCommand({
      sessionId: id,
      kind: commandKind,
      dedupeKey,
      fingerprint: fingerprintLocalCoderMessage({
        content: body.content,
        attachments: body.attachments,
        resume: body.resume,
        agent: agentSelectionId ?? runAgent,
        profile: body.profile,
        planMode: body.plan_mode,
        maxTurns: requestedMaxTurns,
        selectedSkillIds,
        worktree: body.worktree,
      }),
      // Every new worker execution needs an authority before its prepared
      // configuration can be admitted. Live follow-ups keep the same attempt.
      createRun: !(liveAtClaim && !liveAtClaim.ended),
      linkedAgentRunId: liveAtClaim && !liveAtClaim.ended
        ? workerPool.getControlPlaneRunContext?.(id)?.agentRunId
        : undefined,
      role: runAgent ?? 'explore',
      agentDefinitionId: agentSelectionId ?? runAgent ?? 'explore',
      requestedProvider: claimSession?.provider,
      requestedModel: claimSession?.model,
      requestedReasoningEffort: claimSession?.reasoning_effort_override ?? undefined,
      requestedPreset: agentSelectionId ?? runAgent,
      requestedCapabilityProfile: body.profile ?? claimSession?.tool_profile ?? 'auto',
      lastEventId: parseLastEventId(c),
    }));

    // A duplicate that arrived while the owner was still normalizing/indexing
    // waits outside the session lock. The owner later settles this promise with
    // a bus or explicit terminal, so no request can deadlock the owner's final
    // run/attach decision.
    if (earlyClaim.kind === 'pending') {
      const settled = await earlyClaim.settled;
      if (settled.retryLater) {
        c.header(
          'Retry-After',
          String(Math.max(1, Math.ceil(settled.retryLater.retryAfterMs / 1_000))),
        );
        return c.json({
          error: 'the original request is still being admitted; retry later',
          code: 'IDEMPOTENCY_RETRY_LATER',
          retry_after_ms: settled.retryLater.retryAfterMs,
        }, 503);
      }
      if (settled.terminal) {
        return replyTerminal(settled.terminal.event, settled.terminal.data);
      }
      if (settled.bus && (settled.bus.ended || settled.bus === workerPool.getBus(id))) {
        return replyBus(settled.bus, {
          // The reconnecting client owns the replay cursor. `sinceHint` only
          // describes where the original request attached and must not advance
          // a retry past buffered events it has not acknowledged.
          since: parseLastEventId(c),
          trimReplay: true,
        });
      }
      return replyTerminal('done', { reason: 'completed', duplicate: true });
    }
    if (earlyClaim.kind === 'replay') {
      return replyBus(earlyClaim.bus, { since: earlyClaim.since, trimReplay: true });
    }
    if (earlyClaim.kind === 'terminal') {
      return replyTerminal(earlyClaim.event, earlyClaim.data);
    }
    if (earlyClaim.kind === 'reject') {
      if (earlyClaim.retryAfterMs !== undefined) {
        c.header(
          'Retry-After',
          String(Math.max(1, Math.ceil(earlyClaim.retryAfterMs / 1_000))),
        );
      }
      return c.json(earlyClaim.body, earlyClaim.status);
    }
    const claimAcceptance = earlyClaim.acceptance;
    const claimGuard = earlyClaim.claimGuard;
    let commandSettled = false;
    const settleClaimFailure = async (
      reason: string,
      error?: unknown,
      status: 'failed' | 'cancelled' = 'failed',
    ): Promise<void> => {
      if (commandSettled) return;
      commandSettled = true;
      const details = coderSetupFailure(reason, error);
      await terminalizeLocalCoderCommand(controlPlaneStore, claimAcceptance, {
        status,
        reason: details.reason,
        ...(error
          ? { errorRef: error instanceof Error ? `error:${error.name}` : 'error:unknown' }
          : {}),
      });
      if (dedupeKey) {
        recentMessageKeys.recordTerminal(id, dedupeKey, {
          event: 'error',
          data: { ...details, duplicate: false },
        }, -1, claimGuard);
      }
    };

    try {
    // Always resolve command identity first: an acknowledgement lost after a
    // fresh run started must replay that receipt, not queue the same task again.
    const busyAtAdmission = workerPool.getBus(id, true);
    if (body.only_when_idle && busyAtAdmission && !busyAtAdmission.ended) {
      await settleClaimFailure('run-became-active');
      return c.json({ accepted: false, busy: true, bus_id: busyAtAdmission.busId });
    }
    // Office/OpenDocument files stay native on general file-input transports
    // (OpenAI/Codex/OpenRouter) and use a portable local text extraction path
    // elsewhere. PDFs similarly follow the declarative transport/model
    // capability. Embedded
    // figures are pulled out as image blocks only when the model has vision (or
    // the user forced the vision-fallback), so a blind model doesn't pay surprise
    // describe-image cost. Mutating `body` here prepares the worker request;
    // attachments are first-message-only, so this runs at most once.
    if (body.attachments && body.attachments.length > 0) {
      const extractImages =
        await resolveModelSupportsVision(id) === true || body.describe_images === true;
      const fileHandling = await resolveFileHandling(id);
      const extractPdfText = !pdfHandledNatively(fileHandling);
      body.attachments = await normalizeAttachmentsForModel(body.attachments, {
        extractImages,
        extractPdfText,
        keepBinaryDocuments: binaryDocumentsHandledNatively(fileHandling),
      });
    }

    // Structural auto-index. Only the FIRST turn claims the project lifecycle;
    // later turns rely on watcher/Monaco deltas and never schedule another
    // full reconciliation. Indexing is deliberately fire-and-forget: a missing
    // baseline starts the runner in degraded retrieval mode, where disk/FTS
    // fallbacks remain usable, and live readiness promotes the same runner once
    // the structural baseline becomes available.
    {
      const session = await sessionStore.getSession(id);
      if (session) {
        const projectIds = currentProjectAuthority(session)?.projects.map(
          (project) => project.project_id,
        ) ?? [];
        const freshSession = !body.resume
          && !session.compaction_summary
          && (await sessionStore.getMessageCount(id)) === 0;
        if (freshSession && projectIds.length > 0) {
          for (const projectId of projectIds) {
            deps.projectIndexService.ensureFresh(projectId, 'session');
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
      const current = await sessionStore.getSession(id);
      if (titleSeed && current && isAutomaticSessionTitle(current.title)) {
        scheduleGeneratedSessionTitle(id, titleSeed);
      }
    }

    // Serialize the "do we have an active run?" decision per session so two
    // concurrent POSTs cannot both create a worker run. Inside the lock we either:
    //   (a) attach to the live run by enqueueing the message + tailing the
    //       existing bus, or
    //   (b) ask the mandatory worker pool to start a run and tail its bus.
    // The lock is released as soon as the synchronous setup completes — the
    // SSE stream itself is not held under the lock.
    const decide = async (): Promise<
      | { kind: 'attach'; bus: CoderRunBus; tailFrom: number; messageId: number }
      | { kind: 'fresh'; bus: CoderRunBus }
      | { kind: 'busy'; bus: CoderRunBus }
      | { kind: 'reject'; status: 409; body: { error: string; code: string } }
    > => {
      // Coder sessions are workers-only. Synchronous runner pokes
      // (`isWaitingForInput`, `pushUserMessage`, `interruptWait`) are RPCs;
      // no request is allowed to fall back onto the Electron/backend loop.
      const pool = workerPool;
      const existingBus = pool.getBus(id, true);
      if (existingBus && !existingBus.ended) {
        if (body.only_when_idle) return { kind: 'busy', bus: existingBus };
        if (
          claimAcceptance?.commandContext
          && !(await bindLocalCommandBus(controlPlaneStore, claimAcceptance, existingBus.busId))
        ) {
          await settleClaimFailure('command-bus-binding-failed');
          throw new Error('failed to bind command to the live coder bus');
        }
        const referenceError = await authorizeAttachmentReferences(id, attachmentReferencePaths, false);
        if (referenceError) {
          return {
            kind: 'reject',
            status: 409,
            body: { error: referenceError, code: 'ATTACHMENT_REFERENCE_NOT_AUTHORIZED' },
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
        }
        try {
          const messageOperationId = claimAcceptance?.commandContext
            ? `message-command:${claimAcceptance.commandContext.commandId}`
            : dedupeKey
              ? `message-client:${dedupeKey}`
              : undefined;
          const messageId = await pool.pushUserMessage(
            id,
            body.content,
            selectedSkillIds,
            messageOperationId,
            ...(body.attachments?.length ? [body.attachments] as const : []),
          );
          // The message must be persisted and queued before waking ask_user /
          // submit_plan; otherwise a quick final turn can finish without it.
          if (waiting && body.interject) await pool.interruptWait(id);
          await terminalizeLocalCoderCommand(controlPlaneStore, claimAcceptance, {
            status: 'succeeded',
            reason: 'message-enqueued',
          });
          commandSettled = true;
          return { kind: 'attach', bus: existingBus, tailFrom: existingBus.nextSeq - 1, messageId };
        } catch (error) {
          await settleClaimFailure('message-enqueue-failed', error);
          throw error;
        }
      }
      // `runFresh` spawns the worker if needed and returns the main-side
      // mirrored bus. All model-facing options are forwarded unchanged.
      const referenceError = await authorizeAttachmentReferences(
        id,
        attachmentReferencePaths,
        body.worktree != null,
      );
      if (referenceError) {
        return {
          kind: 'reject',
          status: 409,
          body: { error: referenceError, code: 'ATTACHMENT_REFERENCE_NOT_AUTHORIZED' },
        };
      }
      const freshBus = await pool.runFresh(id, {
        userMessage: body.content,
        attachments: body.attachments,
        maxTurns: requestedMaxTurns,
        maxAutoContinues: requestedMaxAutoContinues,
        planMode: body.plan_mode,
        agent: runAgent,
        agentSelectionId,
        customAgentPrompt: customAgent?.prompt,
        allowedToolNames: customAgent?.toolNames ?? undefined,
        initialPinnedTools: customAgent?.pinnedToolNames,
        initialToolTiers: customAgent?.requiredToolTiers,
        initialVisibleToolCap: customAgent?.visibleToolCap ?? undefined,
        profile: body.profile,
        worktree: body.worktree,
        thinking,
        modelSupportsVision: await resolveModelSupportsVision(id),
        describeImages: body.describe_images,
        blockCodeComments,
        previewAvailable: await resolvePreviewAvailable(id),
        browserAvailable: resolveBrowserAvailable(),
        selectedSkillIds,
        ideContext: body.ide_context,
        preflight,
        ...deps.buildAgentDecisionRuntimeOptions(),
        // When the dashboard resumes, the synthetic tool_result is already
        // in history. runCoder({resume:true}) picks up from there
        // without pushing a new user turn.
        resume: body.resume,
        controlPlaneRunContext: claimAcceptance?.runContext,
      });
      if (
        claimAcceptance?.commandContext
        && !(await bindLocalCommandBus(controlPlaneStore, claimAcceptance, freshBus.busId))
      ) {
        freshBus.ctrl.abort(new Error('command-bus-binding-failed'));
        await settleClaimFailure('command-bus-binding-failed');
        throw new Error('failed to bind command to the fresh coder bus');
      }
      bindFreshCommandCompletion(id, dedupeKey, claimAcceptance, freshBus, claimGuard);
      commandSettled = true;
      return { kind: 'fresh', bus: freshBus };
    };

    const decision = await withSessionLock(id, async (): Promise<Awaited<ReturnType<typeof decide>>> => {
      const d = await decide();
      // Settle the pre-side-effect claim while still inside the lock. A retry
      // has either been waiting on this settlement or will observe the ready
      // bus; it never re-enters append/push/spawn.
      if (dedupeKey && (d.kind === 'attach' || d.kind === 'fresh')) {
        recentMessageKeys.record(
          id,
          dedupeKey,
          d.bus,
          d.kind === 'attach' ? d.tailFrom : -1,
          claimGuard,
        );
      }
      return d;
    });

    if (decision.kind === 'reject') {
      await settleClaimFailure(decision.body.code.toLowerCase());
      return c.json(decision.body, decision.status);
    }
    if (decision.kind === 'busy') {
      await settleClaimFailure('run-became-active');
      return c.json({ accepted: false, busy: true, bus_id: decision.bus.busId });
    }
    if (decision.kind === 'attach') {
      keepSemanticProjectAlive(id, decision.bus);
      return replyBus(decision.bus, {
        since: decision.tailFrom,
        trimReplay: true,
      }, false, decision.messageId);
    }

    await keepSemanticProjectAlive(id, decision.bus);

    // `runFresh()` already started `runCoder()` inside the worker. The route
    // only mirrors its bus to SSE; there is deliberately no in-process path.
    return replyBus(decision.bus, undefined, true);
    } catch (error) {
      if (isCoderStartupUncertainError(error)) {
        const pendingBus = workerPool.getBus(id);
        if (dedupeKey && pendingBus) recentMessageKeys.record(id, dedupeKey, pendingBus, -1, claimGuard);
        return c.json({ error: error.message, code: error.code, retryable: false }, 503);
      }
      await settleClaimFailure('request-setup-failed', error);
      const details = coderSetupFailure('request-setup-failed', error);
      if (details.not_started) return replyTerminal('error', { ...details, duplicate: false });
      if (isUncertainToolOutcomeError(error) || isWorkspaceRuntimeConflict(error)) return c.json({ error: error.message, code: error.code, retryable: false }, 409);
      throw error;
    }
  });

  /**
   * Continue a session that was paused on a pending plan/question after the
   * dashboard answered it via /plan-response or /answer with `{resumed:true}`.
   * Mirrors POST /messages but calls runCoder with `resume: true` so no new
   * user message is pushed — the runner picks up from history (which now ends
   * with the just-appended tool_result) and runs the next turn.
   */
  app.post('/api/coder/sessions/:id/continue', async (c) => {
    const id = parseSessionIdParam(c);
    let body: ContinueBody = {};
    try {
      body = await c.req.json();
    } catch {
      /* empty body is fine */
    }

    const data = await sessionStore.loadSessionWithMessages(id);
    if (!data) return notFound(c);
    // Bootstrap restores unresolved outcomes as recovery restrictions. Refusing
    // here made even an explicit Continue permanently unable to inspect them.
    const last = data.messages[data.messages.length - 1];
    if (!last || last.role !== 'tool') {
      return c.json({ error: 'session not in resumable state' }, 409);
    }
    const resolvedAgent = await resolveRunAgent(id, body.agent);
    const runAgent = resolvedAgent?.baseAgentId;
    const agentSelectionId = resolvedAgent?.selectionId;
    const customAgent = resolvedAgent?.custom;
    const dedupeKey = normalizeDedupeKey(body.client_msg_id);
    // Pre-spawn log: bus is about to be created below. We can't emit
    // here because no bus exists yet — but the route-entry hit will
    // appear via the fresh bus's `run_started` event seq=0.

    const continueSession = await sessionStore.getSession(id);
    if (!continueSession) return notFound(c);
    const continueMaxTurns =
      normalizeSessionMaxTurns(body.max_turns ?? continueSession.max_turns)
      ?? undefined;
    const continueMaxAutoContinues = normalizeSessionMaxAutoContinues(
      body.max_auto_continues ?? continueSession.max_auto_continues,
    );
    const liveAtContinueClaim = workerPool.getBus(id, true);
    const continueEarlyClaim = await withSessionLock(id, async () => claimCoderCommand({
      sessionId: id,
      kind: 'resume',
      dedupeKey,
      fingerprint: fingerprintLocalCoderMessage({
        content: '',
        resume: true,
        agent: agentSelectionId ?? runAgent,
        profile: body.profile,
        planMode: body.plan_mode,
        maxTurns: continueMaxTurns,
      }),
      createRun: !(liveAtContinueClaim && !liveAtContinueClaim.ended),
      linkedAgentRunId: liveAtContinueClaim && !liveAtContinueClaim.ended
        ? workerPool.getControlPlaneRunContext?.(id)?.agentRunId
        : undefined,
      role: runAgent ?? 'explore',
      agentDefinitionId: agentSelectionId ?? runAgent ?? 'explore',
      requestedProvider: continueSession?.provider,
      requestedModel: continueSession?.model,
      requestedReasoningEffort: continueSession?.reasoning_effort_override ?? undefined,
      requestedPreset: agentSelectionId ?? runAgent,
      requestedCapabilityProfile: body.profile ?? continueSession?.tool_profile ?? 'auto',
      lastEventId: parseLastEventId(c),
    }));

    if (continueEarlyClaim.kind === 'pending') {
      const settled = await continueEarlyClaim.settled;
      if (settled.retryLater) {
        c.header(
          'Retry-After',
          String(Math.max(1, Math.ceil(settled.retryLater.retryAfterMs / 1_000))),
        );
        return c.json({
          error: 'the original request is still being admitted; retry later',
          code: 'IDEMPOTENCY_RETRY_LATER',
          retry_after_ms: settled.retryLater.retryAfterMs,
        }, 503);
      }
      if (settled.terminal) {
        return syntheticTerminalSSE(c, settled.terminal.event, settled.terminal.data);
      }
      if (settled.bus && (settled.bus.ended || settled.bus === workerPool.getBus(id))) {
        return pumpBusToSSE(c, settled.bus, {
          since: parseLastEventId(c),
          trimReplay: true,
        });
      }
      return syntheticDoneSSE(c, { reason: 'completed', duplicate: true });
    }
    if (continueEarlyClaim.kind === 'replay') {
      return pumpBusToSSE(c, continueEarlyClaim.bus, {
        since: continueEarlyClaim.since,
        trimReplay: true,
      });
    }
    if (continueEarlyClaim.kind === 'terminal') {
      return syntheticTerminalSSE(c, continueEarlyClaim.event, continueEarlyClaim.data);
    }
    if (continueEarlyClaim.kind === 'reject') {
      if (continueEarlyClaim.retryAfterMs !== undefined) {
        c.header(
          'Retry-After',
          String(Math.max(1, Math.ceil(continueEarlyClaim.retryAfterMs / 1_000))),
        );
      }
      return c.json(continueEarlyClaim.body, continueEarlyClaim.status);
    }
    const continueAcceptance = continueEarlyClaim.acceptance;
    const continueClaimGuard = continueEarlyClaim.claimGuard;
    let continueSettled = false;
    const settleContinueFailure = async (
      reason: string,
      error?: unknown,
    ): Promise<void> => {
      if (continueSettled) return;
      continueSettled = true;
      const details = coderSetupFailure(reason, error);
      await terminalizeLocalCoderCommand(controlPlaneStore, continueAcceptance, {
        status: 'failed',
        reason: details.reason,
        ...(error
          ? { errorRef: error instanceof Error ? `error:${error.name}` : 'error:unknown' }
          : {}),
      });
      if (dedupeKey) {
        recentMessageKeys.recordTerminal(id, dedupeKey, {
          event: 'error',
          data: { ...details, duplicate: false },
        }, -1, continueClaimGuard);
      }
    };

    // Take the lock so a /continue racing with a /messages can't both spin
    // up runCoder for the same session. We hold it only across the
    // synchronous setup; the SSE pump runs outside the lock.
    let decision:
      | { kind: 'attach'; bus: CoderRunBus; tailFrom: number }
      | { kind: 'fresh'; bus: CoderRunBus };
    try {
      decision = await withSessionLock(id, async () => {
        // A live run already owns this session. Tail it rather than replacing
        // activeRuns; the early command claim is terminalized as attached.
        const live = workerPool.getBus(id, true);
        if (live && !live.ended) {
          const tailFrom = live.nextSeq - 1;
          if (
            continueAcceptance?.commandContext
            && !(await bindLocalCommandBus(controlPlaneStore, continueAcceptance, live.busId))
          ) {
            await settleContinueFailure('command-bus-binding-failed');
            throw new Error('failed to bind continue command to the live coder bus');
          }
          await terminalizeLocalCoderCommand(controlPlaneStore, continueAcceptance, {
            status: 'succeeded',
            reason: 'attached-to-live-run',
          });
          continueSettled = true;
          if (dedupeKey) {
            recentMessageKeys.record(id, dedupeKey, live, tailFrom, continueClaimGuard);
          }
          return { kind: 'attach' as const, bus: live, tailFrom };
        }

        const newBus = await workerPool.runFresh(id, {
          userMessage: '',
          maxTurns: continueMaxTurns,
          maxAutoContinues: continueMaxAutoContinues,
          planMode: body.plan_mode,
          agent: runAgent,
          agentSelectionId,
          customAgentPrompt: customAgent?.prompt,
          allowedToolNames: customAgent?.toolNames ?? undefined,
          initialPinnedTools: customAgent?.pinnedToolNames,
          initialToolTiers: customAgent?.requiredToolTiers,
          initialVisibleToolCap: customAgent?.visibleToolCap ?? undefined,
          profile: body.profile,
          resume: true,
          modelSupportsVision: await resolveModelSupportsVision(id),
          describeImages: body.describe_images,
          previewAvailable: await resolvePreviewAvailable(id),
          browserAvailable: resolveBrowserAvailable(),
          ...deps.buildAgentDecisionRuntimeOptions(),
          controlPlaneRunContext: continueAcceptance?.runContext,
        });
        if (
          continueAcceptance?.commandContext
          && !(await bindLocalCommandBus(controlPlaneStore, continueAcceptance, newBus.busId))
        ) {
          newBus.ctrl.abort(new Error('command-bus-binding-failed'));
          await settleContinueFailure('command-bus-binding-failed');
          throw new Error('failed to bind continue command to the fresh coder bus');
        }
        bindFreshCommandCompletion(
          id,
          dedupeKey,
          continueAcceptance,
          newBus,
          continueClaimGuard,
        );
        continueSettled = true;
        if (dedupeKey) {
          recentMessageKeys.record(id, dedupeKey, newBus, -1, continueClaimGuard);
        }
        return { kind: 'fresh' as const, bus: newBus };
      });
    } catch (error) {
      if (isCoderStartupUncertainError(error)) {
        const pendingBus = workerPool.getBus(id);
        if (dedupeKey && pendingBus) recentMessageKeys.record(id, dedupeKey, pendingBus, -1, continueClaimGuard);
        return c.json({ error: error.message, code: error.code, retryable: false }, 503);
      }
      await settleContinueFailure('continue-setup-failed', error);
      const details = coderSetupFailure('continue-setup-failed', error);
      if (details.not_started) return syntheticTerminalSSE(c, 'error', { ...details, duplicate: false });
      if (isUncertainToolOutcomeError(error) || isWorkspaceRuntimeConflict(error)) return c.json({ error: error.message, code: error.code, retryable: false }, 409);
      throw error;
    }

    if (decision.kind === 'attach') {
      emitWorkerLog(decision.bus, 'warn', 'route', 'POST /continue attached to live run', {
        client_msg_id: dedupeKey ?? null,
      });
      await keepSemanticProjectAlive(id, decision.bus);
      return pumpBusToSSE(c, decision.bus, { since: decision.tailFrom, trimReplay: true });
    }

    const bus = decision.bus;
    await keepSemanticProjectAlive(id, bus);
    // Log the route hit on the fresh bus — the dashboard will see the
    // POST /continue entry seq=0 with the resume context.
    emitWorkerLog(bus, 'info', 'route', 'POST /continue', {
      agent: agentSelectionId ?? runAgent,
      requested_agent: body.agent ?? null,
      profile: body.profile,
      plan_mode: body.plan_mode,
      max_turns: continueMaxTurns ?? null,
    });

    // The resume request is already executing in the mandatory worker.
    return pumpBusToSSE(c, bus);
  });
}
