import { EventEmitter } from 'node:events';
import { resolve as pathResolve, relative as pathRelative, isAbsolute } from 'node:path';
import type { ChatProvider } from '../providers/adapter.js';
import type { ToolRegistry } from './registry.js';
import type { AgentMessage, ChatDelta, ChatUsage, ContentBlock, ToolUseBlock, PlanBlock, QuestionBlock, ToolResultBlock } from './messages.js';
import type { ToolContext } from './tool.js';
import {compactMessages, PRUNE_PROTECT, computeCutoffIndex, totalChars, PRUNE_MINIMUM, snapCutoffToRoleBoundary} from "./compaction.js";
import { isSummarizerEnabled, summarizeSpan, renderSummary } from './summarizer.js';
import { filterByTiers, profileToTiers, type ToolTier, type CoderProfile } from '../tools/tiers.js';
import { getModelMaxTools, getModelCapabilityNote } from '../providers/capabilities.js';
import { runToolFilterHook } from './hooks.js';

export interface RunnerOptions {
  provider: ChatProvider;
  registry: ToolRegistry;
  systemPrompt: string;
  toolContext: ToolContext;
  initialMessages?: AgentMessage[];
  maxTurns?: number;
  /** Plan mode: agent must call submit_plan and get approval before mutating tools. */
  planMode?: boolean;
  /** Override the per-tool-result push-time cap. Subagents pass a tighter value. */
  pushTimeCap?: number;
  /**
   * Initial set of active tool tiers. When set, the runner filters its tools
   * array each turn to only those whose tier is active. The agent can unlock
   * higher tiers mid-session via the `expand_toolset` tool. Default: all
   * tiers active (backwards-compatible behaviour, no filtering).
   */
  activeTiers?: Set<ToolTier>;
  /**
   * Profile shorthand — expanded into `activeTiers` if `activeTiers` is not
   * explicitly set. 'bootstrap' only exposes the ~13 essential tools on the
   * first turn; 'navigate' adds edit/git read/local nav; 'full' adds admin.
   */
  profile?: CoderProfile;
  /** Tools globally disabled via admin panel. Applied before tier filtering. */
  globalDisabledTools?: ReadonlySet<string>;
  /** Tools disabled for this specific session. Applied before tier filtering. */
  sessionDisabledTools?: ReadonlySet<string>;
  /**
   * Runtime tier overrides for external MCP tools. Maps tool name (e.g.
   * `ext_github__create_issue`) to its tier. Passed through to filterByTiers
   * so external tools respect tier filtering without polluting the static Sets.
   */
  externalToolTiers?: ReadonlyMap<string, ToolTier>;
}

// Tools blocked outright in plan mode until the user approves a submitted
// plan. `run_command` is intentionally NOT here — it has its own granular
// gate inside src/coder/tools/shell.ts that allows the read-only subset
// (grep, ls, git status, ...) so the agent can explore during planning
// without losing the ability to run mutating commands after approval.
const MUTATING_TOOLS = new Set([
  'write_file',
  'edit_file',
  'create_file',
  'git_add',
  'git_commit',
  'git_branch',
]);

/**
 * Tunables (env-overridable for runtime tuning without rebuild).
 *
 * Frente A redesign: elision is now MONOTONE — applied at push-time with a
 * deterministic marker. Once a block is truncated, its content never changes
 * across turns, which keeps the prompt prefix bit-stable and lets the
 * server-side prompt cache (ZAI/GLM auto cache + Anthropic ephemeral) hit
 * reliably from turn 2 onward.
 *
 * The legacy sliding-window logic (KEEP_LAST_TOOL_TURNS, HARD_CAP_CHARS) is
 * removed because it mutated old blocks every turn, busting the cache.
 */
const PUSH_TIME_CAP = Number(process.env.CODER_PUSH_TIME_CAP ?? 8_000);
/** Tighter per-block cap used inside subagents — they accumulate many small
 *  tool results in a short window, so a 4k cap fits ~10 turns under the budget. */
const SUBAGENT_PUSH_TIME_CAP = Number(process.env.CODER_SUBAGENT_PUSH_TIME_CAP ?? 4_000);
/** Per-turn safety budget — emits a warning when the about-to-send payload exceeds this. */
const TURN_BUDGET_CHARS = Number(process.env.CODER_TURN_BUDGET_CHARS ?? 30_000);
/**
 * Doom-loop guard: if the model emits the exact same set of tool calls this
 * many turns in a row, abort the run. Prevents cost blowups when a model
 * latches onto a failing tool call and keeps retrying it verbatim. Set to 0
 * (or any N<2) to disable. Default 3 matches opencode's processor.ts.
 */
const DOOM_LOOP_THRESHOLD = Number(process.env.CODER_DOOM_LOOP_THRESHOLD ?? 3);
/**
 * Auto-continue: when the runner exhausts maxTurns, instead of dying it
 * compacts the history (summarizer → deterministic fallback) and resets the
 * turn counter. This mirrors Claude Code's behaviour where the agent never
 * stops due to turn limits alone — only due to lack of work or explicit abort.
 * Set to 0 to disable (legacy hard-stop at maxTurns).
 */
const MAX_AUTO_CONTINUES = Number(process.env.CODER_MAX_AUTO_CONTINUES ?? 3);

/**
 * Deterministic signature of a turn's tool calls. Two turns with the same
 * signature asked the model to do literally the same thing — if that repeats
 * past the threshold, we're looping. Keys in each input object are sorted so
 * cosmetic reordering doesn't mask the repetition.
 */
export function toolCallsSignature(
  blocks: Array<{ name: string; input: Record<string, unknown> }>,
): string {
  if (blocks.length === 0) return '';
  const stable = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(stable);
    const keys = Object.keys(v as Record<string, unknown>).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = stable((v as Record<string, unknown>)[k]);
    return out;
  };
  const items = blocks
    .map((b) => `${b.name}:${JSON.stringify(stable(b.input))}`)
    .sort();
  return items.join('|');
}

export function approxChars(messages: AgentMessage[]): number {
  let total = 0;
  for (const m of messages) {
    for (const b of m.content) {
      total += 32; // per-block overhead estimate
      if (typeof (b as { content?: unknown }).content === 'string') {
        total += ((b as { content: string }).content).length;
      }
      if (typeof (b as { text?: unknown }).text === 'string') {
        total += ((b as { text: string }).text).length;
      }
      if (typeof (b as { input?: unknown }).input === 'object' && (b as { input?: unknown }).input) {
        try { total += JSON.stringify((b as { input: unknown }).input).length; } catch { /* ignore */ }
      }
    }
  }
  return total;
}

/**
 * Build a tool_result block, applying push-time truncation if the content
 * exceeds PUSH_TIME_CAP. The truncation marker is deterministic — it depends
 * only on the original size, not on the current turn or surrounding context —
 * so once a block is created it never changes.
 */
export function buildToolResultBlock(
  toolUseId: string,
  content: string,
  isError?: boolean,
  cap: number = PUSH_TIME_CAP,
  outputId?: string,
): ToolResultBlock {
  if (content.length <= cap) {
    return { type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError };
  }
  const head = content.slice(0, cap);
  // Deterministic marker. Two identical outputs → identical marker (same
  // original_size, same outputId because the store hashes content). Once a
  // block is created, its content never changes across turns — preserves
  // prefix-cache stability.
  const idSuffix = outputId
    ? `; output_id=${outputId}, call get_tool_output("${outputId}") to retrieve the full content`
    : '';
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content:
      head +
      `\n\n[truncated: original_size=${content.length} chars; ${content.length - cap} chars elided — call the tool again with narrower params if needed, OR explicitly use 'spawn_agents' to delegate this exploration without bloating your main context window${idSuffix}]`,
    is_error: isError,
    truncated: true,
    originalSize: content.length,
  };
}

/** Cap value used by subagents (tighter than parent default). */
export const SUBAGENT_TOOL_RESULT_CAP = SUBAGENT_PUSH_TIME_CAP;

/**
 * Normalize a message coming from the DB on session resume. Older sessions
 * may contain un-truncated tool_result blocks that would otherwise pollute
 * the cache prefix. Re-applying buildToolResultBlock() yields the same
 * deterministic shape used by fresh sessions.
 */
export function normalizeMessageForCache(m: AgentMessage): AgentMessage {
  if (m.role !== 'tool' && m.role !== 'user') return m;
  let mutated = false;
  const content = m.content.map((b): ContentBlock => {
    if (b.type !== 'tool_result') return b;
    if (b.truncated) return b; // already deterministic, leave alone
    if (b.content.length <= PUSH_TIME_CAP) return b;
    mutated = true;
    return buildToolResultBlock(b.tool_use_id, b.content, b.is_error);
  });
  return mutated ? { ...m, content } : m;
}

/**
 * Per-turn history transformer applied right before the request hits the
 * provider. Two-layer strategy:
 *
 *   1. Push-time truncation (already done at block creation) keeps the
 *      PER-BLOCK size bounded, which is enough for 99% of sessions.
 *
 *   2. Auto-compaction (delegated to core/compaction.ts) kicks in ONLY when
 *      the accumulated total still exceeds PRUNE_MINIMUM, at which point
 *      older tool_result contents get swapped for deterministic markers
 *      until the protected tail fits under PRUNE_PROTECT.
 *
 * The compaction is a pure transformation — the persistent history on disk
 * stays intact — and uses a deterministic cutoff so repeated calls on the
 * same prefix produce byte-identical output. That keeps prompt-prefix caches
 * hot across turns even after compaction has fired.
 */
export function compactHistoryForLLM(messages: AgentMessage[]): AgentMessage[] {
  const result = compactMessages(messages);
  if (result.applied) {
    console.log(
        `[coder] compaction pruned ${result.prunedBlocks} tool_result blocks ` +
        `(~${result.prunedChars} chars) — protect budget ${PRUNE_PROTECT}`,
    );
  }
  const total = approxChars(result.messages);
  if (total > TURN_BUDGET_CHARS) {
    console.warn(
        `[coder] turn payload ${total} chars exceeds budget ${TURN_BUDGET_CHARS}. ` +
        `Lower CODER_PUSH_TIME_CAP or increase CODER_TURN_BUDGET_CHARS.`,
    );
  }

  // Safety net: remove orphaned tool_results whose tool_use was dropped
  // (e.g. by a prior summarizer splice). Without this, the provider rejects
  // the request with "400 No tool call found for function call output".
  const knownToolUseIds = new Set<string>();
  for (const m of result.messages) {
    if (m.role !== 'assistant') continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') knownToolUseIds.add(b.id);
    }
  }
  let orphanCount = 0;
  const sanitized = result.messages.map((m): AgentMessage | null => {
    if (m.role !== 'tool') return m;
    const filtered = m.content.filter((b) => {
      if (b.type !== 'tool_result') return true;
      const tid = (b as { tool_use_id?: string }).tool_use_id;
      if (tid && !knownToolUseIds.has(tid)) {
        orphanCount++;
        return false;
      }
      return true;
    });
    if (filtered.length === 0) return null;
    if (filtered.length === m.content.length) return m;
    return { ...m, content: filtered };
  }).filter((m): m is AgentMessage => m !== null);

  if (orphanCount > 0) {
    console.warn(
      `[coder] sanitized ${orphanCount} orphaned tool_result block(s) ` +
      `whose tool_use was removed by summarization`,
    );
  }

  // Safety net 2: inject synthetic tool_result for orphaned tool_use blocks
  // (tool_use exists in assistant message but no matching tool_result in any
  // tool message). This happens when the runner crashes/aborts between
  // persisting the assistant message and persisting the tool result message.
  // Without this, the provider rejects with
  // "400 No tool output found for function call".
  const knownToolResultIds = new Set<string>();
  for (const m of sanitized) {
    if (m.role !== 'tool') continue;
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const tid = (b as { tool_use_id?: string }).tool_use_id;
        if (tid) knownToolResultIds.add(tid);
      }
    }
  }

  let syntheticCount = 0;
  const patched: AgentMessage[] = [];
  for (let i = 0; i < sanitized.length; i++) {
    const m = sanitized[i];
    patched.push(m);
    if (m.role !== 'assistant') continue;

    const orphanedToolUses: Array<{ id: string; name: string }> = [];
    for (const b of m.content) {
      if (b.type === 'tool_use' && !knownToolResultIds.has(b.id)) {
        orphanedToolUses.push({ id: b.id, name: b.name });
      }
    }
    if (orphanedToolUses.length === 0) continue;

    // Check if the very next message is already a tool message that covers
    // some of these IDs (partial coverage). Only inject for truly missing ones.
    const next = sanitized[i + 1];
    if (next?.role === 'tool') {
      const coveredIds = new Set<string>();
      for (const b of next.content) {
        if (b.type === 'tool_result') {
          const tid = (b as { tool_use_id?: string }).tool_use_id;
          if (tid) coveredIds.add(tid);
        }
      }
      const stillOrphaned = orphanedToolUses.filter((tu) => !coveredIds.has(tu.id));
      if (stillOrphaned.length === 0) continue;

      // Merge synthetic results into the existing tool message
      const syntheticResults = stillOrphaned.map((tu) => ({
        type: 'tool_result' as const,
        tool_use_id: tu.id,
        content: `[Session interrupted — tool "${tu.name}" was running when the session ended. Result was not captured.]`,
        is_error: true,
      }));
      // Replace next message with merged version
      sanitized[i + 1] = { ...next, content: [...next.content, ...syntheticResults] };
      syntheticCount += stillOrphaned.length;
    } else {
      // No tool message follows — inject a new one
      const syntheticResults = orphanedToolUses.map((tu) => ({
        type: 'tool_result' as const,
        tool_use_id: tu.id,
        content: `[Session interrupted — tool "${tu.name}" was running when the session ended. Result was not captured.]`,
        is_error: true,
      }));
      patched.push({ role: 'tool' as const, content: syntheticResults });
      // Skip the next message if it was already pushed (it wasn't a tool msg)
      syntheticCount += orphanedToolUses.length;
    }
  }

  const resultArray = syntheticCount > 0 ? patched : sanitized;

  // Merge consecutive same-role messages to avoid 400 "The messages parameter
  // is illegal" from providers that strictly require alternating turns.
  // User merges: classic Anthropic requirement.
  // Assistant merges: happens after summarizer splice when the synthetic
  // assistant is followed by an original assistant (GLM error 1214).
  const merged: AgentMessage[] = [];
  for (const m of resultArray) {
    const last = merged[merged.length - 1];
    if (last && last.role === 'user' && m.role === 'user') {
      last.content = [...last.content, ...m.content];
    } else if (last && last.role === 'assistant' && m.role === 'assistant') {
      last.content = [...last.content, ...m.content];
    } else {
      merged.push({ ...m, content: [...m.content] });
    }
  }

  if (syntheticCount > 0) {
    console.warn(
      `[coder] injected ${syntheticCount} synthetic tool_result(s) for orphaned ` +
      `tool_use blocks (session was interrupted mid-tool-execution)`,
    );
  }

  return merged;
}

/**
 * Events emitted by the runner. CLI and SSE handler both consume these.
 */
export interface RunnerEvents {
  text_delta: (text: string) => void;
  tool_call_start: (id: string, name: string, input: Record<string, unknown>) => void;
  tool_call_result: (id: string, name: string, result: { content: string; isError?: boolean; subUsage?: ChatUsage }, durationMs: number) => void;
  message_complete: (message: AgentMessage, usage: ChatUsage | null) => void;
  turn_start: (turn: number) => void;
  done: (reason: 'completed' | 'max_turns' | 'aborted' | 'error' | 'plan_required', error?: Error) => void;
  /** Emitted when the agent calls submit_plan; payload waits for /plan-response. */
  plan_posted: (block: PlanBlock) => void;
  /** Emitted when the agent calls ask_user; payload waits for /answer. */
  question_posted: (block: QuestionBlock) => void;
  /** Emitted when provider/model is swapped mid-session. */
  provider_swapped: (provider: string, model: string) => void;
  /** Emitted by submit_tasks; payload is the proposed task list waiting for /tasks-response. */
  tasks_posted: (payload: {
    tool_use_id: string;
    summary: string;
    tasks: import('../sessions/types.js').CoderTask[];
    version: number;
  }) => void;
  /** Emitted when execute_task starts processing a single task. */
  task_started: (payload: { task_id: string; mode: 'inline' | 'subagent'; started_at: string }) => void;
  /** Emitted when a task finishes (done/failed/skipped/interrupted). */
  task_finished: (payload: {
    task_id: string;
    status: import('../sessions/types.js').TaskStatus;
    result: import('../sessions/types.js').TaskResult | null;
    finished_at: string;
  }) => void;
  /** Emitted when `todo_write` replaces the session's lightweight checklist. */
  todos_updated: (payload: {
    todos: import('../tools/todo.js').TodoItem[];
  }) => void;
  /** Emitted when `enter_worktree` swaps the session cwd for a worktree. */
  worktree_entered: (payload: { path: string; originalCwd: string }) => void;
  /** Emitted when `exit_worktree` restores the session cwd to the project root. */
  worktree_exited: (payload: { path: string }) => void;
  /** Emitted when spawn_agents starts a parallel agent group. */
  agents_group_start: (payload: {
    groupId: string;
    agents: Array<{ index: number; label: string }>;
  }) => void;
  /** Emitted for per-agent progress within a parallel group. */
  agent_progress: (payload: {
    groupId: string;
    agentIndex: number;
    label: string;
    event: 'spawned' | 'tool_call' | 'completed' | 'error';
    toolCallCount?: number;
    usage?: ChatUsage;
    summary?: string;
    error?: string;
  }) => void;
  /** Emitted when all agents in a parallel group have finished. */
  agents_group_end: (payload: {
    groupId: string;
    totalUsage: ChatUsage;
    agentCount: number;
    successCount: number;
  }) => void;
  /** Emitted when the runner auto-continues after hitting maxTurns. */
  auto_continue: (count: number, max: number) => void;
  /** Emitted per-turn with context size metrics for the dashboard. */
  context_status: (payload: {
    history_chars: number;
    turn: number;
    max_turns: number;
    auto_continue_count: number;
    auto_continue_max: number;
  }) => void;
}

/**
 * Turn-based agent loop:
 *   1. Stream provider response, collecting text + tool_use blocks
 *   2. Persist the assistant message
 *   3. For each tool_use, execute via registry, append tool_result
 *   4. Loop until the assistant returns no tool calls (or max_turns)
 */
export class CoderRunner extends EventEmitter {
  readonly messages: AgentMessage[];
  private opts: RunnerOptions;
  private readonly maxTurns: number;
  private aborted = false;
  private pendingResolve: ((value: string) => void) | null = null;
  private planApproved = false;
  /**
   * Plan-mode enforcement: when the model finishes a turn (no tool calls)
   * without ever calling submit_plan, the runner injects ONE explicit nudge
   * and re-runs the loop. If the second turn also exits without a plan, the
   * run fails with reason='plan_required'. Reset on each runCoder() call
   * because a fresh runner is instantiated per user message.
   */
  /**
   * Set to true once the user approves a submit_tasks list. Counts as a
   * satisfied plan-mode nudge (no separate nudge for tasks). Mutating tools
   * still need an active currentTaskScope to actually run, though.
   */
  private tasksApproved = false;
  /**
   * The task currently being executed inline. While set, mutating tools are
   * permitted but only for paths inside `files`. Cleared by task_complete or
   * by error. null = no inline task active (subagent execution doesn't set
   * this — subagents have their own runner).
   */
  private currentTaskScope: { id: string; files: string[] } | null = null;
  /**
   * Ring of the most recent turn signatures (oldest → newest). When its
   * length reaches DOOM_LOOP_THRESHOLD and every entry is identical, the
   * next turn is refused to break the loop.
   */
  private recentTurnSignatures: string[] = [];
  /**
   * Lightweight todo list maintained by the `todo_write` tool. Distinct from
   * the heavyweight `submit_tasks` flow — todos never pause the run; they
   * just broadcast a `todos_updated` event so the dashboard can render a
   * live sidebar. Persisted in `coder_sessions.todos_json` across restarts.
   */
  public currentTodos: import('../tools/todo.js').TodoItem[] = [];

  /**
   * Worktree scope tracking. When `enter_worktree` is called, the runner
   * remembers the original project root in `originalCwd` and swaps
   * `toolContext.cwd` for the worktree path. `exit_worktree` reverses both.
   * Persisted in `coder_sessions.worktree_path` so a session resume after a
   * server restart continues in the same worktree.
   */
  public originalCwd: string | null = null;
  public worktreePath: string | null = null;

  /** Set to true after the LLM summarizer has run once in this session.
   *  Prevents re-summarizing every turn — one pass replaces the old span,
   *  and subsequent growth is handled by deterministic compaction. */
  private summarizedOnce = false;
  /**
   * Currently active tool tiers. When null, no tier filtering is applied
   * (all registered tools visible to the provider — legacy behaviour used
   * by subagents and tests). When a Set, the runner filters registry.list()
   * each turn so only tools whose tier is in the set reach the LLM.
   *
   * Grows monotonically via `promoteTier()` — tiers never shrink mid-session
   * so the prefix cache can re-stabilize after a single promotion event.
   */
  public activeTiers: Set<ToolTier> | null = null;

  constructor(opts: RunnerOptions) {
    super();
    this.opts = opts;
    this.messages = (opts.initialMessages ?? []).map(normalizeMessageForCache);
    this.maxTurns = opts.maxTurns ?? 50;
    // back-reference so native interaction tools can pause the loop
    this.opts.toolContext.runner = this;
    this.opts.toolContext.planMode = opts.planMode;
    // Tier filtering: prefer explicit activeTiers, fall back to profile,
    // else null = no filtering.
    if (opts.activeTiers) {
      this.activeTiers = new Set(opts.activeTiers);
    } else if (opts.profile) {
      this.activeTiers = profileToTiers(opts.profile);
    } else {
      this.activeTiers = null;
    }
  }

  /**
   * Unlock a higher tier of tools. Called by the `expand_toolset` tool
   * handler. Monotonic: already-active tiers stay active, new tier is
   * added. Takes effect on the NEXT turn because the tools array is
   * rebuilt at the start of each turn from the registry + activeTiers.
   */
  promoteTier(tier: ToolTier): void {
    if (!this.activeTiers) return; // no filtering → nothing to promote
    if (this.activeTiers.has(tier)) return;
    this.activeTiers.add(tier);
    console.log(
      `[coder] tier promoted → ${tier}. Active tiers: ${Array.from(this.activeTiers).sort().join(',')}`,
    );
  }

  /**
   * Replace the session's lightweight todo list and emit `todos_updated`
   * so listeners (dashboard SSE, persistence) can react. Called by
   * `todo_write`; can also be called by host code on session resume to
   * rehydrate from the database.
   */
  setTodos(todos: import('../tools/todo.js').TodoItem[]): void {
    // Defensive copy — the tool may mutate its input later.
    this.currentTodos = todos.map((t) => ({ ...t }));
    this.emit('todos_updated', { todos: this.currentTodos });
  }

  /**
   * Enter a git worktree scope. Swaps the runner's tool-context cwd for the
   * worktree path so every subsequent tool call (fs, shell, git, LSP, glob)
   * operates against the worktree. Remembers the original root so
   * `exitWorktreeScope` can restore it. Emits `worktree_entered`.
   */
  enterWorktreeScope(absWorktreePath: string): void {
    if (this.worktreePath) return; // already inside — no-op, tool enforces this
    this.originalCwd = this.opts.toolContext.cwd;
    this.worktreePath = absWorktreePath;
    this.opts.toolContext.cwd = absWorktreePath;
    this.emit('worktree_entered', { path: absWorktreePath, originalCwd: this.originalCwd });
  }

  /**
   * Exit the current worktree scope. Restores the original cwd so subsequent
   * tool calls go back to the project root. Leaves the worktree directory on
   * disk — the tool handler decides whether to git-remove it after.
   */
  exitWorktreeScope(): void {
    if (!this.worktreePath || !this.originalCwd) return;
    const wasAt = this.worktreePath;
    this.opts.toolContext.cwd = this.originalCwd;
    this.worktreePath = null;
    this.originalCwd = null;
    this.emit('worktree_exited', { path: wasAt });
  }

  get provider(): ChatProvider {
    return this.opts.provider;
  }

  /**
   * Snapshot of the tools currently registered on this runner. Used by tools
   * that need to spawn a subagent (spawn_subagent, execute_task subagent
   * mode) so the child can build a filtered subset registry. Returns a fresh
   * array each call so callers can mutate it freely.
   */
  getToolListSnapshot(): import('./tool.js').CoderTool[] {
    return this.opts.registry.list();
  }

  get planMode(): boolean {
    return Boolean(this.opts.planMode);
  }

  /** Public method form for tools that prefer call-syntax over property-access. */
  isPlanMode(): boolean {
    return Boolean(this.opts.planMode);
  }

  /** Replace the active provider mid-session. Takes effect on the next turn. */
  swapProvider(newProvider: ChatProvider): void {
    this.opts.provider = newProvider;
    this.emit('provider_swapped', newProvider.name, newProvider.model);
  }

  /** Pause the current tool call, waiting for the host (CLI/SSE) to call provideUserInput. */
  waitForUserInput(): Promise<string> {
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  /** Resume a paused tool call with the user's answer. */
  provideUserInput(value: string): boolean {
    if (!this.pendingResolve) return false;
    const r = this.pendingResolve;
    this.pendingResolve = null;
    r(value);
    return true;
  }

  /** Marks the latest plan as approved so mutating tools become unblocked. */
  approvePlan(): void {
    this.planApproved = true;
  }

  /** Whether mutating tools should be allowed right now. */
  isPlanApproved(): boolean {
    return this.planApproved;
  }

  // ─── Tasks scope (Phase 1: inline mode) ─────────────────────

  /** Marks the submitted task list as approved by the user. Counts as a
   *  satisfied plan-mode nudge but does NOT unlock mutating tools globally. */
  markTasksApproved(): void {
    this.tasksApproved = true;
  }

  isTasksApproved(): boolean {
    return this.tasksApproved;
  }

  /** Open an inline task scope. While active, mutating tools may run for
   *  paths inside `files` even when planMode is true and planApproved is false. */
  beginTaskScope(scope: { id: string; files: string[] }): void {
    this.currentTaskScope = { id: scope.id, files: [...scope.files] };
  }

  /** Close the inline task scope. Mutating tools become blocked again
   *  (unless planApproved or another scope is opened). */
  endTaskScope(): void {
    this.currentTaskScope = null;
  }

  /** True iff an inline task scope is currently open. */
  isInTaskScope(): boolean {
    return this.currentTaskScope !== null;
  }

  /** The id of the inline task currently being executed (or null). */
  currentTaskScopeId(): string | null {
    return this.currentTaskScope?.id ?? null;
  }

  /** The files declared by the inline task currently being executed (or null). */
  currentTaskScopeFiles(): string[] | null {
    return this.currentTaskScope ? [...this.currentTaskScope.files] : null;
  }

  abort(): void {
    this.aborted = true;
    if (this.pendingResolve) {
      const r = this.pendingResolve;
      this.pendingResolve = null;
      r(JSON.stringify({ aborted: true }));
    }
  }

  on<K extends keyof RunnerEvents>(event: K, listener: RunnerEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends keyof RunnerEvents>(event: K, ...args: Parameters<RunnerEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  /** Append a user message (text only) to the history. */
  pushUserMessage(text: string): void {
    this.messages.push({ role: 'user', content: [{ type: 'text', text }] });
  }

  /** Append a user message with arbitrary content blocks (text + image + document). */
  pushUserContent(blocks: ContentBlock[]): void {
    this.messages.push({ role: 'user', content: blocks });
  }

  /**
   * Run the loop until completion or max_turns. Resolves with the final usage
   * total. The runner emits events along the way; consumers (CLI / SSE) attach
   * listeners before calling run().
   */
  async run(): Promise<{ totalUsage: ChatUsage; reason: 'completed' | 'max_turns' | 'aborted' | 'error' | 'plan_required' }> {
    const totalUsage: ChatUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    let autoContinueCount = 0;
    // Tools array is rebuilt each turn when tier filtering is active, so
    // `expand_toolset` calls take effect on the very next turn without any
    // extra plumbing. When `activeTiers` is null (subagents, tests) we
    // compute it once and reuse — identical to the legacy behaviour.
    const buildTools = () => {
      let filtered = this.opts.registry.list();
      // Global disabled (admin panel)
      if (this.opts.globalDisabledTools?.size) {
        filtered = filtered.filter((t) => !this.opts.globalDisabledTools!.has(t.name));
      }
      // Session disabled (per-session config)
      if (this.opts.sessionDisabledTools?.size) {
        filtered = filtered.filter((t) => !this.opts.sessionDisabledTools!.has(t.name));
      }
      // Tier filtering (with optional runtime overrides for external MCP tools)
      filtered = this.activeTiers
        ? filterByTiers(filtered, this.activeTiers, this.opts.externalToolTiers)
        : filtered;
      // Plugin hook: projects can drop `.mcp-indexer/hooks/tool-filter.js`
      // to return an allowlist of tool names. Runs in vm sandbox with 200ms
      // timeout; on failure or non-array return, no filtering is applied.
      const hookAllow = runToolFilterHook(
        this.opts.toolContext.cwd,
        filtered.map((t) => ({ name: t.name, source: t.source })),
        {
          projectName: this.opts.toolContext.projectName,
          providerName: this.opts.provider.name,
          model: this.opts.provider.model,
          profile: this.activeTiers ? Array.from(this.activeTiers).sort().join(',') : undefined,
        },
      );
      if (hookAllow && hookAllow.size > 0) {
        const before = filtered.length;
        filtered = filtered.filter((t) => hookAllow.has(t.name));
        if (filtered.length < before) {
          console.log(`[coder] tool-filter hook removed ${before - filtered.length} tool(s)`);
        }
      }
      // Capability cap: some providers (GLM, DeepSeek, gpt-4o-mini) start
      // confusing tool names above their sweet-spot count. Trim the tail —
      // tier filtering already put the most important tools first by
      // registration order, so the drop is least-valuable-first.
      const cap = getModelMaxTools(this.opts.provider.model);
      const capped = filtered.length > cap ? filtered.slice(0, cap) : filtered;
      if (capped.length < filtered.length) {
        const note = getModelCapabilityNote(this.opts.provider.model);
        console.warn(
          `[coder] capability cap: ${this.opts.provider.model} limited to ${cap} tools (had ${filtered.length})` +
            (note ? ` — ${note}` : ''),
        );
      }
      return capped.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
    };
    let tools = buildTools();
    let lastTiersKey = this.activeTiers ? Array.from(this.activeTiers).sort().join(',') : '*';

    let turn = 0;
    // Outer loop: allows auto-continue after maxTurns by resetting `turn`.
    // eslint-disable-next-line no-constant-condition
    while (true) {
    while (turn < this.maxTurns) {
      if (this.aborted) {
        this.emit('done', 'aborted');
        return { totalUsage, reason: 'aborted' };
      }

      turn++;
      this.emit('turn_start', turn);

      // LLM summarizer — opt-in via CODER_SUMMARIZER_ENABLE=1. Runs ONCE
      // per session the first turn the history grows big enough to trigger
      // compaction. Replaces the pre-cutoff span with a single synthetic
      // assistant message containing a structured markdown summary. Any
      // failure (LLM error, bad JSON, timeout) falls back to the
      // deterministic compactMessages path below — the summarizer never
      // breaks a turn.
      if (isSummarizerEnabled() && !this.summarizedOnce) {
        const total = totalChars(this.messages);
        if (total > PRUNE_MINIMUM) {
          const cutoff = snapCutoffToRoleBoundary(this.messages, computeCutoffIndex(this.messages, PRUNE_PROTECT));
          if (cutoff > 1) {
            const span = this.messages.slice(0, cutoff);
            console.log(`[coder] running summarizer on ${cutoff} old messages (~${total} chars total)`);
            const summary = await summarizeSpan(span, this.opts.provider);
            if (summary) {
              const rendered = renderSummary(summary);
              const syntheticAssistant: AgentMessage = {
                role: 'assistant',
                content: [{ type: 'text', text: rendered }],
              };
              // Replace the pre-cutoff span with the synthetic summary. The
              // persistent DB history is NOT touched — only the in-memory
              // `this.messages` used to build provider requests. A session
              // resume will rebuild from the untouched DB and re-apply the
              // deterministic compaction path.
              this.messages.splice(0, cutoff, syntheticAssistant);
              this.summarizedOnce = true;
              console.log(`[coder] summarizer collapsed ${cutoff} messages into 1 synthetic summary`);
            } else {
              // Mark as attempted so we don't retry every turn on a broken
              // summarizer — deterministic compaction takes over.
              this.summarizedOnce = true;
              console.warn('[coder] summarizer returned null; using deterministic compaction');
            }
          }
        }
      }

      // Rebuild tools iff tier set changed since last turn (cheap no-op
      // otherwise). This keeps the prefix byte-stable across consecutive
      // turns within the same tier, so server-side prefix cache hits.
      const currentKey = this.activeTiers ? Array.from(this.activeTiers).sort().join(',') : '*';
      if (currentKey !== lastTiersKey) {
        tools = buildTools();
        lastTiersKey = currentKey;
      }

      const assistantContent: ContentBlock[] = [];
      let pendingText = '';
      const pendingToolCalls = new Map<string, { name: string; input: Record<string, unknown> }>();
      const usageBox: { value: ChatUsage | null } = { value: null };
      let retriedThisTurn = false;
      void assistantContent;

      try {
        const stream = this.opts.provider.chat({
          system: this.opts.systemPrompt,
          messages: compactHistoryForLLM(this.messages),
          tools,
        });
        for await (const delta of stream) {
          if (this.aborted) break;
          this.handleDelta(delta, {
            onText: (t) => {
              pendingText += t;
              this.emit('text_delta', t);
            },
            onToolCall: (id, name, input) => {
              pendingToolCalls.set(id, { name, input });
            },
            onUsage: (u) => {
              usageBox.value = u;
            },
          });
        }
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        // Retry once on recoverable provider 400 errors (message format issues).
        // GLM/ZAI returns code 1214 for illegal message sequences that may be
        // fixable by the compaction safety nets on a second pass.
        const status = (e as { status?: number }).status;
        const code = (e as { error?: { code?: string } }).error?.code;
        const is400 = status === 400 || code === '1214';
        if (is400 && !retriedThisTurn) {
          retriedThisTurn = true;
          console.warn(`[coder] provider returned 400 at turn ${turn}, retrying once`);
          continue;
        }
        this.emit('done', 'error', error);
        return { totalUsage, reason: 'error' };
      }

      // Build assistant message in correct block order: text first, then tool_uses
      if (pendingText) {
        assistantContent.push({ type: 'text', text: pendingText });
      }
      const toolUseBlocks: ToolUseBlock[] = [];
      for (const [id, { name, input }] of pendingToolCalls) {
        const block: ToolUseBlock = { type: 'tool_use', id, name, input };
        toolUseBlocks.push(block);
        assistantContent.push(block);
      }

      const assistantMessage: AgentMessage = { role: 'assistant', content: assistantContent };
      this.messages.push(assistantMessage);
      const lastUsage = usageBox.value;
      if (lastUsage) {
        totalUsage.input_tokens += lastUsage.input_tokens;
        totalUsage.output_tokens += lastUsage.output_tokens;
        totalUsage.cache_creation_input_tokens =
          (totalUsage.cache_creation_input_tokens ?? 0) + (lastUsage.cache_creation_input_tokens ?? 0);
        totalUsage.cache_read_input_tokens =
          (totalUsage.cache_read_input_tokens ?? 0) + (lastUsage.cache_read_input_tokens ?? 0);
        const cached = lastUsage.cache_read_input_tokens ?? 0;
        const ratio = lastUsage.input_tokens > 0 ? Math.round((cached / lastUsage.input_tokens) * 100) : 0;
        console.log(
          `[coder] turn=${turn} input=${lastUsage.input_tokens} output=${lastUsage.output_tokens} cache_hit=${cached} ratio=${ratio}%`,
        );
        if (turn >= 3 && ratio < 40 && lastUsage.input_tokens > 5_000) {
          console.warn(
            `[coder] low cache hit rate (${ratio}%) at turn ${turn}. ` +
            `Check for prefix mutation: tools sort order, system prompt stability, push-time truncation.`,
          );
        }
      }
      this.emit('message_complete', assistantMessage, lastUsage);

      // Emit context metrics so the dashboard can show a progress indicator.
      const historyChars = totalChars(this.messages);
      this.emit('context_status', {
        history_chars: historyChars,
        turn,
        max_turns: this.maxTurns,
        auto_continue_count: autoContinueCount,
        auto_continue_max: MAX_AUTO_CONTINUES,
      });

      // No tool calls → conversation finished. In plan mode this is fine:
      // the real safety net is at the tool-invocation level (mutating tools
      // are blocked until submit_plan/submit_tasks is approved — see the
      // per-tool check below). If the model answered the user with pure
      // text without touching anything, there's nothing to gate. Forcing a
      // plan for trivial greetings ("Oi") or short informational answers
      // was user-hostile and added noise with zero safety benefit.
      if (toolUseBlocks.length === 0) {
        this.recentTurnSignatures.length = 0;
        this.emit('done', 'completed');
        return { totalUsage, reason: 'completed' };
      }

      // Doom-loop guard: if the model just asked for the exact same set of
      // tool calls N turns in a row, something is stuck. Refuse to execute
      // and bail with an error so the host can surface it to the user.
      if (DOOM_LOOP_THRESHOLD >= 2) {
        const sig = toolCallsSignature(
          toolUseBlocks.map((b) => ({ name: b.name, input: b.input })),
        );
        this.recentTurnSignatures.push(sig);
        if (this.recentTurnSignatures.length > DOOM_LOOP_THRESHOLD) {
          this.recentTurnSignatures.shift();
        }
        if (
          this.recentTurnSignatures.length === DOOM_LOOP_THRESHOLD &&
          this.recentTurnSignatures.every((s) => s === sig && s !== '')
        ) {
          const err = new Error(
            `Doom loop detected: the same tool call${toolUseBlocks.length > 1 ? 's were' : ' was'} emitted ${DOOM_LOOP_THRESHOLD} turns in a row without progress. ` +
              `Last signature: ${sig.slice(0, 200)}${sig.length > 200 ? '…' : ''}. ` +
              `Aborting to avoid cost runaway — fix the underlying issue (wrong args, missing file, bad permission) before retrying.`,
          );
          console.warn(`[coder] doom-loop aborted at turn ${turn}: ${sig.slice(0, 120)}`);
          this.emit('done', 'error', err);
          return { totalUsage, reason: 'error' };
        }
      }

      // Execute each tool call sequentially and collect results
      const toolResultBlocks: ContentBlock[] = [];
      for (const block of toolUseBlocks) {
        if (this.aborted) break;
        this.emit('tool_call_start', block.id, block.name, block.input);
        const start = Date.now();
        let result;
        if (this.opts.planMode && !this.planApproved && MUTATING_TOOLS.has(block.name)) {
          // Inside an inline task scope, mutating tools are unlocked but only
          // for paths declared in the task's `files`. Anything outside is
          // still blocked even mid-task — keeps the path sandbox honest.
          const scopeFiles = this.currentTaskScope?.files;
          if (scopeFiles) {
            const candidatePaths = extractPathsFromToolArgs(block.name, block.input);
            const allInside = candidatePaths.length > 0
              && candidatePaths.every((p) => isPathInsideScope(p, scopeFiles));
            if (allInside) {
              result = await this.opts.registry.invoke(block.name, block.input, this.opts.toolContext);
            } else {
              const violators = candidatePaths.filter((p) => !isPathInsideScope(p, scopeFiles));
              result = {
                content: `Tool '${block.name}' refused: path(s) outside the current task scope. ` +
                  `Task ${this.currentTaskScope?.id} declared files=[${scopeFiles.join(', ')}]; ` +
                  `tried to touch [${violators.join(', ')}]. ` +
                  `Either edit a file inside the declared scope, or call task_complete and submit a new task.`,
                isError: true,
              };
            }
          } else {
            result = {
              content: `Tool '${block.name}' is blocked in plan mode. Call 'submit_plan' first and wait for user approval before mutating the workspace.`,
              isError: true,
            };
          }
        } else {
          result = await this.opts.registry.invoke(block.name, block.input, this.opts.toolContext);
        }
        const durationMs = Date.now() - start;
        // Accumulate subagent usage into the parent's total — costs of work
        // delegated to a subagent must NEVER be hidden from the session.
        if (result.subUsage) {
          totalUsage.input_tokens += result.subUsage.input_tokens;
          totalUsage.output_tokens += result.subUsage.output_tokens;
          totalUsage.cache_creation_input_tokens =
            (totalUsage.cache_creation_input_tokens ?? 0) + (result.subUsage.cache_creation_input_tokens ?? 0);
          totalUsage.cache_read_input_tokens =
            (totalUsage.cache_read_input_tokens ?? 0) + (result.subUsage.cache_read_input_tokens ?? 0);
          const subCached = result.subUsage.cache_read_input_tokens ?? 0;
          console.log(
            `[coder] subagent tool=${block.name} input=${result.subUsage.input_tokens} output=${result.subUsage.output_tokens} cache_hit=${subCached}`,
          );
        }
        this.emit('tool_call_result', block.id, block.name, result, durationMs);
        // Side-file truncation: if the content is too large AND the runner
        // has a tool output store wired in, persist the full content and
        // include the output_id in the truncation marker. This lets the
        // agent retrieve the elided portion via `get_tool_output(id)` on
        // demand — without making every large output permanently visible.
        const cap = this.opts.pushTimeCap ?? PUSH_TIME_CAP;
        let persistedId: string | null = null;
        if (result.content.length > cap && this.opts.toolContext.toolOutputStore) {
          persistedId = this.opts.toolContext.toolOutputStore.put(result.content);
        }
        toolResultBlocks.push(
          buildToolResultBlock(block.id, result.content, result.isError, cap, persistedId ?? undefined),
        );
      }

      this.messages.push({ role: 'tool', content: toolResultBlocks });
    } // end inner while (turn < maxTurns)

    // If aborted during the inner loop, don't auto-continue.
    if (this.aborted) {
      this.emit('done', 'aborted');
      return { totalUsage, reason: 'aborted' };
    }

    // Auto-continue: instead of dying at maxTurns, compact the history and
    // reset the turn counter. Mirrors Claude Code's behaviour — the agent
    // only stops when there's no more work, not due to an artificial ceiling.
    if (MAX_AUTO_CONTINUES > 0 && autoContinueCount < MAX_AUTO_CONTINUES) {
      autoContinueCount++;
      console.log(
        `[coder] auto-continue ${autoContinueCount}/${MAX_AUTO_CONTINUES} — compacting history before resuming`,
      );
      this.emit('auto_continue', autoContinueCount, MAX_AUTO_CONTINUES);

      // Summarize the old span for richer context preservation, falling
      // back to deterministic compaction if the summarizer is unavailable.
      const histTotal = totalChars(this.messages);
      const cutoff = snapCutoffToRoleBoundary(this.messages, computeCutoffIndex(this.messages, PRUNE_PROTECT));
      if (cutoff > 1) {
        const span = this.messages.slice(0, cutoff);
        let replaced = false;
        try {
          const summary = await summarizeSpan(span, this.opts.provider);
          if (summary) {
            const synthetic: AgentMessage = {
              role: 'assistant',
              content: [{ type: 'text', text: renderSummary(summary) }],
            };
            this.messages.splice(0, cutoff, synthetic);
            replaced = true;
            console.log(
              `[coder] summarizer collapsed ${cutoff} messages (~${histTotal} chars) into 1 synthetic summary`,
            );
          }
        } catch (e) {
          console.warn(`[coder] summarizer failed during auto-continue: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (!replaced) {
          const compacted = compactMessages(this.messages);
          if (compacted.applied) {
            // compactMessages returns a new array — swap in-place.
            this.messages.length = 0;
            this.messages.push(...compacted.messages);
            console.log(
              `[coder] deterministic compaction pruned ${compacted.prunedBlocks} blocks (~${compacted.prunedChars} chars)`,
            );
          }
        }
      }
      // Allow the summarizer to run again in the next continuation window.
      this.summarizedOnce = false;
      // Reset turn counter so the inner while gets a full maxTurns budget.
      turn = 0;
      continue; // → back to outer while(true)
    }

    // Exhausted all auto-continues — stop for real.
    break;
    } // end outer while(true)

    this.emit('done', 'max_turns');
    return { totalUsage, reason: 'max_turns' };
  }

  private handleDelta(
    delta: ChatDelta,
    handlers: {
      onText: (t: string) => void;
      onToolCall: (id: string, name: string, input: Record<string, unknown>) => void;
      onUsage: (u: ChatUsage) => void;
    }
  ): void {
    switch (delta.type) {
      case 'text_delta':
        handlers.onText(delta.text);
        break;
      case 'tool_call_end':
        handlers.onToolCall(delta.id, delta.name, delta.input);
        break;
      case 'usage':
        handlers.onUsage(delta.usage);
        break;
      // tool_call_start, tool_call_args, done are informational only
      default:
        break;
    }
  }
}

// ─── Path scope helpers (used by inline task scope gate) ───────

/**
 * Best-effort extraction of filesystem paths from tool arguments. We don't
 * know every tool's schema, so we look for the most common shapes used by
 * fs/shell tools in this codebase: path, file_path, paths, cwd, target, and
 * the `command` string from run_command. Anything we extract is normalized
 * to a project-relative POSIX path; tokens we can't classify are skipped.
 */
export function extractPathsFromToolArgs(toolName: string, args: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) out.add(v.trim());
  };

  push((args as { path?: unknown }).path);
  push((args as { file_path?: unknown }).file_path);
  push((args as { target?: unknown }).target);
  push((args as { destination?: unknown }).destination);
  const paths = (args as { paths?: unknown }).paths;
  if (Array.isArray(paths)) for (const p of paths) push(p);

  // run_command: parse the command string for `cd <path>` and absolute paths.
  if (toolName === 'run_command' && typeof (args as { command?: unknown }).command === 'string') {
    const cmd = (args as { command: string }).command;
    // cd <path>
    const cdMatch = cmd.match(/(?:^|\s)cd\s+([^\s;|&]+)/);
    if (cdMatch) push(cdMatch[1]);
    // Absolute paths (POSIX or Windows) — flag for sandbox awareness.
    const absMatches = cmd.match(/(?:^|\s)([\\/][^\s;|&]+|[A-Za-z]:[\\/][^\s;|&]+)/g);
    if (absMatches) for (const m of absMatches) push(m.trim());
    // Tokens with .. for traversal
    const dotDot = cmd.match(/\S*\.\.\S*/g);
    if (dotDot) for (const m of dotDot) push(m);
  }

  return Array.from(out);
}

/**
 * True iff `candidate` resolves into one of `scopeFiles` (path-prefix match
 * after normalizing both to project-relative POSIX form). Conservative: if
 * normalization fails, treat as outside the scope.
 *
 * `scopeFiles` may contain individual files OR directories — both work.
 */
export function isPathInsideScope(candidate: string, scopeFiles: string[]): boolean {
  // Reject obvious traversal and absolute paths up front. Mid-task, the
  // model should be operating on the declared files only.
  if (candidate.includes('..')) return false;
  if (isAbsolute(candidate)) return false;
  // POSIX-normalize backslashes for cross-platform comparison.
  const norm = candidate.replace(/\\/g, '/');
  for (const scope of scopeFiles) {
    const s = scope.replace(/\\/g, '/');
    if (norm === s) return true;
    // Directory scope: candidate must be inside it.
    if (norm.startsWith(s.endsWith('/') ? s : s + '/')) return true;
  }
  return false;
}
// suppress unused-import warning until other helpers reference these
void pathResolve;
void pathRelative;
