/**
 * Per-turn telemetry persistence — pure function extracted from the
 * legacy `CoderRunner.persistTurnTelemetry`.
 *
 * Scope of THIS function (kept narrow on purpose):
 *   - Compute `largest_tool_result_chars` and `paginate_count` (signals
 *     that don't depend on `this`).
 *   - Compute `estimated_cost_usd` via the pricing table.
 *   - Call `store.recordTurnTelemetry(...)` and return the inserted id.
 *
 * Out of scope (stays in `CoderRunner` because it needs class state):
 *   - Storing the inserted id on the runner.
 *
 * The runner exposes the FULL flow via `BridgeCallbacks.persistTurnTelemetry`,
 * which wraps THIS function and runs the class-bound side effects after.
 * The BT's `ExecutingNode` only sees the bridge callback.
 */
import type { AgentDecisionTelemetry } from '@mcp/code-agent/agents/decision-types.js';
import type {
  ChatProviderResponseMeta,
  ChatUsage,
  ContentBlock,
  ToolUseBlock,
} from '@mcp/code-agent/core/messages.js';
import { estimateCost } from '@mcp/code-agent/providers/pricing-cache.js';
import type {
  FsTurnTelemetryInput,
  FsTurnTelemetrySink,
} from '@mcp/session-storage/fs-store/turn-telemetry.js';
import type { SessionId } from '@mcp/session-storage';

export interface PersistTurnTelemetryArgs {
  /** Filesystem telemetry sink; persistence is skipped when omitted. */
  store: FsTurnTelemetrySink | undefined;
  /** Filesystem session UUID; null for detached subagents/tests. */
  sessionId: SessionId | null;
  /** Fresh per-run uuid for cross-table correlation. */
  runId: string;
  /** True when this run is inside a subagent (no kanban/board lifecycle). */
  isSubagent: boolean;
  parentRunId?: string | null;
  subagentProfile?: string | null;
  /** Provider name as it appears in the pricing table. */
  provider: string | null;
  /** Model id as it appears in the pricing table. */
  model: string | null;
  /** Turn index (1-based). */
  turn: number;
  /** Auto-continue batches consumed by this run at this turn. */
  autoContinues?: number;
  /** Provider-reported usage for the response this turn produced. */
  usage: ChatUsage | null;
  /** tool_use blocks the assistant emitted this turn (post-stream). */
  toolUseBlocks: ReadonlyArray<ToolUseBlock>;
  /** tool_result blocks dispatched on the parent's behalf this turn. */
  toolResultBlocks: ReadonlyArray<ContentBlock>;
  /** Approx total chars in `this.messages` at request time. */
  historyChars: number;
  /** True when the runner crossed the compaction threshold this turn. */
  compactionTriggered: boolean;
  /** True when the LLM compactor actually ran (`Compacting` node). */
  summarizerRan: boolean;
  /** System prompt size (chars) actually shipped to the provider. */
  systemPromptChars?: number;
  /** Tools array (stringified JSON) size in chars shipped this turn. */
  toolsDefChars?: number;
  eligibleToolsDefChars?: number;
  /** How many tools were visible to the model this turn (mig 135). */
  visibleToolsCount?: number;
  /** SHA-1 of the serialized tools array (mig 143) — cache-prefix segment 1. */
  toolsFingerprint?: string | null;
  /** SHA-256 identities of authorization and its provider-facing view. */
  capabilitySetDigest?: string | null;
  projectionDigest?: string | null;
  /** SHA-1 sample of the assembled history head (mig 143). */
  prefixHeadHash?: string | null;
  /** Rolling-reducer counters for this turn's LLM view (mig 143). */
  reducerStats?: { retired: number; freedChars: number; pendingRetired: number; pendingChars: number } | null;
  /** Sanitized provider request/response metadata (mig 093). */
  responseMeta?: ChatProviderResponseMeta | null;
  /** Optional Agent Decision Engine telemetry, stored inside response_meta JSON. */
  agentDecisionTelemetry?: AgentDecisionTelemetry | null;
  /** Actual session agent at execution time, paired with the recommendation. */
  actualAgent?: string | null;
}

/**
 * Persist one immutable metric file and return its UUID (or null when
 * persistence is unavailable / failed).
 *
 * Best-effort: the function NEVER throws / never rejects. Telemetry must
 * not break a real turn. Failures inside `store.recordTurnTelemetry` are
 * caught by the store itself (see the `try` in `telemetry-record.ts`).
 */
export function persistTurnTelemetry(
  args: PersistTurnTelemetryArgs,
): string | null | Promise<string | null> {
  if (!args.store || args.sessionId == null) return null;

  // ── largest_tool_result_chars ──
  // Surfaces tools that routinely produce huge outputs (good candidates
  // for smart-reducer registration). Compute over the POST-shape blocks
  // so the metric reflects what actually hit the model.
  let largest = 0;
  for (const b of args.toolResultBlocks) {
    const c = (b as { content?: unknown }).content;
    if (typeof c === 'string' && c.length > largest) largest = c.length;
  }

  // ── paginate_count ──
  // Counts read_file / mcp__read_file calls that hit the SAME path more
  // than once in this turn (the model was likely fragmenting a single
  // intent into N partial reads). Per-path repeats are summed.
  let paginate = 0;
  const readFilePaths = new Map<string, number>();
  for (const b of args.toolUseBlocks) {
    if (b.name === 'read_file' || b.name === 'mcp__read_file') {
      const inp = b.input as { path?: unknown; file_path?: unknown };
      const p = typeof inp.path === 'string'
        ? inp.path
        : typeof inp.file_path === 'string'
          ? inp.file_path
          : '';
      if (p) readFilePaths.set(p, (readFilePaths.get(p) ?? 0) + 1);
    }
  }
  for (const count of readFilePaths.values()) {
    if (count > 1) paginate += count - 1;
  }

  // ── estimated_cost_usd ──
  // Best-effort lookup; returns 0 for unknown provider/model pairs which
  // we collapse to null on the DB side (kept as null, not 0, so the
  // dashboard can distinguish "unknown" from "actually free"). Key on
  // request_api_model when present so the live cost matches the dashboard's
  // COALESCE(request_api_model, model) grouping and the backfill.
  const apiModel = args.responseMeta?.request?.api_model ?? args.model;
  const cost = estimateCost(args.provider ?? '', apiModel ?? '', args.usage);
  const responseMeta = args.agentDecisionTelemetry
    ? ({
      ...(args.responseMeta ?? {}),
      agent_decision: {
        ...args.agentDecisionTelemetry,
        actualAgent: args.actualAgent ?? null,
        toolsCalled: args.toolUseBlocks.map((b) => b.name),
      },
    } as ChatProviderResponseMeta)
    : (args.responseMeta ?? null);

  try {
    const record: FsTurnTelemetryInput = {
      session_id: args.sessionId,
      run_id: args.runId,
      turn: args.turn,
      auto_continues: args.autoContinues ?? 0,
      is_subagent: args.isSubagent,
      parent_run_id: args.parentRunId ?? null,
      subagent_profile: args.subagentProfile ?? null,
      provider: args.provider,
      model: args.model,
      input_tokens: args.usage?.input_tokens ?? null,
      output_tokens: args.usage?.output_tokens ?? null,
      cache_read_input_tokens: args.usage?.cache_read_input_tokens ?? null,
      cache_creation_input_tokens: args.usage?.cache_creation_input_tokens ?? null,
      thinking_tokens: args.usage?.thinking_tokens ?? null,
      history_chars: args.historyChars,
      tool_count: args.toolUseBlocks.length,
      tools_called: args.toolUseBlocks.map((b) => b.name),
      largest_tool_result_chars: args.toolResultBlocks.length > 0 ? largest : null,
      compaction_triggered: args.compactionTriggered,
      summarizer_ran: args.summarizerRan,
      paginate_count: paginate,
      system_prompt_chars: args.systemPromptChars ?? null,
      tools_def_chars: args.toolsDefChars ?? null,
      eligible_tools_def_chars: args.eligibleToolsDefChars ?? null,
      visible_tools_count: args.visibleToolsCount ?? null,
      tools_fingerprint: args.toolsFingerprint ?? null,
      capability_set_digest: args.capabilitySetDigest ?? null,
      projection_digest: args.projectionDigest ?? null,
      prefix_head_hash: args.prefixHeadHash ?? null,
      reducer_retired_count: args.reducerStats?.retired ?? null,
      reducer_freed_chars: args.reducerStats?.freedChars ?? null,
      reducer_pending_chars: args.reducerStats?.pendingChars ?? null,
      estimated_cost_usd: cost > 0 ? cost : null,
      response_meta: responseMeta,
    };
    return args.store.recordTurnTelemetry(record).catch(() => null);
  } catch {
    return null;
  }
}
