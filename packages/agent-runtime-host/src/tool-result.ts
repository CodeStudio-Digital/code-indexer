/** Host capability result contract, independent of either agent executor. */
/** Structured outcome from an invocation/no-progress guard. */
export type GuardAction = 'allow' | 'reuse' | 'warn' | 'block' | 'shadow';

export interface GuardVerdict {
  action: GuardAction;
  /** Stable, machine-readable reason (for example `mutating-repeat`). */
  reason: string;
  /** Refusal classification when the verdict prevented an invocation. */
  refusalKind?: string;
  /** Whether the runner should route through an explicit reflection turn. */
  shouldReflect: boolean;
  /** Whether this outcome contributes to the ordinary tool failure streak. */
  affectsFailureStreak: boolean;
  /** Number of equivalent attempts observed in the current guard scope. */
  count?: number;
  /** Tool whose invocation produced this verdict. */
  sourceTool?: string;
  /** Tool-use id that caused or originally produced the verdict. */
  originToolUseId?: string;
  /** Observe mode: the action that enforcement would have taken. */
  wouldBlock?: boolean;
  /** Workspace/state version used when the guard made its decision. */
  stateEpoch?: number;
}

/** Stable, machine-readable details for an unsuccessful tool result. */
export type ToolErrorKind =
  | 'not_found'
  | 'invalid_input'
  | 'conflict'
  | 'permission'
  | 'timeout'
  | 'cancelled'
  | 'network'
  | 'refusal'
  | 'tool_error'
  | 'internal';

export interface ToolErrorInfo {
  /** Stable code suitable for branching; unlike `content`, it is not prose. */
  code: string;
  kind: ToolErrorKind;
  /** Whether retrying the same operation without changing its inputs may help. */
  retryable: boolean;
  /** Concise recovery direction for programmatic consumers such as code_exec. */
  suggestedAction?: string;
}

/** What kind of information a tool returns to the model. */
export type ToolOutputMode =
  | 'generic'
  | 'authoritative'
  | 'page'
  | 'line_range'
  | 'rows'
  | 'logs'
  | 'diff'
  | 'search'
  | 'structured';

/** How content omitted from the inline representation can be recovered. */
export type ToolOutputRecovery =
  | 'output_store'
  | 'cursor'
  | 'section'
  | 'rerun'
  | 'none';

export interface ToolOutputPolicy {
  mode: ToolOutputMode;
  /** Skip semantic reducers for already-shaped/authoritative payloads. */
  reducer?: 'smart' | 'none';
  /** Preferred recovery contract when the full value does not fit inline. */
  recovery?: ToolOutputRecovery;
  /** Optional per-tool target. It is always clamped by context safety. */
  maxInlineChars?: number;
  /** Preserve full error evidence in the output store even when it fits. */
  preserveOnError?: boolean;
}

/**
 * Machine-readable evidence that a producer intentionally omitted source
 * data before the central reducer saw it. Text markers remain model-facing
 * guidance only and must never be parsed as telemetry truth.
 */
export interface ToolSourceTruncation {
  technique: string;
  inputSize: number;
  /**
   * Whether `inputSize` is the exact pre-cap size. False means it is a
   * truthful lower bound (for example a transfer cancelled as soon as one
   * socket chunk crossed the acquisition ceiling). Defaults to true for
   * older producers that only emit exact materialized sizes.
   */
  inputSizeExact?: boolean;
  outputSize: number;
  unit: 'chars' | 'bytes' | 'lines' | 'rows' | 'items';
  recoverable: boolean;
  /** Exact snapshot id, only when it represents the complete source value. */
  outputId?: string;
}

export interface ToolResult {
  evidence?: import('./invocation-evidence.js').ResultEvidenceV2;
  content: string;
  isError?: boolean;
  /** Dispatch occurred but its effect cannot be confirmed. Never retry automatically. */
  effectOutcome?: 'unknown';
  /** Optional structured failure metadata. `content` remains the display text. */
  error?: ToolErrorInfo;
  /** Model-facing representation. Providers receive only `content`. */
  contentFormat?: 'text' | 'markdown' | 'json';
  /**
   * Optional canonical payload retained for internal consumers such as
   * `code_exec` and size telemetry. It is never appended to model history.
   */
  structuredData?: unknown;
  /** Explicit producer-side cuts, carried separately from display text. */
  sourceTruncations?: ToolSourceTruncation[];
  /** Structured guard metadata, including observe-mode would-block signals. */
  guardVerdict?: GuardVerdict;
  /**
   * Token usage consumed by a sub-runner spawned inside this tool (e.g.
   * spawn_subagent). The parent runner adds these into its `totalUsage` so
   * subagent costs are NEVER hidden — they always show up in the parent
   * session's billing and the dashboard token counters.
   */
  subUsage?: import('@mcp/provider-sdk').ChatUsage;
  /**
   * Optional user-message content blocks the runner should append AFTER the
   * tool result. Used by tools like `view_image` that need to inject content
   * (an image, a document) the model can actually perceive on its next turn.
   * The runner emits a synthetic `{ role: 'user', content: extraUserBlocks }`
   * message immediately after the tool batch.
   */
  extraUserBlocks?: import('@mcp/provider-sdk').ContentBlock[];
}

export function ok(content: string): ToolResult {
  return { content };
}

export function err(content: string, error?: ToolErrorInfo): ToolResult {
  return { content, isError: true, ...(error ? { error } : {}) };
}

export function unknownToolOutcome(content: string): ToolResult {
  return { ...err(content, { code: 'TOOL_OUTCOME_UNKNOWN', kind: 'network', retryable: false,
    suggestedAction: 'Reconcile the original operation before authorizing another mutation.' }),
    effectOutcome: 'unknown' };
}
