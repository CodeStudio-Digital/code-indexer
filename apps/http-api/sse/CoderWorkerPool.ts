/**
 * Pool of worker-backed coder runs (P17).
 *
 * Mirrors `WorkerOrchestratorPool` for the simpler coder path. Each
 * active filesystem session maps to a `WorkerHost` running
 * `apps/http-api/workers/coder-worker.ts`. The worker hosts the
 * actual `runCoder()` call and its runner; main holds a mirrored
 * `CoderRunBus` populated by worker events.
 *
 * Public surface:
 *
 *   - `getBus(id)` — returns the mirrored bus for an already-spawned
 *     session, or `null`. Compatible with `activeRuns.get(id)` reads
 *     in `coder/stream.ts` etc.
 *   - `runFresh(id, opts)` — spawns a worker (if needed) and starts
 *     a brand-new `runCoder()` invocation inside it.
 *   - `sendUserMessage(id, content)` — pushes a follow-up message to
 *     the worker's runner. Handles the is-waiting / interject
 *     decision tree on the worker side via a single RPC.
 *   - `isWaitingForInput(id)` — proxy read of the worker runner's waiting flag.
 *   - `interruptWait(id)`, `abort(id)` — runner control proxies.
 *
 * The pool is the only owner of coder runners. Routes may use the compatibility
 * `runtime.activeRuns` facade, but that facade delegates exclusively here.
 */
import { WorkerHost } from '@mcp/orchestrator-host';
import {
  createBus,
  publish,
  markEnded,
  emitWorkerLog,
  type CoderRunBus,
} from '../coder-bus.js';
import type { CoderAttachment } from '@mcp/code-agent/index.js';
import type { AgentId } from '@mcp/code-agent/agents/index.js';
import type { DocSearchBackend } from '@mcp/code-agent/tools/rag-search-docs.js';
import { getGlobalPreviewDevtools, type PreviewInvoke } from '@mcp/code-agent/tools/preview/index.js';
import { getGlobalResearchBrowser, type ResearchBrowserInvoke } from '@mcp/code-agent/tools/browser/index.js';
import { closePreviewWindow, closePreviewSession } from './closeCoderPreview.js';
import { notifyBuilderRunEnded } from './builder-checkpoint.js';
import type { IVisionDescriber, VisionDescribeRequest } from '@mcp/code-agent/core/vision-describer.js';
import type { ISpriteStudioHost } from '@mcp/code-agent/tools/sprite-studio/index.js';
import type { DocsResearchBridge } from '@mcp/docs-agent/bridges/docs-bridge.js';
import type { CompanyRecommendFn } from '@mcp/company/services/scheduler/recommend-shim.js';
import type { McpExternalPool } from './McpExternalPool.js';
import { installRuntimeEventLog } from './runtime-event-log.js';
import { registerWorkerMemoryHandlers, type WorkerMemoryDeps } from './worker-memory-handlers.js';
import { registerWorkerSecretsHandlers } from './worker-secrets-handlers.js';
import { registerWorkerLspHandlers } from './worker-lsp-handlers.js';
import {
  enterBackgroundActivity,
  exitBackgroundActivity,
} from '../server/perf/freeze-log.js';
import { noteSyncLeaf } from '../server/perf/stall-evidence.js';
import { registerDocsResearchRpcHandlers } from '../workers/docs-research-rpc.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  classifyCoderTerminalOutcome,
  normalizeCoderTerminalSignal,
  type ControlPlaneEventType,
} from '@mcp/agent-runtime-contracts';
import {
  releaseSessionWriterLeaseForOwner,
  type ProjectId,
  type SessionId,
} from '@mcp/session-storage';
import {
  compareRunTerminalState,
  type ControlPlaneRunContext,
} from '@mcp/store/control-plane/index.js';
import type { ControlPlaneAuthority } from '../file-control-plane-store.js';
import {
  coderControlPlaneShadowEnabled,
  markLocalCoderRunStarted,
  mirrorLocalCoderLifecycleEvent,
  mirrorLocalCoderToolBoundary,
  recordLocalCoderShadowDivergences,
  renewLocalCoderRunLease,
  terminalizeLocalCoderRun,
} from '../control-plane-shadow.js';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const strOrNull = (value: unknown): string | null => typeof value === 'string' ? value : null;
const numOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const strOrUndef = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const hashOrNull = (value: unknown): string | null => strOrUndef(value) ? sha256Hex(value as string) : null;

interface LifecycleMirror {
  type: ControlPlaneEventType;
  payload: (data: Record<string, unknown>) => Record<string, unknown>;
  idempotencyKey?: (data: Record<string, unknown>) => string | undefined;
}

/**
 * Extended A–C runner vocabulary mirrored to the journal shadow (Fase 1C).
 * Every payload is reduced to ids, hashes and counts — never raw text.
 */
const LIFECYCLE_MIRRORS: Record<string, LifecycleMirror> = {
  tool_approval_request: {
    type: 'tool.approval.requested',
    idempotencyKey: (d) => strOrUndef(d.toolUseId),
    payload: (d) => ({
      toolUseId: strOrNull(d.toolUseId),
      parentToolUseId: strOrNull(d.parentToolUseId),
      toolName: strOrNull(d.toolName),
      riskClass: strOrNull(d.riskClass),
      approvalKind: strOrNull(d.approvalKind),
      turn: numOrNull(d.turn),
      nested: d.nested === true,
    }),
  },
  tool_approval_resolved: {
    type: 'tool.approval.resolved',
    idempotencyKey: (d) => strOrUndef(d.toolUseId),
    payload: (d) => ({
      toolUseId: strOrNull(d.toolUseId),
      toolName: strOrNull(d.toolName),
      approved: d.approved === true,
      source: strOrNull(d.source),
    }),
  },
  awaiting_input: {
    type: 'interaction.requested',
    idempotencyKey: (d) => strOrUndef(d.askId),
    payload: (d) => ({ askId: strOrNull(d.askId) }),
  },
  provider_swapped: {
    type: 'provider.swapped',
    payload: (d) => ({ provider: strOrNull(d.provider), model: strOrNull(d.model) }),
  },
  fallback_activated: {
    type: 'provider.fallback',
    payload: (d) => {
      const from = d.from && typeof d.from === 'object' ? d.from as Record<string, unknown> : {};
      const to = d.to && typeof d.to === 'object' ? d.to as Record<string, unknown> : {};
      return {
        fromProvider: strOrNull(from.provider),
        fromModel: strOrNull(from.model),
        toProvider: strOrNull(to.provider),
        toModel: strOrNull(to.model),
        errorHash: hashOrNull(d.error),
      };
    },
  },
  history_compacted: {
    type: 'history.compacted',
    payload: (d) => ({
      strategy: strOrNull(d.strategy),
      prunedMessages: numOrNull(d.pruned_messages),
      prunedChars: numOrNull(d.pruned_chars),
      totalCharsBefore: numOrNull(d.total_chars_before),
      totalCharsAfter: numOrNull(d.total_chars_after),
      autoContinue: numOrNull(d.auto_continue),
      trigger: strOrNull(d.trigger),
    }),
  },
  workflow_run_started: {
    type: 'workflow.run.started',
    idempotencyKey: (d) => `${strOrNull(d.workflow_id) ?? 'unknown'}:started`,
    payload: (d) => ({
      workflowId: strOrNull(d.workflow_id),
      name: strOrNull(d.name),
      resumed: d.resumed === true,
      totalWaves: numOrNull(d.total_waves),
      stepCount: Array.isArray(d.steps) ? d.steps.length : null,
    }),
  },
  workflow_run_finished: {
    type: 'workflow.run.finished',
    idempotencyKey: (d) => `${strOrNull(d.workflow_id) ?? 'unknown'}:finished`,
    payload: (d) => ({
      workflowId: strOrNull(d.workflow_id),
      status: strOrNull(d.status),
      completedCount: numOrNull(d.completed_count),
      failedCount: numOrNull(d.failed_count),
      skippedCount: numOrNull(d.skipped_count),
    }),
  },
  agents_group_start: {
    type: 'agents.group.started',
    idempotencyKey: (d) => `${strOrNull(d.groupId) ?? 'unknown'}:started`,
    payload: (d) => ({
      groupId: strOrNull(d.groupId),
      toolUseId: strOrNull(d.toolUseId),
      provider: strOrNull(d.provider),
      model: strOrNull(d.model),
      background: d.background === true,
      resumed: d.resumed === true,
      agentCount: Array.isArray(d.agents) ? d.agents.length : null,
    }),
  },
  agents_group_end: {
    type: 'agents.group.finished',
    idempotencyKey: (d) => `${strOrNull(d.groupId) ?? 'unknown'}:finished`,
    payload: (d) => ({
      groupId: strOrNull(d.groupId),
      status: strOrNull(d.status),
      agentCount: numOrNull(d.agentCount),
      successCount: numOrNull(d.successCount),
      completedCount: numOrNull(d.completedCount),
      partialCount: numOrNull(d.partialCount),
      failedCount: numOrNull(d.failedCount),
      resumableCount: numOrNull(d.resumableCount),
    }),
  },
  worktree_entered: {
    type: 'worktree.entered',
    idempotencyKey: (d) => `${strOrUndef(d.path) ? sha256Hex(d.path as string) : 'unknown'}:entered`,
    payload: (d) => ({
      pathHash: hashOrNull(d.path),
      originalCwdHash: hashOrNull(d.originalCwd),
    }),
  },
  worktree_exited: {
    type: 'worktree.exited',
    idempotencyKey: (d) => `${strOrUndef(d.path) ? sha256Hex(d.path as string) : 'unknown'}:exited`,
    payload: (d) => ({ pathHash: hashOrNull(d.path) }),
  },
};

function mirrorBusLifecycleEvent(
  store: ControlPlaneAuthority | null,
  context: ControlPlaneRunContext,
  event: string,
  data: unknown,
): void {
  const mirror = LIFECYCLE_MIRRORS[event];
  if (!mirror) return;
  const record = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
  void mirrorLocalCoderLifecycleEvent(store, context, {
    type: mirror.type,
    idempotencyKey: mirror.idempotencyKey?.(record),
    payload: mirror.payload(record),
  });
}

/**
 * Optional doc-corpus deps the host wires AFTER `boot/createApp` has built
 * `DocHybridSearch` + `DocsResearchBridge`. The pool holds them in a mutable
 * box because the main-process server.ts can't construct them before
 * `getCoderWorkerPool` runs (the singleton resolves lazily on the first
 * runFresh request, by which point the deps are ready).
 *
 * When set, each `ensureEntry()` call wires the short navigation reads and
 * `docs_deep_research` back to these main-thread singletons via MessageBridge
 * RPC. `rag_search_docs` itself stays worker-local so provider latency cannot
 * block the Electron host. Worker-side shims live in coder-worker.ts.
 *
 * Both fields stay nullable so headless tests / detached runners can
 * spawn the pool without docs support — the worker shim degrades to
 * the same "not configured" message the in-process path already used to
 * emit when `setGlobalDocSearch(null)` was active.
 */
export interface CoderWorkerDocDeps extends WorkerMemoryDeps {
  docSearch?: DocSearchBackend | null;
  docsResearch?: DocsResearchBridge | null;
  /** Main-side vision describer; worker reaches it via `visionDescribe` RPC. */
  vision?: IVisionDescriber | null;
  /** Main-side Sprite Studio host; worker reaches it via `spriteStudioHost.<method>` RPC. */
  spriteStudioHost?: ISpriteStudioHost | null;
  /**
   * Main-side role recommender (embedding-backed). The company worker reaches
   * it via the `recommend` RPC so the autonomous CompanyScheduler can resolve
   * a role per card. Company-only — the coder pool ignores it.
   */
  recommend?: CompanyRecommendFn | null;
  // memoryRetriever / runEndMemory (Mem C) inherited from WorkerMemoryDeps —
  // same mutable-box wiring, handlers in worker-memory-handlers.ts.
}

export interface CoderWorkerPoolOpts {
  /** Absolute path Node spawns — built `.js` in prod, dev bootstrap `.mjs` in dev. */
  workerFile: string;
  /** Extra execArgv (reserved). */
  workerExecArgv?: string[];
  /** Old-generation heap ceiling for each coder isolate. Default 1024 MB. */
  workerMaxOldGenerationSizeMb?: number;
  /** Dev-mode TS entry the bootstrap dynamic-imports. */
  workerDevTsEntry?: string;
  /** SQLite path passed to each worker for essential shared catalogs only. */
  dbPath: string;
  /**
   * Filesystem-session authority. The pool must resolve the bundle before it
   * spawns a worker; a missing resolver/session/root is a hard error and never
   * falls back to a central database.
   */
  resolveSessionRuntimeContext?: (
    sessionId: SessionId,
  ) => Promise<SessionRuntimeContext>;
  /**
   * Transfers the bundle's single-writer authority to the worker before its
   * isolate starts. The main-process repository may have opened the writer
   * while preparing the run; that lease must be fully released first.
   */
  handoffSessionWriter?: (
    context: SessionRuntimeContext,
  ) => Promise<void>;
  /** Idle TTL before eviction. Default 5 min — only used between runs. */
  ttlMs?: number;
  /**
   * Linger window after a run finishes (bus emits `done`/`error`). The
   * pool waits this long for a follow-up turn before evicting the
   * worker. Mirrors the legacy in-process `BUS_LINGER_MS` so a fast
   * `/messages` POST right after `done` still reuses the same worker
   * (no cold-start cost). Default 30 s.
   */
  postRunLingerMs?: number;
  /** Logger. */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /**
   * Mutable doc-deps box. Mutated by the singleton wire-up
   * (`setCoderWorkerDocDeps` in `coderWorkerPoolSingleton.ts`); the pool
   * reads each field at ensureEntry-time so a deps update propagates
   * to the NEXT worker spawned.
   */
  docDeps?: CoderWorkerDocDeps;
  /**
   * Optional getter for the shared external-MCP pool. We use a getter
   * (instead of a direct reference) so server.ts can spawn the pool
   * asynchronously AFTER the dashboard starts serving requests, and
   * the very first worker spawned still picks up the pool once it's
   * ready. Returning `null` keeps the legacy per-worker
   * `McpServerManager` path alive (covers boot-race + tests).
   */
  getMcpExternalPool?: () => McpExternalPool | null;
  /**
   * Late-bound main-thread control-plane store. Command authority is always
   * wired; AgentRun/journal writes still require an accepted run context and
   * their respective feature flags.
   */
  getControlPlaneStore?: () => ControlPlaneAuthority | null;
}

export interface SessionRuntimeContext {
  sessionId: SessionId;
  projectId: ProjectId | null;
  projectRoot: string | null;
  bundlePath: string;
  /** Pool-minted identity copied into this worker isolate's lease. */
  writerOwnerId?: string;
}

interface PoolEntry {
  host: WorkerHost;
  bus: CoderRunBus;
  sessionContext: SessionRuntimeContext;
  currentRunId: number;
  lastTouchedAt: number;
  detachCurrentBusRuntimeLog: () => void;
  detachBusMirror: () => void;
  /**
   * Scheduled fast-eviction handle, set when `bus.end` arrives. Cleared
   * on the next `runFresh` / `pushUserMessage` so a re-engaged session
   * doesn't get evicted out from under the user.
   */
  postRunEvictTimer: ReturnType<typeof setTimeout> | null;
  /**
   * True while a `runCoder()` is in flight (between `runFresh` /
   * `pushUserMessage` and the next `bus.end`). The idle sweep MUST NOT
   * evict entries with `runInProgress=true` — a slow provider (6+ min
   * on a fat prompt; session 798 symptom) makes the worker look idle
   * to the sweep even though it is actively doing real work.
   *
   * Separate from `bus.ended` because the bus object is swapped between
   * sequential runs while the worker stays warm.
   */
  runInProgress: boolean;
  controlPlaneRunContext: ControlPlaneRunContext | null;
  /**
   * Root AgentRun authority is leased for ten minutes. Renewal must be driven
   * by an owner-scoped timer rather than bus traffic: a provider/tool may be
   * legitimately silent for longer than the lease. The callback additionally
   * checks this entry + currentRunId + executor owner/fence before every write.
   */
  controlPlaneLeaseRenewTimer: ReturnType<typeof setInterval> | null;
}

export interface RunFreshOpts {
  userMessage: string;
  attachments?: CoderAttachment[];
  maxTurns?: number;
  planMode?: boolean;
  agent?: AgentId;
  /** Sticky picker id. Differs from `agent` when a custom agent inherits a built-in preset. */
  agentSelectionId?: string;
  /** User-authored prompt appended as a cache-stable system section. */
  customAgentPrompt?: string;
  /** Exact custom-agent tool allowlist. Undefined inherits the preset/profile catalog. */
  allowedToolNames?: string[];
  profile?: 'bootstrap' | 'navigate' | 'full' | 'auto';
  /** POJO worktree opts — survives structuredClone across MessagePort. */
  worktree?: { name?: string; branch?: string };
  thinking?: boolean;
  /** Vision fallback — `modelSupportsVision === false` triggers auto image→text
   *  describe; `describeImages` (composer flag) forces it. Forwarded to runCoder. */
  modelSupportsVision?: boolean;
  describeImages?: boolean;
  /** Auto-activate the `preview` DevTools tier (builder/dev-server sessions). */
  previewAvailable?: boolean;
  /** Auto-activate the isolated public-web tier for the research preset. */
  browserAvailable?: boolean;
  /** Skill IDs the user pre-selected in the sidebar; forwarded to runCoder. */
  selectedSkillIds?: string[];
  /**
   * Structured IDE context (active file / selections / open tabs) — POJO,
   * survives structuredClone across the MessagePort. Forwarded to runCoder.
   */
  ideContext?: import('@mcp/code-agent/core/ide-context.js').IdeContext;
  /**
   * Task-preflight seed (fresh sessions) — POJO, survives structuredClone
   * across the MessagePort. Forwarded verbatim to `runCoder({ preflight })`.
   */
  preflight?: import('@mcp/code-agent/index.js').PreflightSeed;
  /** Default-off Agent Decision Engine runtime flags forwarded to runCoder. */
  agentDecisionTelemetryEnabled?: boolean;
  agentDecisionGuidanceEnabled?: boolean;
  agentDecisionSoftGuardrail?: boolean;
  agentDecisionSoftGuardrailMinConfidence?: number;
  agentDecisionAskBeforeSwitch?: boolean;
  /**
   * When true, the worker calls `runCoder({ resume: true })` so the runner
   * picks up from history (last DB message must be `role:'tool'`) instead
   * of pushing a brand-new user turn. Used by the Apêndice 4 Fase 2
   * interaction fallback when a previous worker died mid-wait — the
   * dashboard POSTs `/messages` with `{ resume: true, content: '' }` to
   * spawn a fresh worker that resumes from the tool_result just appended.
   */
  resume?: boolean;
  /**
   * Main-process-only AgentRun authority context; stripped before the worker
   * RPC. Only its opaque agentRunId is forwarded, never actor/owner/fencing
   * credentials.
   */
  controlPlaneRunContext?: ControlPlaneRunContext;
}

/**
 * A per-session worker rarely needs more than a few hundred MB in steady
 * state. Keep a full 1 GB escape hatch for unusually large contexts while
 * preventing three concurrent sessions from each being allowed to expand to
 * 2 GB before V8 applies pressure. Operators can still override this limit.
 */
export const DEFAULT_CODER_WORKER_HEAP_MB = 1_024;
/** Keep a wide safety margin below the 10-minute executor lease. */
export const CONTROL_PLANE_LEASE_RENEW_INTERVAL_MS = 60_000;

export class CoderWorkerPool {
  private readonly entries = new Map<SessionId, PoolEntry>();
  /**
   * Worker startup and teardown are both asynchronous (a dev worker can take
   * tens of seconds to boot). Keep one lifecycle promise per session so two
   * HTTP requests cannot create overlapping isolates, and a fresh request
   * cannot enter while the previous isolate is still releasing writer.lease.
   */
  private readonly entryStarts = new Map<SessionId, Promise<PoolEntry>>();
  private readonly evictions = new Map<SessionId, Promise<void>>();
  private readonly lifecycleFailures = new Map<SessionId, Error>();
  private readonly ttlMs: number;
  private readonly postRunLingerMs: number;
  private readonly log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private nextRunId = 1;

  constructor(private readonly opts: CoderWorkerPoolOpts) {
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
    this.postRunLingerMs = opts.postRunLingerMs ?? 30_000;
    this.log = opts.log ?? ((level, msg) => console[level === 'info' ? 'log' : level](msg));
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    if (this.sweepTimer && typeof (this.sweepTimer as { unref?: () => void }).unref === 'function') {
      (this.sweepTimer as { unref: () => void }).unref();
    }
  }

  /** Read the mirrored bus for a session. Touches `lastTouchedAt`. */
  getBus(sessionId: SessionId): CoderRunBus | null {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    entry.lastTouchedAt = Date.now();
    return entry.bus;
  }

  has(sessionId: SessionId): boolean {
    return this.entries.has(sessionId);
  }

  getControlPlaneRunContext(sessionId: SessionId): ControlPlaneRunContext | null {
    return this.entries.get(sessionId)?.controlPlaneRunContext ?? null;
  }

  /**
   * Snapshot for the `/api/admin/workers` diagnostic endpoint —
   * symmetric with `WorkerOrchestratorPool.snapshot()`.
   */
  snapshot(): Array<{
    sessionId: SessionId;
    workerState: string;
    lastTouchedAt: number;
    idleMs: number;
  }> {
    const now = Date.now();
    const out: Array<{
      sessionId: SessionId;
      workerState: string;
      lastTouchedAt: number;
      idleMs: number;
    }> = [];
    for (const [id, entry] of this.entries) {
      out.push({
        sessionId: id,
        workerState: entry.host.state,
        lastTouchedAt: entry.lastTouchedAt,
        idleMs: now - entry.lastTouchedAt,
      });
    }
    return out;
  }

  /**
   * Per-isolate heap stats for the admin perf monitor — symmetric with
   * `WorkerOrchestratorPool.memStats()`. Best-effort; doesn't touch TTL.
   */
  async memStats(
    timeoutMs = 2_000,
  ): Promise<Array<{ sessionId: SessionId; stats: import('../workers/perf-stats.js').WorkerMemStats | null }>> {
    const jobs = Array.from(this.entries.entries()).map(async ([sessionId, entry]) => {
      try {
        const stats = (await entry.host
          .requireBridge()
          .request('perf.memStats', {}, { timeoutMs })) as import('../workers/perf-stats.js').WorkerMemStats;
        return { sessionId, stats };
      } catch {
        return { sessionId, stats: null };
      }
    });
    return Promise.all(jobs);
  }

  /** V8 CPU profile of one session's worker isolate (admin perf panel). */
  async cpuProfile(sessionId: SessionId, durationMs: number): Promise<object | null> {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    return (await entry.host
      .requireBridge()
      .request('perf.cpuProfile', { durationMs }, { timeoutMs: durationMs + 10_000 })) as object;
  }

  /**
   * Spawn (if needed) and kick off a fresh `runCoder()` in the worker.
   * Returns the mirrored bus the caller should pump to SSE.
   */
  async runFresh(sessionId: SessionId, opts: RunFreshOpts): Promise<CoderRunBus> {
    const { controlPlaneRunContext, ...workerOpts } = opts;
    let entry: PoolEntry;
    try {
      entry = await this.ensureEntry(sessionId);
    } catch (error) {
      await terminalizeLocalCoderRun(
        this.opts.getControlPlaneStore?.(),
        controlPlaneRunContext,
        {
          event: 'error',
          data: { message: error instanceof Error ? error.message : String(error) },
          mode: 'worker_start_failure',
        },
      );
      throw error;
    }
    if (entry.runInProgress && !entry.bus.ended) {
      await terminalizeLocalCoderRun(
        this.opts.getControlPlaneStore?.(),
        controlPlaneRunContext,
        {
          event: 'error',
          data: { reason: 'run-already-in-progress', sessionId },
          mode: 'worker_start_failure',
        },
      );
      throw new Error(`coder-pool: run already in progress for session ${sessionId}`);
    }
    this.cancelPostRunEvict(entry);
    // A sequential run may reuse the warm worker entry. Retire the previous
    // run's timer before changing either the run id or authority context so a
    // queued stale callback cannot renew the replacement.
    this.stopControlPlaneLeaseRenewal(entry);
    entry.lastTouchedAt = Date.now();
    const runId = this.nextRunId++;
    this.prepareRunBus(entry, sessionId, runId);
    entry.controlPlaneRunContext = controlPlaneRunContext ?? null;
    // (B) — mark the run in-progress so the idle sweep keeps hands off
    // until the worker emits its terminal `done`/`error` via the bus
    // event mirror below.
    entry.runInProgress = true;
    if (controlPlaneRunContext) {
      this.startControlPlaneLeaseRenewal(entry, sessionId, runId, controlPlaneRunContext);
    }
    const bridge = entry.host.requireBridge();
    try {
      await bridge.request('runFresh', {
        ...workerOpts,
        runId,
        controlPlaneParentAgentRunId: controlPlaneRunContext?.agentRunId,
      }, { timeoutMs: 60_000 });
    } catch (err) {
      this.stopControlPlaneLeaseRenewal(entry);
      entry.runInProgress = false;
      await terminalizeLocalCoderRun(
        this.opts.getControlPlaneStore?.(),
        entry.controlPlaneRunContext,
        { event: 'error', data: { message: err instanceof Error ? err.message : String(err) }, mode: 'worker_start_failure' },
      );
      entry.controlPlaneRunContext = null;
      if (!entry.bus.ended) {
        const message = err instanceof Error ? err.message : String(err);
        publish(entry.bus, 'error', { message, reason: 'worker-runFresh-failed', sessionId });
        markEnded(entry.bus, 'error', {
          message,
          reason: 'worker-runFresh-failed',
          sessionId,
        });
        this.schedulePostRunEvict(entry, sessionId);
      }
      throw err;
    }
    return entry.bus;
  }

  /** Forward a follow-up user message to the worker's runner. */
  async pushUserMessage(
    sessionId: SessionId,
    content: string,
    selectedSkillIds?: string[],
    operationId = `message:${randomUUID()}`,
  ): Promise<number> {
    const entry = this.entries.get(sessionId);
    if (!entry) throw new Error(`coder-pool: no active run for session ${sessionId}`);
    this.cancelPostRunEvict(entry);
    entry.lastTouchedAt = Date.now();
    // (B) — re-engaging the worker mid-linger restarts the in-flight
    // semantics. Cleared again when the next `bus.end` arrives.
    entry.runInProgress = true;
    const result = await entry.host.requireBridge().request<{
      ok: boolean;
      roundMessageId: number;
    }>('pushUserMessage', {
      content,
      selectedSkillIds,
      operationId,
    });
    if (!result.ok || !Number.isSafeInteger(result.roundMessageId)) {
      throw new Error(`coder-pool: worker did not persist follow-up message for ${sessionId}`);
    }
    return result.roundMessageId;
  }

  /**
   * Route host-produced session diagnostics through the active filesystem
   * authority. Returning true means the lifecycle owned the event (including a
   * deliberate drop during teardown), so callers must not open a main writer.
   */
  async appendSessionEvent(
    sessionId: SessionId,
    event: string,
    payload: unknown,
  ): Promise<boolean> {
    if (this.evictions.has(sessionId)) return true;
    const starting = this.entryStarts.get(sessionId);
    if (starting) await starting;
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    await entry.host.requireBridge().request(
      'appendSessionEvent',
      {
        event,
        payload,
        operationId: `host-event:${event}:${randomUUID()}`,
      },
      { timeoutMs: 15_000 },
    );
    return true;
  }

  /**
   * Drop the post-run linger timer (and zero the slot so the timer
   * callback bails on re-check). Called whenever a fresh activity
   * arrives — the worker has work to do, no eviction yet.
   */
  private cancelPostRunEvict(entry: PoolEntry): void {
    if (!entry.postRunEvictTimer) return;
    clearTimeout(entry.postRunEvictTimer);
    entry.postRunEvictTimer = null;
  }

  private stopControlPlaneLeaseRenewal(entry: PoolEntry): void {
    const timer = entry.controlPlaneLeaseRenewTimer;
    if (!timer) return;
    entry.controlPlaneLeaseRenewTimer = null;
    clearInterval(timer);
  }

  private ownsControlPlaneLease(
    sessionId: SessionId,
    entry: PoolEntry,
    runId: number,
    context: ControlPlaneRunContext,
  ): boolean {
    const current = this.entries.get(sessionId);
    const active = current?.controlPlaneRunContext;
    return current === entry
      && current.currentRunId === runId
      && current.runInProgress
      && active?.agentRunId === context.agentRunId
      && active.attemptId === context.attemptId
      && active.executorOwnerId === context.executorOwnerId
      && active.fencingEpoch === context.fencingEpoch;
  }

  /**
   * Renew root execution authority independently from stream activity.
   *
   * Claude's lifecycle keeps ownership/permission state outside presentation
   * traffic; the same principle matters here because an otherwise healthy
   * provider or tool may emit nothing for longer than the 10-minute lease.
   */
  private startControlPlaneLeaseRenewal(
    entry: PoolEntry,
    sessionId: SessionId,
    runId: number,
    context: ControlPlaneRunContext,
  ): void {
    this.stopControlPlaneLeaseRenewal(entry);
    const timer = setInterval(() => {
      void (async () => {
      if (!this.ownsControlPlaneLease(sessionId, entry, runId, context)) {
        // A queued callback from an ended/replaced run may still enter once.
        // Clear only its own handle; never clobber the replacement's timer.
        clearInterval(timer);
        if (entry.controlPlaneLeaseRenewTimer === timer) {
          entry.controlPlaneLeaseRenewTimer = null;
        }
        return;
      }
      const renewed = await renewLocalCoderRunLease(
        this.opts.getControlPlaneStore?.() ?? null,
        context,
        new Date().toISOString(),
      );
      if (!renewed) {
        await this.handleControlPlaneAuthorityLost(
          sessionId,
          entry,
          runId,
          context,
        );
      }
      })();
    }, CONTROL_PLANE_LEASE_RENEW_INTERVAL_MS);
    entry.controlPlaneLeaseRenewTimer = timer;
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  }

  /**
   * A failed renewal means this executor no longer has proof of authority.
   * Fence locally before asking the worker to abort, publish one explicit
   * terminal, and evict the isolate so a failed/cooperative abort cannot keep
   * mutating behind the control plane's back.
   */
  private async handleControlPlaneAuthorityLost(
    sessionId: SessionId,
    entry: PoolEntry,
    runId: number,
    context: ControlPlaneRunContext,
  ): Promise<void> {
    if (!this.ownsControlPlaneLease(sessionId, entry, runId, context)) return;
    this.stopControlPlaneLeaseRenewal(entry);

    // Clear the context first. A racing worker terminal must never turn this
    // already-fenced attempt into a successful terminal.
    entry.controlPlaneRunContext = null;
    entry.runInProgress = false;
    const terminalData = {
      reason: 'control-plane-authority-lost',
      authorityLost: true,
      sessionId,
      runId,
    };
    if (!entry.bus.ended) {
      emitWorkerLog(entry.bus, 'error', 'lifecycle', 'executor authority lost; fencing worker', {
        sessionId,
        runId,
      });
      publish(entry.bus, 'error', terminalData);
      markEnded(entry.bus, 'error', terminalData);
    }
    await terminalizeLocalCoderRun(
      this.opts.getControlPlaneStore?.(),
      context,
      { event: 'error', data: terminalData, mode: 'authority_lost' },
    );

    try {
      void entry.host.requireBridge().request(
        'abort',
        { reason: 'control-plane-authority-lost' },
        { timeoutMs: 1_000 },
      ).catch((error) => {
        this.log(
          'warn',
          `[coder-pool] authority-lost abort failed session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    } catch (error) {
      this.log(
        'warn',
        `[coder-pool] authority-lost abort dispatch failed session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    void this.evict(sessionId);
  }

  private prepareRunBus(entry: PoolEntry, sessionId: SessionId, runId: number): void {
    if (entry.currentRunId !== 0 || entry.bus.ended) {
      try { entry.detachCurrentBusRuntimeLog(); } catch { /* best-effort */ }
      entry.bus = createBus(new AbortController());
      entry.detachCurrentBusRuntimeLog = installRuntimeEventLog(
        entry.bus,
        'coder',
        sessionId,
        { bundlePath: entry.sessionContext.bundlePath },
      );
    }
    entry.currentRunId = runId;
  }

  private schedulePostRunEvict(entry: PoolEntry, sessionId: SessionId): void {
    if (entry.postRunEvictTimer) clearTimeout(entry.postRunEvictTimer);
    entry.postRunEvictTimer = setTimeout(() => {
      // Re-check: a fresh run might have already cleared the timer
      // and bumped lastTouchedAt. Don't evict if so.
      const still = this.entries.get(sessionId);
      if (!still) return;
      if (still.postRunEvictTimer === null) return;
      this.log(
        'info',
        `[coder-pool] post-run linger expired — evicting session=${sessionId}`,
      );
      void this.evict(sessionId);
    }, this.postRunLingerMs);
    if (typeof (entry.postRunEvictTimer as { unref?: () => void }).unref === 'function') {
      (entry.postRunEvictTimer as { unref: () => void }).unref();
    }
  }

  async isWaitingForInput(sessionId: SessionId): Promise<boolean> {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    return entry.host.requireBridge().request<boolean>('isWaitingForInput', {});
  }

  /**
   * Forward a `provideUserInput` to the worker's runner — used by
   * `/answer`, `/plan-response`, `/tasks-response` when worker mode is
   * on. Returns true when the runner was actually waiting; false means
   * the caller should fall back to the resume path (synthesize the
   * tool_result and append to message history).
   */
  async provideUserInput(sessionId: SessionId, value: string, askId?: string): Promise<boolean> {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    this.cancelPostRunEvict(entry);
    entry.lastTouchedAt = Date.now();
    const result = await entry.host
      .requireBridge()
      .request<{ ok: boolean }>('provideUserInput', { value, askId });
    return !!result?.ok;
  }

  async interruptWait(sessionId: SessionId): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    await entry.host.requireBridge().request('interruptWait', {});
  }

  async setThinking(sessionId: SessionId, thinking: boolean): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    await entry.host.requireBridge().request('setThinking', { thinking });
  }

  /** Push a mid-run tool-permission-mode change into the live runner. */
  async setToolPermissionMode(sessionId: SessionId, mode: 'ask' | 'auto' | 'unrestricted'): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    await entry.host.requireBridge().request('setToolPermissionMode', { mode });
  }

  /** Abort ONE running ephemeral subagent (dashboard row cancel). */
  async abortAgent(
    sessionId: SessionId,
    groupId: string,
    agentRef: number | string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const entry = this.entries.get(sessionId);
    if (!entry) return { ok: false, reason: 'no_worker' };
    return await entry.host.requireBridge().request('abortAgent', { groupId, agentRef }) as
      { ok: boolean; reason?: string };
  }

  /** Fetch a finished subagent's retained transcript digest from the worker realm. */
  async readAgentTranscript(
    sessionId: SessionId,
    spawnId: string,
    agentRef?: number | string,
    maxChars?: number,
  ): Promise<{ ok: boolean; reason?: string; text?: string; label?: string; status?: string; hasTranscript?: boolean }> {
    const entry = this.entries.get(sessionId);
    if (!entry) return { ok: false, reason: 'no_worker' };
    return await entry.host.requireBridge().request('readAgentTranscript', { spawnId, agentRef, maxChars }) as
      { ok: boolean; reason?: string; text?: string; label?: string; status?: string; hasTranscript?: boolean };
  }

  /**
   * Persist and apply a provider change inside the active worker authority.
   * Returns false when no worker owns the session, allowing the caller to use
   * the main-process repository before the next writer handoff.
   */
  async swapProvider(sessionId: SessionId, provider: string, model: string): Promise<boolean> {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    const result = await entry.host.requireBridge().request(
      'swapProvider',
      { provider, model },
    ) as { ok?: boolean };
    return result.ok === true;
  }

  async abort(sessionId: SessionId): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    await entry.host.requireBridge().request('abort', {});
  }

  /** True while a run is in flight for this session (drives the "busy" guard on
   *  routes that must not mutate a live session, e.g. attach/detach project). */
  isRunning(sessionId: SessionId): boolean {
    return this.entries.get(sessionId)?.runInProgress === true;
  }

  async evict(sessionId: SessionId): Promise<void> {
    const existingEviction = this.evictions.get(sessionId);
    if (existingEviction) return existingEviction;

    // Publish the lifecycle fence before running any asynchronous teardown.
    // ensureEntry() observes this promise and waits for the old worker to
    // release its filesystem lease before it is allowed to spawn a replacement.
    const eviction = Promise.resolve().then(() => this.evictEntry(sessionId));
    this.evictions.set(sessionId, eviction);
    try {
      await eviction;
    } finally {
      if (this.evictions.get(sessionId) === eviction) {
        this.evictions.delete(sessionId);
      }
    }
  }

  private async evictEntry(sessionId: SessionId): Promise<void> {
    const starting = this.entryStarts.get(sessionId);
    if (starting) {
      await starting.catch(() => undefined);
    }
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.stopControlPlaneLeaseRenewal(entry);
    await terminalizeLocalCoderRun(
      this.opts.getControlPlaneStore?.(),
      entry.controlPlaneRunContext,
      { event: 'error', data: { reason: 'worker-evicted' }, mode: 'evicted' },
    );
    entry.controlPlaneRunContext = null;
    const activityId = enterBackgroundActivity(`coder-worker:evict:${sessionId}`);
    try {
      this.cancelPostRunEvict(entry);
      // A worker_thread shares Electron's PID, so force-terminating it with an
      // open writer.lease creates a lease that PID liveness can never reclaim.
      // Make lease release a separately acknowledged phase before the generic
      // WorkerHost stop/terminate sequence.
      await entry.host.requireBridge().request(
        'releaseSessionWriter',
        {},
        { timeoutMs: 15_000 },
      );
      // Session truly going away → close the preview window AND stop the dev
      // server the preview started for it ("owned"). The user's own runner is
      // never owned, so it stays up.
      closePreviewSession(sessionId);
      entry.detachBusMirror();
      const aliveMs = Date.now() - entry.lastTouchedAt;
      try {
        await entry.host.evict(5_000);
        if (this.entries.get(sessionId) === entry) {
          this.entries.delete(sessionId);
        }
        this.log('info', `[coder-pool] worker evicted session=${sessionId} (idle=${aliveMs}ms)`);
      } catch (err) {
        this.log(
          'warn',
          `[coder-pool] evict session=${sessionId} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      exitBackgroundActivity(activityId);
    }
  }

  async dispose(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    const ids = Array.from(new Set([
      ...this.entries.keys(),
      ...this.entryStarts.keys(),
      ...this.evictions.keys(),
    ]));
    await Promise.all(ids.map((id) => this.evict(id)));
  }

  /**
   * Fase 1D — compare the legacy terminal signal with the persisted
   * control-plane state after the terminal mirror. Best-effort audit:
   * mismatches are counted and persisted; failures never affect the run.
   */
  private async compareShadowTerminalState(
    sessionId: SessionId,
    context: ControlPlaneRunContext | null,
    event: 'done' | 'error',
    data: unknown,
  ): Promise<void> {
    const store = this.opts.getControlPlaneStore?.() ?? null;
    if (!store || !context || !coderControlPlaneShadowEnabled()) return;
    try {
      const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
      const terminal = classifyCoderTerminalOutcome({
        event,
        reason: record.reason,
        error: record.error,
        message: record.message,
      });
      const command = await store.getCommand(
        context.sessionId,
        context.commandId,
      );
      const run = await store.getRun(
        context.sessionId,
        context.agentRunId,
      );
      const divergences = compareRunTerminalState({
        legacy: { event: terminal.event, reason: terminal.reason },
        command: command ?? null,
        run: run ?? null,
      });
      if (divergences.length === 0) return;
      recordLocalCoderShadowDivergences(divergences.length);
      await store.recordDivergences(context, divergences);
    } catch (error) {
      this.log('warn', `[coder-pool] control-plane comparator failed session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      // (B) — never evict while a run is in flight. A slow provider or
      // long subagent batch can keep the worker busy past ttlMs without
      // any external HTTP touch (the dashboard streams but doesn't
      // re-POST). `runInProgress` is flipped by the `bus.event`
      // mirror via the worker's own activity, so a hung run still
      // gets evicted eventually by the server-side watchdog
      // (Frente E) — but the normal sweep here stays hands-off.
      if (entry.runInProgress) continue;
      if (now - entry.lastTouchedAt > this.ttlMs) {
        void this.evict(id);
      }
    }
  }

  async resolveRuntimeContext(
    sessionId: SessionId,
  ): Promise<SessionRuntimeContext> {
    const resolveRuntimeContext = this.opts.resolveSessionRuntimeContext;
    if (!resolveRuntimeContext) {
      throw new Error(
        'coder-pool: filesystem session runtime resolver is not configured',
      );
    }
    const sessionContext = await resolveRuntimeContext(sessionId);
    if (sessionContext.sessionId !== sessionId) {
      throw new Error(
        `coder-pool: filesystem resolver returned a different session (${sessionContext.sessionId})`,
      );
    }
    if (sessionContext.projectId != null && !sessionContext.projectRoot) {
      throw new Error(
        `coder-pool: project root unavailable for filesystem session ${sessionId}`,
      );
    }
    return sessionContext;
  }

  private async ensureEntry(sessionId: SessionId): Promise<PoolEntry> {
    const evicting = this.evictions.get(sessionId);
    if (evicting) await evicting;
    const lifecycleFailure = this.lifecycleFailures.get(sessionId);
    if (lifecycleFailure) throw lifecycleFailure;

    const existing = this.entries.get(sessionId);
    if (existing) return existing;

    const starting = this.entryStarts.get(sessionId);
    if (starting) return starting;

    const start = this.createEntry(sessionId);
    this.entryStarts.set(sessionId, start);
    try {
      return await start;
    } finally {
      if (this.entryStarts.get(sessionId) === start) {
        this.entryStarts.delete(sessionId);
      }
    }
  }

  private async createEntry(sessionId: SessionId): Promise<PoolEntry> {
    const resolvedContext = await this.resolveRuntimeContext(sessionId);
    const sessionContext: SessionRuntimeContext = {
      ...resolvedContext,
      writerOwnerId: `coder-worker:${randomUUID()}`,
    };
    await this.opts.handoffSessionWriter?.(sessionContext);

    const host = new WorkerHost({
      name: `coder-session-${sessionId}`,
      workerFile: this.opts.workerFile,
      workerData: {
        sessionId,
        sessionContext,
        dbPath: this.opts.dbPath,
        // Dev bootstrap reads this to dynamic-import the real TS entry
        // after registering tsx. Absent in production builds.
        tsEntry: this.opts.workerDevTsEntry,
      },
      execArgv: this.opts.workerExecArgv,
      resourceLimits: {
        maxOldGenerationSizeMb: this.opts.workerMaxOldGenerationSizeMb ?? DEFAULT_CODER_WORKER_HEAP_MB,
      },
      // A restarted WorkerHost would retain bridge handlers wired to the old
      // MessagePort. Tear the entry down and let the next request create a
      // fully fenced replacement instead.
      maxRestarts: 0,
      defaultRequestTimeoutMs: 120_000,
      // Worker→main event listeners run inline on the Electron main loop, so
      // this is real blocking time. One hook covers bus.event, bus.end and
      // every bridge RPC dispatch (docOutline, mcpExt.callTool, LSP, …) — which
      // is what lets a freeze during an agent turn name what it was doing
      // instead of coming back unattributed.
      onDispatch: (type, ms) => noteSyncLeaf(`bus.event:${type}`, ms),
      onCrash: (err) => {
        this.log('error', `[coder-pool] worker session=${sessionId} crashed: ${err.message}`);
        // Apêndice 4 Fase 1 — structured crash log so post-mortem can
        // tie the dashboard "Connecting…" hang back to a specific
        // worker exit. Behind MCP_CODER_WORKER_DEBUG=1 (cheap, but the
        // stack can be noisy in prod logs).
        if (process.env.MCP_CODER_WORKER_DEBUG === '1') {
          const entry = this.entries.get(sessionId);
          const now = Date.now();
          console.error(
            `[coder-pool] worker-crashed ${JSON.stringify({
              sessionId,
              errorName: err.name,
              message: err.message,
              stack: err.stack,
              lastTouchedAt: entry?.lastTouchedAt ?? null,
              msSinceLastTouch: entry?.lastTouchedAt ? now - entry.lastTouchedAt : null,
              busEnded: entry?.bus?.ended ?? null,
              hadEntry: !!entry,
            })}`,
          );
        }
        // Notify the SSE pump BEFORE we drop the entry — otherwise
        // `waitEnded(bus)` (in `pumpBusToSSE`) hangs forever and the
        // dashboard sits on "Conectando…" with no terminal event. The
        // worker's own `process.on('uncaughtException')` (coder-worker.ts)
        // covers the case where the run loop throws synchronously. THIS
        // path covers the harder failures: process exit from OOM, SIGKILL,
        // segfault in a native dep — anywhere the worker can't run JS
        // anymore. Belt-and-suspenders.
        const entry = this.entries.get(sessionId);
        if (entry?.host !== host) return;
        if (entry?.bus && !entry.bus.ended) {
          // Emit a worker_log BEFORE markEnded so the dashboard's
          // WorkerLogPanel renders the crash with its real reason
          // alongside the terminal `error` event.
          emitWorkerLog(entry.bus, 'error', 'pool', 'worker crashed', {
            sessionId,
            errorName: err.name,
            message: err.message,
          });
          publish(entry.bus, 'error', {
            message: `worker crashed: ${err.message}`,
            reason: 'worker-crashed',
            sessionId,
          });
          markEnded(entry.bus, 'error', {
            reason: 'worker-crashed',
            message: err.message,
            sessionId,
          });
        }
        if (entry) {
          this.stopControlPlaneLeaseRenewal(entry);
          const terminalContext = entry.controlPlaneRunContext;
          entry.controlPlaneRunContext = null;
          void (async () => {
            await terminalizeLocalCoderRun(
              this.opts.getControlPlaneStore?.(),
              terminalContext,
              {
                event: 'error',
                data: { reason: 'worker-crashed', message: err.message },
                mode: 'worker_crash',
              },
            );
            await this.compareShadowTerminalState(
              sessionId,
              terminalContext,
              'error',
              { reason: 'worker-crashed' },
            );
          })();
        }
        closePreviewSession(sessionId);
        if (this.entries.get(sessionId)?.host === host) {
          this.entries.delete(sessionId);
        }
      },
      onExit: (_code, planned) => {
        if (planned) return;
        const ownerId = sessionContext.writerOwnerId;
        if (!ownerId || this.evictions.has(sessionId)) return;
        const cleanup = releaseSessionWriterLeaseForOwner({
          bundlePath: sessionContext.bundlePath,
          ownerId,
        })
          .then((released) => {
            this.lifecycleFailures.delete(sessionId);
            if (released) {
              this.log(
                'warn',
                `[coder-pool] reclaimed crashed worker lease session=${sessionId}`,
              );
            }
          })
          .catch((error) => {
            const failure = error instanceof Error ? error : new Error(String(error));
            this.lifecycleFailures.set(
              sessionId,
              new Error(
                `coder-pool: failed to recover crashed writer for session ${sessionId}: ${failure.message}`,
                { cause: failure },
              ),
            );
            this.log(
              'error',
              `[coder-pool] crashed writer recovery failed session=${sessionId}: ${failure.message}`,
            );
          })
          .finally(() => {
            if (this.evictions.get(sessionId) === cleanup) {
              this.evictions.delete(sessionId);
            }
          });
        this.evictions.set(sessionId, cleanup);
      },
      onError: (err) => {
        this.log('warn', `[coder-pool] worker session=${sessionId} error: ${err.message}`);
      },
    });
    const startedAt = Date.now();
    const activityId = enterBackgroundActivity(`coder-worker:spawn:${sessionId}`);
    try {
      await host.start();
      // Worker boot can overlap best-effort main-process metadata jobs (for
      // example title/model persistence) that started before the session lock
      // was acquired. Drain that repository once more, then require the worker
      // to acknowledge acquisition before any run RPC can be dispatched.
      await this.opts.handoffSessionWriter?.(sessionContext);
      await host.requireBridge().request(
        'acquireSessionWriter',
        {},
        { timeoutMs: 15_000 },
      );
    } catch (error) {
      await host.evict().catch(() => undefined);
      throw error;
    } finally {
      exitBackgroundActivity(activityId);
    }
    const bootMs = Date.now() - startedAt;
    this.log(
      'info',
      `[coder-pool] worker spawned session=${sessionId} ` +
        `(boot=${bootMs}ms, old-space=${this.opts.workerMaxOldGenerationSizeMb ?? DEFAULT_CODER_WORKER_HEAP_MB}MB)`,
    );

    // Mirror the worker's bus to a main-side bus so existing
    // `pumpBusToSSE(c, bus, …)` calls keep working without change.
    const bus = createBus(new AbortController());
    const detachRuntimeLog = installRuntimeEventLog(
      bus,
      'coder',
      sessionId,
      { bundlePath: sessionContext.bundlePath },
    );
    // Log the spawn on the brand-new bus — the dashboard's
    // WorkerLogPanel will show "worker spawned (boot=Xms)" as the
    // first event of this run, before any runner events arrive.
    emitWorkerLog(bus, 'info', 'pool', `worker spawned (boot=${bootMs}ms)`, {
      sessionId,
      bootMs,
    });
    const bridge = host.requireBridge();
    // ─── Wire RPC bridges from worker → main ─────────────────────────
    // `rag_search_docs` runs in the worker. Only structural navigation and
    // deep research cross this bridge; the navigation verbs are short SQLite
    // reads and the methods remain optional for compatibility with old hosts.
    const offDocReadChunk = bridge.handle('docReadChunk', async (payload) => {
      const backend = this.opts.docDeps?.docSearch;
      if (!backend?.readChunk) {
        throw new Error(
          'rag_read_doc is not available in this process (backend without readChunk). Use the rag_search_docs snippets instead.',
        );
      }
      return backend.readChunk(payload as Parameters<NonNullable<DocSearchBackend['readChunk']>>[0]);
    });
    // rag_read_doc mode:'section' — whole-section reassembly (optional verb).
    const offDocReadSection = bridge.handle('docReadSection', async (payload) => {
      const backend = this.opts.docDeps?.docSearch;
      if (!backend?.readSection) {
        throw new Error('section mode is not available in this process — call rag_read_doc without mode to read this chunk + neighbors.');
      }
      return backend.readSection(payload as Parameters<NonNullable<DocSearchBackend['readSection']>>[0]);
    });
    // rag_doc_outline — structural navigation (optional verb).
    const offDocOutline = bridge.handle('docOutline', async (payload) => {
      const backend = this.opts.docDeps?.docSearch;
      if (!backend?.outline) {
        throw new Error('rag_doc_outline is not available in this process. Use rag_search_docs instead.');
      }
      return backend.outline(payload as Parameters<NonNullable<DocSearchBackend['outline']>>[0]);
    });
    const offDocsResearch = registerDocsResearchRpcHandlers(
      bridge,
      () => this.opts.docDeps?.docsResearch,
    );
    // Preview DevTools — routes to the main-process PreviewWindowService
    // (set by the Electron main via setGlobalPreviewDevtools). Unset in
    // headless → the tool surfaces a friendly "unavailable" error.
    const offPreviewDevtools = bridge.handle('previewDevtools', async (payload) => {
      const svc = getGlobalPreviewDevtools();
      if (!svc) throw new Error('Preview DevTools unavailable — only in the desktop app with a preview open.');
      return svc.invoke(payload as PreviewInvoke);
    });
    const offPreviewDevtoolsCancel = bridge.handle('previewDevtoolsCancel', async (payload) => {
      const svc = getGlobalPreviewDevtools();
      const requestId = (payload as { requestId?: unknown })?.requestId;
      if (svc?.cancel && typeof requestId === 'string') await svc.cancel(requestId);
      return { ok: true };
    });
    const offResearchBrowser = bridge.handle('researchBrowser', async (payload) => {
      const browser = getGlobalResearchBrowser();
      if (!browser) throw new Error('Research browser backend is unavailable.');
      return browser.invoke(payload as ResearchBrowserInvoke);
    });
    const offResearchBrowserCancel = bridge.handle('researchBrowserCancel', async (payload) => {
      const browser = getGlobalResearchBrowser();
      const requestId = (payload as { requestId?: unknown })?.requestId;
      if (browser?.cancel && typeof requestId === 'string') await browser.cancel(requestId);
      return { ok: true };
    });
    // Vision fallback — routes image→text describe to the main-process vision
    // describer (resolves the code-agent/vision Pipelines role + runs a one-off
    // chat). Unset/unbound → throws VISION_NOT_CONFIGURED; the worker-side
    // transform catches it and keeps the raw image + a note.
    const offVisionDescribe = bridge.handle('visionDescribe', async (payload) => {
      const v = this.opts.docDeps?.vision;
      if (!v) {
        throw new Error(
          'VISION_NOT_CONFIGURED: no vision model is bound. Set the code-agent / vision role in Settings → Pipelines.',
        );
      }
      return v.describe(payload as VisionDescribeRequest);
    });
    // Sprite Studio host — routes the `sprite_*` tools' method calls to the
    // main-process host (stores + repo writes + job runner). One channel
    // forwards { method, args } so new host methods need no new RPC name.
    // Unset (flag off / headless) → the worker shim surfaces the same
    // SPRITE_STUDIO_NOT_CONFIGURED message the in-process tools use.
    const offSpriteHost = bridge.handle('spriteStudioHost', async (payload) => {
      const host = this.opts.docDeps?.spriteStudioHost;
      if (!host) {
        throw new Error(
          'SPRITE_STUDIO_NOT_CONFIGURED: Sprite Studio is not available in this process.',
        );
      }
      const { method, args } = payload as { method: keyof ISpriteStudioHost; args: unknown[] };
      const fn = host[method] as ((...a: unknown[]) => Promise<unknown>) | undefined;
      if (typeof fn !== 'function') throw new Error(`Unknown spriteStudioHost method: ${String(method)}`);
      return fn.apply(host, args);
    });
    // Project memory (Mem C) — routes retrieve / extract / isConfigured to
    // the canonical MemoryRetriever + RunEndMemory built in server/deps.ts.
    // Without these handlers the worker path silently loses per-turn memory
    // injection AND run-end distillation (regression vs the in-process path
    // in routes/coder/stream.ts, which passes deps.memoryRetriever directly).
    const offMemory = registerWorkerMemoryHandlers(bridge, () => this.opts.docDeps);
    // Secret decryption (`enc:`/`plain:` blobs) — safeStorage lives only in
    // the Electron main process; db_* tools in the worker RPC here.
    const offSecrets = registerWorkerSecretsHandlers(bridge);

    // Agent LSP nav (lsp_definition/references/hover on non-TS files) —
    // routed to the main-process LSP router (external servers + structural
    // index fallback). Deps land via setWorkerLspDeps in server.ts.
    const offLsp = registerWorkerLspHandlers(bridge);

    // ─── External-MCP pool bridge ─────────────────────────────────────
    // Worker's `RemoteMcpServerManager` requests a snapshot once per run
    // (in `connectAll()`) and routes every tool invocation through
    // `mcpExt.callTool`. The pool field is mutable on `opts` because
    // the singleton wire-up sets it after the pool finishes booting
    // (server.ts boots Hono synchronously, then awaits pool.boot()).
    const offMcpSnapshot = bridge.handle('mcpExt.snapshot', async () => {
      const pool = this.opts.getMcpExternalPool?.() ?? null;
      if (!pool) {
        // Empty snapshot keeps the worker happy — `extTools.length > 0`
        // gate in runCoder simply skips external registration.
        return {
          tools: [],
          tierMap: [],
          states: [],
          customTierSummary: [],
          enabledServers: [],
          connectedCount: 0,
        };
      }
      return pool.getSnapshot();
    });
    const offMcpCallTool = bridge.handle('mcpExt.callTool', async (payload) => {
      const pool = this.opts.getMcpExternalPool?.() ?? null;
      if (!pool) {
        return { ok: false, text: 'External MCP pool not configured in this http-api process.' };
      }
      const p = payload as { serverId: string; toolName: string; args: Record<string, unknown> };
      return pool.callTool(p.serverId, p.toolName, p.args);
    });

    const offEvent = bridge.on('bus.event', (payload) => {
      const env = payload as { runId?: number; event: string; data: unknown };
      const e = this.entries.get(sessionId);
      if (!e || env.runId !== e.currentRunId || e.bus.ended) return;
      const forwarded = env.event === 'done' || env.event === 'error'
        ? normalizeCoderTerminalSignal(env.event, env.data)
        : { event: env.event, data: env.data };
      // (A) — worker activity refreshes the idle timer. Without this, a
      // slow provider (LLM thinking 6+ min on a fat prompt) looks idle
      // to the sweep and gets evicted mid-turn (session 798 symptom).
      // Bus events flow continuously while the worker is doing real
      // work (heartbeats every 10s, text/tool deltas, dispatch
      // progress) — so any single such event resets `lastTouchedAt`
      // far below the 5-min TTL.
      e.lastTouchedAt = Date.now();
      const controlPlaneStore = this.opts.getControlPlaneStore?.() ?? null;
      const context = e.controlPlaneRunContext;
      if (context) {
        if (env.event === 'run_started') {
          const data = env.data && typeof env.data === 'object' ? env.data as Record<string, unknown> : {};
          void markLocalCoderRunStarted(
            controlPlaneStore,
            context,
            typeof data.runId === 'string' ? data.runId : undefined,
          );
        } else if (env.event === 'tool_call_start') {
          const data = env.data && typeof env.data === 'object' ? env.data as Record<string, unknown> : {};
          if (typeof data.id === 'string' && typeof data.name === 'string') {
            void mirrorLocalCoderToolBoundary(controlPlaneStore, context, {
              phase: 'started',
              toolUseId: data.id,
              toolName: data.name,
              value: data.input,
            });
          }
        } else if (env.event === 'tool_call_result') {
          const data = env.data && typeof env.data === 'object' ? env.data as Record<string, unknown> : {};
          if (typeof data.id === 'string' && typeof data.name === 'string') {
            void mirrorLocalCoderToolBoundary(controlPlaneStore, context, {
              phase: 'completed',
              toolUseId: data.id,
              toolName: data.name,
              value: data.result,
              durationMs: typeof data.duration_ms === 'number' ? data.duration_ms : undefined,
            });
          }
        } else {
          mirrorBusLifecycleEvent(controlPlaneStore, context, env.event, env.data);
        }
      }
      publish(e.bus, forwarded.event, forwarded.data);
    });
    const offEnd = bridge.on('bus.end', (payload) => {
      const env = payload as { runId?: number; event: 'done' | 'error'; data: unknown };
      const e = this.entries.get(sessionId);
      if (!e || env.runId !== e.currentRunId) return;
      this.stopControlPlaneLeaseRenewal(e);
      // Mixed-version workers may still report a failure-class runner outcome
      // as `done`. Normalize before the mirrored bus and durable ledger observe
      // it so neither layer can record a false success.
      const terminal = normalizeCoderTerminalSignal(env.event, env.data);
      if (!e.bus.ended) {
        markEnded(e.bus, terminal.event, terminal.data);
      }
      const terminalContext = e.controlPlaneRunContext;
      e.controlPlaneRunContext = null;
      // The bus terminal is already visible to SSE above. The filesystem
      // authority is queued before any following command for this session, then
      // the diagnostic comparison runs after that durable transition.
      void (async () => {
        await terminalizeLocalCoderRun(
          this.opts.getControlPlaneStore?.(),
          terminalContext,
          terminal,
        );
        await this.compareShadowTerminalState(
          sessionId,
          terminalContext,
          terminal.event,
          terminal.data,
        );
      })();
      // (B) — terminal event: run is no longer in progress; sweep may
      // now consider this entry for eviction once ttlMs elapses without
      // a follow-up `runFresh`/`pushUserMessage`.
      e.runInProgress = false;
      // Turn ended → close the agent's dedicated preview WINDOW (frees the
      // BrowserWindow) but keep any preview-owned dev server up for reuse
      // on the next turn. This fulfils the dashboard's existing assumption
      // ("the pool closes the agent's preview window") and matches the
      // `coder:agent_preview {open:false}` it already emits on `done`.
      closePreviewWindow(sessionId);
      // Builder projects: land the run's dirty tree as a checkpoint commit
      // (+ timeline thumbnail). Fire-and-forget; no-op for non-builder.
      notifyBuilderRunEnded(sessionId);
      // Fast-evict on run completion. We can't synchronously evict
      // here because a follow-up `/messages` POST may arrive within
      // a few seconds and would have to pay the cold-start cost
      // again. The linger window (default 30 s) gives the dashboard
      // and the user time to chain another turn through the same
      // worker. Any `runFresh` / `pushUserMessage` during that
      // window cancels the timer.
      this.schedulePostRunEvict(e, sessionId);
    });

    let entry: PoolEntry;
    entry = {
      host,
      bus,
      sessionContext,
      currentRunId: 0,
      lastTouchedAt: Date.now(),
      detachCurrentBusRuntimeLog: detachRuntimeLog,
      postRunEvictTimer: null,
      // Fresh entries are inert until the first `runFresh`. The sweep
      // never sees them in this state because `lastTouchedAt` was just
      // bumped by `ensureEntry`, but the explicit `false` documents
      // intent.
      runInProgress: false,
      controlPlaneRunContext: null,
      controlPlaneLeaseRenewTimer: null,
      detachBusMirror: () => {
        try { entry.detachCurrentBusRuntimeLog(); } catch { /* best-effort */ }
        try { offEvent(); } catch { /* best-effort */ }
        try { offEnd(); } catch { /* best-effort */ }
        try { offDocReadChunk(); } catch { /* best-effort */ }
        try { offDocReadSection(); } catch { /* best-effort */ }
        try { offDocOutline(); } catch { /* best-effort */ }
        try { offDocsResearch(); } catch { /* best-effort */ }
        try { offPreviewDevtools(); } catch { /* best-effort */ }
        try { offPreviewDevtoolsCancel(); } catch { /* best-effort */ }
        try { offResearchBrowser(); } catch { /* best-effort */ }
        try { offResearchBrowserCancel(); } catch { /* best-effort */ }
        try { offVisionDescribe(); } catch { /* best-effort */ }
        try { offSpriteHost(); } catch { /* best-effort */ }
        try { offMemory(); } catch { /* best-effort */ }
        try { offSecrets(); } catch { /* best-effort */ }
        try { offLsp(); } catch { /* best-effort */ }
        try { offMcpSnapshot(); } catch { /* best-effort */ }
        try { offMcpCallTool(); } catch { /* best-effort */ }
      },
    };
    this.entries.set(sessionId, entry);
    return entry;
  }
}
