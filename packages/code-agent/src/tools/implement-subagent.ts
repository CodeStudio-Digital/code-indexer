/**
 * Generalized subagent runner — extracted from src/coder/tools/subagent.ts so
 * that both the read-only `spawn_subagent` (explore) flow AND the new
 * `execute_task` mode='subagent' flow can spin up isolated CoderRunners with
 * a curated tool registry, parameterized system prompt, and (optionally) a
 * path scope for filesystem/shell tools.
 *
 * The implement-subagent variant additionally:
 *   - whitelists write_file/edit_file/create_file/run_command;
 *   - wraps fs/shell tools with a path-scope sandbox that LOGS (warning mode)
 *     reads/writes outside the declared task files but DOES NOT block them;
 *   - parses a structured `<result>{...}</result>` block from the subagent's
 *     final assistant message into a TaskResult.
 *
 * The wrapper deliberately uses warning mode instead of strict blocking
 * because subagents can have legitimate reasons to read an imported file
 * outside the declared scope (e.g. to look at a type definition). The parent
 * orchestrator gets the violation list in the TaskResult and can decide.
 */
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import type { AgentMessage, ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { CoderRunner, SUBAGENT_TOOL_RESULT_CAP, extractPathsFromToolArgs, isPathInsideScope } from '@mcp/code-agent/core/runner.js';
import type { CoderTask, TaskResult, TaskReference } from '@mcp/code-agent/sessions/types.js';
import { createSubagentMonitor } from '@mcp/code-agent/tools/subagent-monitor.js';
import { buildSubagentSalvageSummary } from '@mcp/code-agent/tools/subagent-salvage.js';

/**
 * Tool filter for a subagent. Three shapes:
 *   - `Set<string>` — legacy allowlist by tool name. Matches the static
 *     EXPLORE_ALLOWLIST / IMPLEMENT_ALLOWLIST tables below.
 *   - `(tool) => boolean` — predicate. Lets callers admit dynamic groups
 *     like "all MCP externos that aren't mutating" without enumerating
 *     names ahead of time.
 *   - `null` — full access. Subagent inherits the parent registry as-is.
 */
export type SubagentAllowlist =
  | Set<string>
  | ((tool: CoderTool) => boolean)
  | null;

export interface SubagentSpec {
  systemPrompt: string;
  label?: string;
  allowlist: SubagentAllowlist;
  initialMessages: AgentMessage[];
  maxTurns: number;
  pushTimeCap?: number;
  limits?: SubagentLimits;
  signal?: AbortSignal;
  /** When set, fs/shell tools log (do not block) reads/writes outside this list. */
  pathScope?: string[];
  /** Optional progress hook for callers that need a per-subagent live timeline. */
  onProgress?: (progress: {
    event: 'heartbeat' | 'tool_call';
    status?: 'running' | 'completed' | 'error' | 'timed_out' | 'aborted';
    toolCallCount: number;
    toolName?: string;
    note?: string;
    phase?: string;
    turn?: number;
    elapsedMs?: number;
    stallMs?: number;
    idleMs?: number;
    deadlineMs?: number;
    lastToolName?: string;
    limit?: SubagentLimits;
  }) => void;
}

export interface SubagentLimits {
  maxToolCalls?: number;
  timeoutMs?: number;
  stallMs?: number;
}

/** Helper: tests whether a tool is admitted by the given allowlist shape. */
function isAllowed(allowlist: SubagentAllowlist, tool: CoderTool): boolean {
  if (allowlist === null) return true;
  if (typeof allowlist === 'function') return allowlist(tool);
  return allowlist.has(tool.name);
}

const DEFAULT_SUBAGENT_LIMITS: Required<SubagentLimits> = {
  maxToolCalls: Number(process.env.CODER_SUBAGENT_MAX_TOOLS ?? 80) || 80,
  timeoutMs: Number(process.env.CODER_SUBAGENT_TIMEOUT_MS ?? 10 * 60_000) || 10 * 60_000,
  stallMs: Number(process.env.CODER_SUBAGENT_STALL_MS ?? 120_000) || 120_000,
};

function withDefaultLimits(limits?: SubagentLimits): SubagentLimits {
  return {
    maxToolCalls: limits?.maxToolCalls ?? DEFAULT_SUBAGENT_LIMITS.maxToolCalls,
    timeoutMs: limits?.timeoutMs ?? DEFAULT_SUBAGENT_LIMITS.timeoutMs,
    stallMs: limits?.stallMs ?? DEFAULT_SUBAGENT_LIMITS.stallMs,
  };
}

/**
 * Map a watchdog stop `phase` to a `StopReason`. The tool-call budget
 * ('limit') is a benign, expected cutoff — report it as `'tool_budget'`, NOT
 * `'error'`, so the parent doesn't treat a truncated-but-progressing subagent
 * as a crash (and the session store doesn't mark the parent session errored).
 * An explicit/parent abort maps to `'aborted'`. Genuine anomalies (stall /
 * timeout / provider_timeout / quality) stay `'error'`.
 */
function phaseToReason(phase: string | undefined): SubagentRunResult['reason'] {
  switch (phase) {
    case 'limit':
      return 'tool_budget';
    case 'aborted':
      return 'aborted';
    default:
      return 'error';
  }
}

export interface SubagentCollected {
  memos: ReadonlyArray<import('@mcp/code-agent/tools/subagent-collector.js').SubagentMemo>;
  snapshots: ReadonlyArray<import('@mcp/code-agent/tools/subagent-collector.js').SubagentSnapshotRef>;
  boardPosts: ReadonlyArray<import('@mcp/code-agent/tools/subagent-collector.js').SubagentBoardPostRef>;
}

export function emptyCollected(): SubagentCollected {
  return { memos: [], snapshots: [], boardPosts: [] };
}

export interface SubagentRunResult {
  /** PR-4 widened to StopReason — accepts new fine-grained reasons
   *  (`recovery_capped`, `doom_loop`, `compact_failure`). Existing consumers
   *  that switch only on `'completed' | 'error'` keep working. */
  reason: import('@mcp/code-agent/core/runner.js').StopReason;
  finalText: string;
  usage: ChatUsage;
  /** Path strings flagged by the path-scope wrapper, in arrival order. */
  sandboxViolations: string[];
  /**
   * Frente C (PR 3 da reavaliação) — structured trail the sub emitted via
   * `record_memo` / `mcp__add_snapshot` / `post_to_board`. The parent
   * `spawn_agent` handler appends a compact rendering of this to the
   * tool_result text so the master sees what the sub found beyond the
   * one final assistant message.
   *
   * Production paths always return empty arrays when the sub didn't emit
   * anything. Optional in the type so legacy tests/fakes that predate the
   * collector can keep using compact result literals.
   */
  collected?: SubagentCollected;
}

export interface SubagentParent {
  provider: ChatProvider;
  /** Snapshot of the parent registry's tools — filtered by `spec.allowlist`. */
  tools: CoderTool[];
  ctx: ToolContext;
  /** Persistent session id of the parent runner — propagated so subagent logs read `s=<parentId>/sub`. */
  sessionId?: number;
  /**
   * Parent's SessionStore — when present, the implement-subagent's system
   * prompt is mirrored into `coder_session_inputs` (kind `subagent_prompt`)
   * for the Input tab in the session details modal.
   */
  sessionStore?: import('@mcp/code-agent/sessions/store.js').SessionStore;
  /**
   * PR-6 (R23): when true, the parent is running with Agent Loop v2 enabled
   * and the subagent inherits the v2 features (pre-read enforcement,
   * result-content dedup, exp+jitter retry). The runner also appends the
   * short subagent-specific framing (persistence + don't re-read) to the
   * provided `systemPrompt`. Default false — subagents keep legacy behaviour
   * if the parent isn't explicitly v2.
   */
  agentLoopV2?: boolean;
}

/**
 * Spin up an isolated CoderRunner constrained by `spec`, run it to completion,
 * and return the structured result.
 *
 * The subagent inherits the parent's provider instance (no extra connection
 * pool needed for sequential subagents), the same overlay/cwd, and the parent
 * abort signal. It does NOT receive a `ctx.runner` back-reference — submit_plan,
 * ask_user and submit_tasks intentionally fail inside subagents because the
 * subagent only talks to its parent via the final `<result>` block, never to
 * the user directly.
 */
export async function runSubagent(parent: SubagentParent, spec: SubagentSpec): Promise<SubagentRunResult> {
  const sandboxViolations: string[] = [];
  const limits = withDefaultLimits(spec.limits);
  const startedAt = Date.now();
  let lastToolName: string | undefined;
  let subToolCalls = 0;
  let currentTurn = 0;
  let watchdogFailed = false;
  let watchdogPhase: string | undefined;
  let lastStreamProgressAt = 0;
  const streamProgressThrottleMs =
    Number(process.env.CODER_SUBAGENT_STREAM_PROGRESS_THROTTLE_MS ?? '5000') || 5_000;

  const subAbort = new AbortController();
  let abortFailure: ((message: string) => void) | undefined;
  let lastAbortReason = 'subagent aborted';
  const abortSubagent = (reason: string): void => {
    lastAbortReason = reason;
    try { subAbort.abort(new Error(reason)); } catch { /* ignore */ }
  };
  const parentAbort = () => {
    abortSubagent('parent aborted');
    abortFailure?.('parent aborted');
  };
  const explicitAbort = () => {
    abortSubagent('subagent aborted');
    abortFailure?.('subagent aborted');
  };
  if (parent.ctx.signal) {
    if (parent.ctx.signal.aborted) parentAbort();
    else parent.ctx.signal.addEventListener('abort', parentAbort, { once: true });
  }
  if (spec.signal) {
    if (spec.signal.aborted) explicitAbort();
    else spec.signal.addEventListener('abort', explicitAbort, { once: true });
  }

  const monitor = createSubagentMonitor({
    limits,
    startedAt,
    getToolCallCount: () => subToolCalls,
    getTurn: () => currentTurn,
    getLastToolName: () => lastToolName,
    onProgress: spec.onProgress,
    onFail: (message, phase) => {
      handleWatchdogFailure(message, phase);
    },
  });

  const markActivity = (phase: string, note: string): void => {
    monitor.recordVisual(phase, note);
  };

  const markStreamActivity = (phase: string, note: string): void => {
    const now = Date.now();
    const shouldEmit = now - lastStreamProgressAt >= streamProgressThrottleMs;
    if (shouldEmit) lastStreamProgressAt = now;
    monitor.recordProviderDelta(phase, note, shouldEmit);
  };

  // Subagent collector — bridges the sub's structured emissions
  // (memos / snapshots / board posts) back to the parent's tool_result.
  // Created BEFORE the registry build so the snapshot/board wrappers can
  // close over it during registration.
  const { SubagentCollector } = await import('@mcp/code-agent/tools/subagent-collector.js');
  const collector = new SubagentCollector();

  // Build the filtered + (optionally) path-wrapped + (optionally) collector-
  // wrapped registry. `allowlist` accepts Set / predicate / null (full
  // access) — see SubagentAllowlist. Wrappers compose: path-scope first
  // (so we record violations against the *raw* paths), collector second
  // (so we mirror the successful tool_result regardless of scope).
  const subRegistry = new ToolRegistry();
  for (const tool of parent.tools) {
    if (!isAllowed(spec.allowlist, tool)) continue;
    let wrapped = spec.pathScope ? wrapToolForPathScope(tool, spec.pathScope, sandboxViolations) : tool;
    wrapped = wrapToolForCollector(wrapped, collector);
    subRegistry.register(wrapped);
  }
  // Frente C — `record_memo` is ALWAYS available in subagents regardless
  // of the allowlist. It's how the sub speaks back to the parent beyond
  // the final assistant text.
  try {
    const { recordMemoTool } = await import('@mcp/code-agent/tools/record-memo.js');
    if (!subRegistry.has('record_memo')) {
      subRegistry.register(recordMemoTool);
    }
  } catch (e) {
    console.warn(`[subagent] record_memo registration failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const subContext: ToolContext = {
    cwd: parent.ctx.cwd,
    projectName: parent.ctx.projectName,
    overlay: parent.ctx.overlay,
    signal: subAbort.signal,
    // Inherit the parent's "unrestricted tool output" toggle so MCP/code_exec
    // calls inside the subagent honour the same per-call truncation policy
    // as the main session (with the smaller subagent ceiling enforced by
    // the runner's `effectivePushTimeCap`).
    unrestrictedToolOutput: parent.ctx.unrestrictedToolOutput,
    // Permission gate inheritance: the gate instance holds the PARENT
    // runner's waitForUserInput/emit, so subagent approvals render and
    // resolve at session level (the sub has no bus of its own).
    permissionGate: parent.ctx.permissionGate,
    // Anchor approvals to the chat-visible spawning tool_use (spawn_agent /
    // execute_tasks block) — subagent tool calls have no blocks of their own.
    approvalAnchorId: parent.ctx.approvalAnchorId ?? parent.ctx.currentToolUseId,
    // Intentionally NO `runner` — interactive tools fail inside the subagent.
    planMode: false,
    // Frente C — collector receives memos / snapshots / board posts from
    // the sub. The parent reads `collector.snapshot()` after the sub
    // finishes and appends it to the tool_result text.
    subagentCollector: collector,
  };

  // PR-6 (R23): when v2 is on, append the subagent-specific framing to the
  // domain-specific system prompt so the subagent inherits the persistence
  // + anti-rerun discipline. The active-context pointer is intentionally
  // omitted because subagents don't receive that injection.
  const v2Framing = parent.agentLoopV2
    ? (await import('@mcp/code-agent/core/system-prompt.js')).buildSubagentLoopFraming()
    : '';
  const finalSystemPrompt = spec.systemPrompt + v2Framing;

  const subRunner = new CoderRunner({
    provider: parent.provider,
    registry: subRegistry,
    systemPrompt: finalSystemPrompt,
    toolContext: subContext,
    initialMessages: spec.initialMessages,
    maxTurns: spec.maxTurns,
    pushTimeCap: spec.pushTimeCap ?? SUBAGENT_TOOL_RESULT_CAP,
    sessionId: parent.sessionId,
    isSubagent: true,
    // PR-6: subagent inherits the parent's v2 flag so pre-read cap, result-
    // dup cap, and exp+jitter retry apply inside the subagent loop too.
    agentLoopV2: parent.agentLoopV2,
    // Inherit the parent's "unrestricted tool output" toggle so the subagent's
    // `effectivePushTimeCap` is bumped to UNRESTRICTED_SUBAGENT_PUSH_TIME_CAP
    // (≈500 KB) instead of the default 12 KB when the parent session has the
    // toggle on. Coherent with the user intent: "this whole session is free."
    unrestrictedToolOutput: parent.ctx.unrestrictedToolOutput ?? false,
  });

  const abortRunner = () => subRunner.abort();
  if (parent.ctx.signal) {
    if (parent.ctx.signal.aborted) abortRunner();
    else parent.ctx.signal.addEventListener('abort', abortRunner, { once: true });
  }
  if (spec.signal) {
    if (spec.signal.aborted) abortRunner();
    else spec.signal.addEventListener('abort', abortRunner, { once: true });
  }

  // Propagate selected sub-runner events to the PARENT so the dashboard's
  // StuckBanner doesn't trip and the user sees progress for what would
  // otherwise be a black-box `spawn_agent` invocation. Mirrors the same
  // pattern `runParallelAgents` uses (tool_call_result → onProgress).
  //   - tool_progress: heartbeat from Camada 1/3/4 of the SUB's BT.
  //   - tool_call_result: per-call activity ping with a [subagent] prefix
  //     so the parent's Worker Log shows what the sub is doing.
  const parentEmit = parent.ctx.runner;
  subRunner.on('turn_start', (turn) => {
    currentTurn = typeof turn === 'number' ? turn : currentTurn + 1;
    markActivity('turn', `turn ${currentTurn}`);
  });
  subRunner.on('provider_call', (payload: { provider?: string; model?: string }) => {
    const provider = payload.provider ?? parent.provider.name;
    const model = payload.model ?? parent.provider.model;
    monitor.recordProviderCall(provider, model);
  });
  subRunner.on('text_delta', () => {
    markStreamActivity('text_delta', 'streaming text');
  });
  subRunner.on('thinking_delta', () => {
    markStreamActivity('thinking_delta', 'thinking');
  });
  subRunner.on('tool_call_start', (_id, name) => {
    lastToolName = name;
    monitor.recordSemantic('tool_call_start', `${name} started`, {
      toolName: name,
      lastToolName: name,
    });
  });
  subRunner.on('tool_progress', (payload) => {
    lastToolName = payload.name;
    monitor.recordToolProgress(payload.name, payload.note ?? payload.name);
    if (parentEmit) {
      parentEmit.emit('tool_progress', {
        ...payload,
        note: `[subagent] ${payload.note ?? payload.name}`,
      });
    }
  });
  // PR-C quality watchdog — hoisted so both tool_call_result and
  // message_complete handlers can mutate it. See block below where the
  // listener is wired for full context.
  const QUALITY_NO_TOOL_MAX = (() => {
    const raw = process.env.CODER_SUBAGENT_QUALITY_NO_TOOL_MAX;
    if (raw == null || raw === '') return 3;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 3;
  })();
  let consecutiveNoToolCount = 0;

  subRunner.on('tool_call_result', (_id, name) => {
    subToolCalls++;
    lastToolName = name;
    monitor.recordToolResult(name);
    // PR-C quality watchdog — any tool call resets the "no-tool streak".
    consecutiveNoToolCount = 0;
    if (parentEmit) {
      parentEmit.emit('tool_progress', {
        id: `subagent-tool:${subRunner.runId}:${subToolCalls}`,
        name: `subagent:${name}`,
        elapsedMs: 0,
        note: `[subagent] ${name} ✓ (#${subToolCalls})`,
      });
    }
    const maxToolCalls = limits.maxToolCalls;
    if (maxToolCalls != null && maxToolCalls > 0 && subToolCalls >= maxToolCalls) {
      failWatchdog(`task tool limit reached (${subToolCalls}/${maxToolCalls})`);
    }
  });

  // PR-C quality watchdog (forwarding variant). Codex tracks "agente
  // está falando muito sem chamar tool" via `should_compact_session`; we
  // approximate by counting assistant messages that have NO tool_use
  // block. A streak of N (default 3) is a strong signal the sub is
  // monologuing instead of acting — abort with a recognisable reason so
  // the parent's retry classifier flags it as transient.
  //
  // Reset to 0 on every tool_call_result (any tool execution = progress).
  // Env override: `CODER_SUBAGENT_QUALITY_NO_TOOL_MAX=N` (default 3,
  // 0 disables). State `QUALITY_NO_TOOL_MAX` and `consecutiveNoToolCount`
  // are declared above the tool_call_result handler so both listeners
  // can mutate them.
  subRunner.on('message_complete', (message) => {
    if (message.role !== 'assistant') return;
    const hasToolUse = Array.isArray(message.content)
      && message.content.some((b: { type?: string }) => b && typeof b === 'object' && b.type === 'tool_use');
    if (hasToolUse) {
      consecutiveNoToolCount = 0;
      return;
    }
    consecutiveNoToolCount++;
    // Surface the streak to the parent so dashboards can show a
    // "subagent monologuing" banner even before the watchdog fires.
    if (parentEmit) {
      parentEmit.emit('tool_progress', {
        id: `subagent-quality:${subRunner.runId}:${currentTurn}`,
        name: 'subagent:quality-watchdog',
        elapsedMs: Date.now() - startedAt,
        note: `[subagent] no_tool_streak=${consecutiveNoToolCount}/${QUALITY_NO_TOOL_MAX}`,
      });
    }
    if (QUALITY_NO_TOOL_MAX > 0 && consecutiveNoToolCount >= QUALITY_NO_TOOL_MAX) {
      failWatchdog(
        `subagent_quality_watchdog: ${consecutiveNoToolCount} consecutive turns without tool use`,
        'quality',
      );
    }
  });

  let result: { totalUsage: ChatUsage; reason: SubagentRunResult['reason'] };
  const watchdog = monitor;

  function handleWatchdogFailure(message: string, phase = 'limit'): void {
    if (watchdogFailed) return;
    watchdogFailed = true;
    watchdogPhase = phase;
    const now = Date.now();
    const snapshot = monitor.snapshot();
    try { subRunner.abort(); } catch { /* ignore */ }
    abortSubagent(message);
    spec.onProgress?.({
      event: 'heartbeat',
      toolCallCount: subToolCalls,
      toolName: lastToolName,
      note: message,
      phase,
      turn: currentTurn,
      elapsedMs: now - startedAt,
      stallMs: snapshot.semanticIdleMs,
      idleMs: snapshot.semanticIdleMs,
      deadlineMs: limits.timeoutMs,
      lastToolName,
      status: phase === 'aborted' ? 'aborted' : 'timed_out',
      limit: limits,
    });
  }
  abortFailure = (message) => handleWatchdogFailure(message, 'aborted');
  if (subAbort.signal.aborted) handleWatchdogFailure(lastAbortReason, 'aborted');

  function failWatchdog(message: string, phase = 'limit'): void {
    handleWatchdogFailure(message, phase);
    watchdog.fail(message, phase);
  }

  try {
    const runPromise = subRunner.run();
    runPromise.catch(() => {
      /* consumed by the race below or intentionally ignored after watchdog abort */
    });
    result = await Promise.race([runPromise, watchdog.promise]);
  } catch (e) {
    const collected = collector.snapshot();
    // Budget cutoffs ('limit' → tool_budget) and aborts are benign stops, not
    // crashes — only genuine anomalies stay 'error'. See phaseToReason.
    const reason = phaseToReason(watchdogPhase);
    if (watchdogFailed) {
      const salvaged = await buildSubagentSalvageSummary({
        provider: parent.provider,
        label: spec.label,
        reason: e instanceof Error ? e.message : String(e),
        messages: subRunner.messages,
        toolCallCount: subToolCalls,
        lastToolName,
        collected,
        sandboxViolations,
        parentSignal: parent.ctx.signal,
      });
      return {
        reason,
        finalText: salvaged.text,
        usage: salvaged.usage,
        sandboxViolations,
        collected,
      };
    }
    return {
      reason,
      finalText: e instanceof Error ? e.message : String(e),
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
      sandboxViolations,
      collected,
    };
  } finally {
    watchdog.cleanup();
    if (parent.ctx.signal) parent.ctx.signal.removeEventListener('abort', parentAbort);
    if (spec.signal) spec.signal.removeEventListener('abort', explicitAbort);
    if (parent.ctx.signal) parent.ctx.signal.removeEventListener('abort', abortRunner);
    if (spec.signal) spec.signal.removeEventListener('abort', abortRunner);
  }

  return {
    reason: result.reason,
    finalText: extractLastAssistantText(subRunner.messages),
    usage: result.totalUsage,
    sandboxViolations,
    collected: collector.snapshot(),
  };
}

/**
 * Read-only allowlist for the explore subagent (legacy `spawn_subagent`)
 * and for parallel agents spawned via `spawn_agents`. Includes MCP indexer
 * tools plus native read-only filesystem, web, and diagnostics tools.
 * Explicitly excludes mutating tools (write/edit/shell/git admin).
 */
export const EXPLORE_ALLOWLIST = new Set<string>([
  'mcp__get_project_pulse',
  'mcp__get_project_overview',
  'mcp__get_project_stats',
  'mcp__get_architecture',
  'mcp__list_directory',
  'mcp__list_projects',
  'mcp__get_recently_modified_files',
  'mcp__get_file_skeleton',
  'mcp__get_file_structure',
  'mcp__get_symbol_body',
  'mcp__get_symbol_details',
  'mcp__get_class_members',
  'mcp__get_dependencies',
  'mcp__get_dependents',
  'mcp__find_references',
  'mcp__find_implementations',
  'mcp__trace_usage',
  'mcp__get_hierarchy',
  'mcp__grep_code',
  'mcp__read_file',
  'mcp__search',
  'mcp__search_by_kind',
  'mcp__search_concepts',
  'mcp__query_snapshots',
  'mcp__search_memory',
  'mcp__get_context_for',
  'mcp__prepare_edit',
  // Native read-only filesystem
  'read_file',
  'list_directory',
  'glob',
  // Web (read-only external fetch)
  'web_fetch',
  'web_search',
  // Read-only diagnostics / LSP / git inspection
  'get_diagnostics',
  'lsp_definition',
  'lsp_references',
  'lsp_hover',
  'lsp_diagnostics',
  'git_status',
  'git_diff',
  'git_log',
  // Frente C — pre-approved write channels for subagents. Both are
  // additionally wrapped by `wrapToolForCollector` so any successful call
  // is mirrored into the parent's structured trail (the master sees the
  // memo / snapshot / deliverable post in the tool_result text without
  // needing to re-read the board or the snapshot store).
  'mcp__add_snapshot',
  'post_to_board',
]);

/**
 * Read-only filter — admits every name in `EXPLORE_ALLOWLIST` PLUS every
 * external MCP tool that doesn't mutate. The static allowlist alone misses
 * the user's installed MCP servers (`github_*`, `slack_*`, custom servers
 * registered at runtime); the predicate plugs them in based on the
 * `mutates` / source flags carried on each `CoderTool`.
 */
export const READ_ONLY_FILTER: (tool: CoderTool) => boolean = (tool) => {
  if (EXPLORE_ALLOWLIST.has(tool.name)) return true;
  if (tool.source === 'mcp_external') {
    // External MCPs default to `mutates: true` (conservative) when the
    // server didn't declare otherwise; only admit those that explicitly
    // self-declare as non-mutating.
    return tool.mutates === false;
  }
  return false;
};

/**
 * Read-write filter — `IMPLEMENT_ALLOWLIST` PLUS every external MCP tool,
 * mutating or not. The implement subagent is supposed to make changes
 * end-to-end so denying mutating MCPs would defeat the point.
 */
export const READ_WRITE_FILTER: (tool: CoderTool) => boolean = (tool) => {
  if (IMPLEMENT_ALLOWLIST.has(tool.name)) return true;
  // NOTE: implement does NOT blanket-inherit EXPLORE_ALLOWLIST (~41 read tools).
  // That made the implement registry ~50 tools when ~21 suffice. The reads an
  // implementer actually needs are listed directly in IMPLEMENT_ALLOWLIST.
  if (tool.source === 'mcp_external') return true;
  return false;
};

/**
 * Full-access filter — `null` means "no filter, inherit the parent
 * registry as-is". Use this for an unrestricted subagent that can call
 * every tool the parent has (every tier, every MCP, every native).
 */
export const FULL_ACCESS_FILTER: SubagentAllowlist = null;

/**
 * Verify filter — read tools + shell + LSP diagnostics, NO edit/write.
 * For `kind: 'verify'` tasks in execute_tasks: run tests, linters,
 * type-checkers, observe output, report findings. Cannot mutate code.
 */
export const VERIFY_FILTER: (tool: CoderTool) => boolean = (tool) => {
  if (EXPLORE_ALLOWLIST.has(tool.name)) return true;
  if (tool.name === 'run_command') return true;
  if (tool.name === 'get_diagnostics' || tool.name === 'lsp_diagnostics') return true;
  // MCP external tools that are explicitly non-mutating (test runners, linters
  // exposed via MCP).
  if (tool.source === 'mcp_external' && tool.mutates === false) return true;
  return false;
};

/**
 * Allowlist for an implementation subagent. Includes the read tools needed to
 * navigate the local file scope plus the mutating tools that actually carry
 * out the task. Notably absent: submit_plan, submit_tasks, ask_user,
 * spawn_subagent, execute_task, task_complete — subagents do not interact
 * with the user or recurse into other subagents.
 */
export const IMPLEMENT_ALLOWLIST = new Set<string>([
  // Read tools (essential subset of the explore allowlist)
  'mcp__read_file',
  'mcp__get_file_skeleton',
  'mcp__get_symbol_body',
  'mcp__grep_code',
  'mcp__find_references',
  'mcp__find_implementations',
  'mcp__list_directory',
  'mcp__get_dependencies',
  // Native filesystem reads (faster than MCP for paths the subagent owns)
  'read_file',
  'list_directory',
  'glob',
  // Mutating filesystem tools — the whole point of an implement subagent
  'write_file',
  'edit_file',
  'multi_edit',
  'create_file',
  'manage_path',
  // Shell — gated by the parent runner's plan-mode allowlist for read-only,
  // but inside an approved task scope the subagent gets the full set.
  'run_command',
  // Verify-its-own-work loop: diagnostics + the diff it just produced. These
  // were previously inherited via EXPLORE_ALLOWLIST (which dragged in ~30
  // explore-only reads); now listed explicitly so the implement registry
  // stays lean (~21 tools, was ~50) — see READ_WRITE_FILTER below.
  'get_diagnostics',
  'lsp_diagnostics',
  'git_status',
  'git_diff',
]);

/**
 * Format a TaskReference into a readable Markdown-style block for the
 * implement subagent's system prompt. Snippets get fenced code blocks; symbol
 * and file refs get a single line. Doc refs are dumped verbatim.
 */
function formatReference(r: TaskReference): string {
  let base: string;
  switch (r.type) {
    case 'symbol':
      base = `**Symbol**: \`${r.value}\``;
      break;
    case 'file':
      base = `**File reference**: \`${r.value}\` (read it via mcp__read_file or get_file_skeleton)`;
      break;
    case 'snippet':
      base = `**Snippet**:\n\n\`\`\`\n${r.value}\n\`\`\``;
      break;
    case 'doc':
      base = `**Doc**:\n${r.value}`;
      break;
    default:
      base = String(r);
  }
  const meta: string[] = [];
  if (r.file) meta.push(`file: \`${r.file}\``);
  if (r.lines) meta.push(`lines: ${r.lines}`);
  if (r.note) meta.push(r.note);
  if (meta.length) base += `\n  _${meta.join(' | ')}_`;
  return base;
}

function buildImplementSystemPrompt(task: CoderTask): string {
  const fileList = task.files.length > 0 ? task.files.map((f) => `- ${f}`).join('\n') : '(none declared)';
  const refs = (task.references && task.references.length > 0)
    ? task.references.map(formatReference).join('\n\n')
    : '(no references — work from the files in scope)';

  return `You are an IMPLEMENTATION subagent. The orchestrator delegated ONE specific task to you. Execute it end-to-end with the tools available, then stop.

# Your task
${task.title}

${task.description}

# Files in scope (you may read AND write these)
${fileList}

# Curated references the orchestrator pre-extracted
${refs}

# Rules
1. Stay inside the files listed above. Reading other files is allowed but logged as a sandbox warning that the orchestrator will see.
2. Make the changes, then VERIFY them when appropriate (run tests/build/lint via run_command).
3. STOP when the task is done. Do not start adjacent work even if you notice opportunities.
4. Your LAST assistant message MUST contain a JSON block in this exact format:
   \`\`\`
   <result>{"summary": "<≤200 chars: what was done>", "files_modified": ["path1", "path2"], "errors": "<only on failure>"}</result>
   \`\`\`
   The orchestrator parses this. If the block is absent or unparseable, the task is treated as failed.
5. You CANNOT call submit_plan, submit_tasks, ask_user, spawn_agent, execute_task, or task_complete. You answer only to the orchestrator via your final <result> block.
6. Be terse. Don't narrate every file read — just do the work and report.

# Token economy
Prefer get_file_skeleton + get_symbol_body over read_file of whole files. Use grep_code/find_references for navigation. Avoid re-reading files you already read this turn.`;
}

/**
 * High-level entry point for executing a single CoderTask in an isolated
 * implementation subagent. Builds the system prompt + initial message, calls
 * runSubagent, and parses the final `<result>` block into a TaskResult.
 */
export async function runImplementSubagent(parent: SubagentParent, task: CoderTask): Promise<TaskResult> {
  const systemPrompt = buildImplementSystemPrompt(task);
  if (parent.sessionStore && parent.sessionId != null) {
    try {
      parent.sessionStore.recordSessionInput({
        session_id: parent.sessionId,
        kind: 'subagent_prompt',
        source_label: `subagent:implement:${task.id}`,
        content: systemPrompt,
        meta: {
          task_id: task.id,
          task_title: task.title,
          files: task.files,
          complexity: task.estimated_complexity,
        },
      });
    } catch {
      // best-effort
    }
  }
  const initialMessages: AgentMessage[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `Begin the task now. When done, output your final <result> block as instructed. ` +
            `Reminder: stay inside the files listed in the system prompt.`,
        },
      ],
    },
  ];

  const result = await runSubagent(parent, {
    systemPrompt,
    allowlist: IMPLEMENT_ALLOWLIST,
    initialMessages,
    // Implement subagents need more turns than explore — they read, edit,
    // verify, and report. 40 gives realistic margin for non-trivial tasks.
    // Override via CODER_IMPLEMENT_MAX_TURNS.
    maxTurns: Number(process.env.CODER_IMPLEMENT_MAX_TURNS ?? 40),
    pathScope: task.files,
  });

  const parsed = parseResultBlock(result.finalText);
  if (parsed) {
    return {
      summary: parsed.summary || '(subagent returned an empty summary)',
      files_modified: parsed.files_modified ?? [],
      errors: parsed.errors,
      sandbox_violations: result.sandboxViolations.length > 0 ? result.sandboxViolations : undefined,
      subagent_usage: result.usage as unknown as Record<string, number | undefined>,
    };
  }

  // No structured result — surface what we can so the orchestrator gets
  // actionable info instead of a silent "failed".
  return {
    summary: 'subagent did not return a structured <result> block',
    files_modified: [],
    errors: result.finalText
      ? `subagent reason=${result.reason}. Last assistant text: ${result.finalText.slice(0, 400)}`
      : `subagent reason=${result.reason}; produced no text output`,
    sandbox_violations: result.sandboxViolations.length > 0 ? result.sandboxViolations : undefined,
    subagent_usage: result.usage as unknown as Record<string, number | undefined>,
  };
}

/**
 * Permissive parser for the subagent's `<result>{...}</result>` JSON block.
 * Tries the strict pattern first, then falls back to JSON-parsing the whole
 * final text in case the model forgot the wrapper.
 */
function parseResultBlock(finalText: string): { summary: string; files_modified?: string[]; errors?: string } | null {
  if (!finalText) return null;
  // Strict: <result>{...}</result>
  const match = finalText.match(/<result>([\s\S]*?)<\/result>/);
  if (match) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed && typeof parsed === 'object' && typeof parsed.summary === 'string') {
        return parsed as { summary: string; files_modified?: string[]; errors?: string };
      }
    } catch {
      /* fall through */
    }
  }
  // Permissive: try parsing the whole text as JSON.
  try {
    const parsed = JSON.parse(finalText.trim());
    if (parsed && typeof parsed === 'object' && typeof parsed.summary === 'string') {
      return parsed as { summary: string; files_modified?: string[]; errors?: string };
    }
  } catch {
    /* fall through */
  }
  // Last resort: search for a JSON object that has a "summary" key anywhere.
  const objMatch = finalText.match(/\{[\s\S]*?"summary"[\s\S]*?\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (parsed && typeof parsed.summary === 'string') {
        return parsed as { summary: string; files_modified?: string[]; errors?: string };
      }
    } catch {
      /* fall through */
    }
  }
  return null;
}

/**
 * Frente C — when the sub calls `mcp__add_snapshot` or
 * `post_to_board` we tee the success into the parent's collector so the
 * master sees a structured trail in addition to the final assistant text.
 *
 * Only mirrors on a successful invocation. The wrap is name-keyed so any
 * other tool passes through untouched. Errors during the mirror step are
 * swallowed — the underlying tool's result already went out and we don't
 * want telemetry to mask a real failure.
 *
 * `post_to_board` is filtered to the "deliverable" / "decision" /
 * "handoff" kinds — routine `message` posts would flood the parent with
 * chit-chat the master doesn't need.
 */
function wrapToolForCollector(
  tool: CoderTool,
  collector: import('@mcp/code-agent/tools/subagent-collector.js').SubagentCollector,
): CoderTool {
  if (tool.name === 'mcp__add_snapshot') {
    return {
      ...tool,
      handler: async (args, ctx): Promise<ToolResult> => {
        const result = await tool.handler(args, ctx);
        if (!result.isError) {
          try {
            const category = typeof args.category === 'string' ? args.category : 'general';
            const body = typeof args.body === 'string'
              ? args.body
              : typeof args.content === 'string'
                ? (args.content as string)
                : '';
            // Snapshot id is typically embedded in the tool's response text
            // (e.g. "Snapshot created (id=ABC123)"). Try to extract; fall
            // back to a deterministic placeholder.
            const idMatch = /id[=:]\s*([A-Za-z0-9_-]+)/.exec(result.content) ?? null;
            const id = idMatch ? idMatch[1] : `snap-${Date.now().toString(36)}`;
            collector.recordSnapshot(id, category, body);
          } catch {
            /* swallow — never let mirror failure surface as tool error */
          }
        }
        return result;
      },
    };
  }
  if (tool.name === 'post_to_board') {
    return {
      ...tool,
      handler: async (args, ctx): Promise<ToolResult> => {
        const result = await tool.handler(args, ctx);
        if (!result.isError) {
          try {
            const kind = typeof args.kind === 'string' ? (args.kind as string) : 'message';
            // Only mirror the kinds the master genuinely needs to see
            // post-hoc. Routine `message` posts stay on the board only.
            if (kind === 'deliverable' || kind === 'decision' || kind === 'handoff' || kind === 'blocker') {
              const content = typeof args.content === 'string' ? (args.content as string) : '';
              collector.recordBoardPost(kind, content);
            }
          } catch {
            /* swallow */
          }
        }
        return result;
      },
    };
  }
  return tool;
}

/**
 * Wrap a tool's handler so any path arguments outside `pathScope` are
 * recorded into `violations` (and the call still proceeds — warning mode).
 *
 * We don't touch the parent's tool object — return a clone with a new handler.
 */
function wrapToolForPathScope(tool: CoderTool, pathScope: string[], violations: string[]): CoderTool {
  const fsOrShellTools = new Set([
    'write_file',
    'edit_file',
    'create_file',
    'manage_path',
    'read_file',
    'mcp__read_file',
    'run_command',
  ]);
  if (!fsOrShellTools.has(tool.name)) return tool;

  return {
    ...tool,
    handler: async (args, ctx): Promise<ToolResult> => {
      const paths = extractPathsFromToolArgs(tool.name, args);
      for (const p of paths) {
        if (!isPathInsideScope(p, pathScope)) {
          violations.push(`${tool.name}:${p}`);
        }
      }
      return tool.handler(args, ctx);
    },
  };
}

// ─── parallel agents ──────────────────────────────────────────

const PARALLEL_AGENT_MAX = Number(process.env.CODER_PARALLEL_AGENT_MAX ?? 5);

export interface ParallelAgentSpec {
  task: string;
  label: string;
  maxTurns: number;
  /**
   * Per-agent overrides — fall back to the global `systemPrompt` /
   * `allowlist` passed to `runParallelAgents` when omitted. Lets a single
   * parallel batch mix `explore` and `implement` (and even `full`) agents.
   */
  systemPrompt?: string;
  allowlist?: SubagentAllowlist;
  pathScope?: string[];
  limits?: SubagentLimits;
  signal?: AbortSignal;
}

export interface ParallelAgentProgress {
  agentIndex: number;
  label: string;
  event: 'spawned' | 'heartbeat' | 'tool_call' | 'completed' | 'error' | 'timed_out' | 'aborted';
  status?: 'pending' | 'running' | 'completed' | 'error' | 'timed_out' | 'aborted';
  provider?: string;
  model?: string;
  toolCallCount?: number;
  note?: string;
  phase?: string;
  turn?: number;
  elapsedMs?: number;
  stallMs?: number;
  idleMs?: number;
  deadlineMs?: number;
  lastToolName?: string;
  limit?: SubagentLimits;
  usage?: ChatUsage;
  summary?: string;
  error?: string;
}

export type ParallelAgentResult = SubagentRunResult & { label: string; toolCallCount: number };

function classifySubagentTerminal(
  reason: SubagentRunResult['reason'],
  text: string,
): {
  event: ParallelAgentProgress['event'];
  status: NonNullable<ParallelAgentProgress['status']>;
} {
  if (reason === 'completed') return { event: 'completed', status: 'completed' };
  if (reason === 'aborted') return { event: 'aborted', status: 'aborted' };
  // Benign budget cutoff — show as a soft terminal in the parallel timeline,
  // not an error.
  if (reason === 'tool_budget') return { event: 'timed_out', status: 'timed_out' };
  const lower = text.toLowerCase();
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('stalled')) {
    return { event: 'timed_out', status: 'timed_out' };
  }
  return { event: 'error', status: 'error' };
}

/**
 * Run N subagents in parallel with a concurrency limiter. Each agent gets its
 * own isolated CoderRunner and message history. Progress events are emitted
 * via `onProgress` so the UI can show real-time updates.
 */
export async function runParallelAgents(
  parent: SubagentParent,
  agents: ParallelAgentSpec[],
  systemPrompt: string,
  allowlist: SubagentAllowlist,
  onProgress: (p: ParallelAgentProgress) => void,
  concurrency?: number,
): Promise<{ results: ParallelAgentResult[]; totalUsage: ChatUsage }> {
  const limit = Math.min(agents.length, concurrency ?? PARALLEL_AGENT_MAX);
  const results: ParallelAgentResult[] = new Array(agents.length);

  const tasks = agents.map((spec, agentIndex) => async () => {
    onProgress({ agentIndex, label: spec.label, event: 'spawned', status: 'running' });

    let toolCallCount = 0;

    try {
      const runResult = await runSubagent(parent, {
        systemPrompt: spec.systemPrompt ?? systemPrompt,
        label: spec.label,
        allowlist: spec.allowlist ?? allowlist,
        initialMessages: [{ role: 'user', content: [{ type: 'text', text: spec.task }] }],
        maxTurns: spec.maxTurns,
        pushTimeCap: SUBAGENT_TOOL_RESULT_CAP,
        pathScope: spec.pathScope,
        limits: spec.limits,
        signal: spec.signal,
        onProgress: (progress) => {
          toolCallCount = progress.toolCallCount;
          onProgress({
            agentIndex,
            label: spec.label,
            event: progress.event,
            toolCallCount,
            note: progress.note,
            phase: progress.phase,
            turn: progress.turn,
            elapsedMs: progress.elapsedMs,
            stallMs: progress.stallMs,
            idleMs: progress.idleMs,
            deadlineMs: progress.deadlineMs,
            lastToolName: progress.lastToolName ?? progress.toolName,
            status: progress.status ?? 'running',
            limit: progress.limit,
          });
        },
      });
      const finalText = runResult.finalText;
      const agentResult: ParallelAgentResult = {
        reason: runResult.reason,
        finalText,
        usage: runResult.usage,
        sandboxViolations: runResult.sandboxViolations,
        collected: runResult.collected ?? emptyCollected(),
        label: spec.label,
        toolCallCount,
      };
      const terminal = classifySubagentTerminal(runResult.reason, finalText);
      onProgress({
        agentIndex,
        label: spec.label,
        event: terminal.event,
        status: terminal.status,
        toolCallCount,
        usage: runResult.usage,
        summary: finalText.slice(0, 500),
        error: terminal.status === 'completed' ? undefined : finalText.slice(0, 500),
      });
      return agentResult;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      const agentResult: ParallelAgentResult = {
        reason: 'error',
        finalText: errMsg,
        usage: { input_tokens: 0, output_tokens: 0 },
        sandboxViolations: [],
        collected: emptyCollected(),
        label: spec.label,
        toolCallCount,
      };
      const terminal = classifySubagentTerminal('error', errMsg);
      onProgress({ agentIndex, label: spec.label, event: terminal.event, status: terminal.status, error: errMsg });
      return agentResult;
    }
  });

  // Heartbeat — keep the parent's StuckBanner alive while subagents are
  // mid-stream. Without this, the master goes silent during any window
  // where every sub is awaiting its provider response (no tool_call_result
  // bubbles up → no agent_progress → no SSE event → StuckBanner trips
  // around 30s). Period chosen well below the 30s threshold.
  const HEARTBEAT_MS = Number(process.env.CODER_PARALLEL_HEARTBEAT_MS ?? '15000') || 15_000;
  const startedAt = Date.now();
  const heartbeatTimer = setInterval(() => {
    // Use `tool_progress` on the PARENT runner — same channel the dashboard
    // already monitors for "still working" feedback during long tools.
    parent.ctx.runner?.emit('tool_progress', {
      id: 'spawn_agent',
      name: 'spawn_agent',
      elapsedMs: Date.now() - startedAt,
      note: `${agents.length} parallel agents still running`,
    });
    parent.ctx.reportProgress?.(`${agents.length} parallel agents still running`);
  }, HEARTBEAT_MS);

  // Run with concurrency limit. Heartbeat cleanup MUST happen even on throw.
  let settled: PromiseSettledResult<ParallelAgentResult>[];
  try {
    settled = await withConcurrencyLimit(tasks, limit);
  } finally {
    clearInterval(heartbeatTimer);
  }

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;

  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === 'fulfilled') {
      results[i] = s.value;
      totalInput += s.value.usage.input_tokens;
      totalOutput += s.value.usage.output_tokens;
      totalCacheRead += s.value.usage.cache_read_input_tokens ?? 0;
      totalCacheCreation += s.value.usage.cache_creation_input_tokens ?? 0;
    } else {
      // Should not happen — errors are caught inside the task.
      const errMsg = s.reason instanceof Error ? s.reason.message : String(s.reason);
      results[i] = {
        reason: 'error',
        finalText: errMsg,
        usage: { input_tokens: 0, output_tokens: 0 },
        sandboxViolations: [],
        collected: emptyCollected(),
        label: agents[i].label,
        toolCallCount: 0,
      };
    }
  }

  return {
    results,
    totalUsage: {
      input_tokens: totalInput,
      output_tokens: totalOutput,
      cache_read_input_tokens: totalCacheRead,
      cache_creation_input_tokens: totalCacheCreation,
    },
  };
}

/**
 * Execute async tasks with a concurrency limit. Uses a simple worker-pool
 * pattern — no external dependencies.
 */
async function withConcurrencyLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < tasks.length) {
      const i = nextIndex++;
      try {
        const value = await tasks[i]();
        results[i] = { status: 'fulfilled', value };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

// ─── shared helpers ────────────────────────────────────────────

/**
 * Walk the message history backwards and return the most recent assistant
 * message that contains a non-empty text block. Returns '' if none.
 *
 * Exported because both `spawn_subagent` (legacy) and the new
 * `runImplementSubagent` need to extract the final summary text.
 */
export function extractLastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const parts: string[] = [];
    for (const b of m.content) {
      if (b.type === 'text' && b.text.trim().length > 0) parts.push(b.text);
    }
    if (parts.length > 0) return parts.join('\n');
  }
  return '';
}
