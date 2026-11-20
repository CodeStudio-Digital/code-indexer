import type { ToolContextServices } from './tool-context.js';
import type { GuardVerdict, ToolResult, ToolOutputPolicy, ToolSourceTruncation } from '@mcp/agent-runtime-host/tool-result.js';
/**
 * `JsonSchema` (the tool-input schema) now lives in `@mcp/provider-sdk` so the
 * provider adapter contract can reference it without depending back into
 * code-agent. Re-exported here so existing importers keep working.
 */
export type { JsonSchema } from '@mcp/provider-sdk';

import type { JsonSchema } from '@mcp/provider-sdk';

/**
 * Coarse risk classification used by the policy module to decide whether a
 * tool may run in the current context, and (in a future phase) whether it
 * is safe to dispatch in parallel with peers. Default resolution lives in
 * `core/policy.ts`:
 *   1. explicit field on the tool (most specific);
 *   2. built-in classification by name for known native tools;
 *   3. conservative fallback (for MCP-external + unknown tools).
 */
export type ToolRiskLevel = 'read' | 'write' | 'execute' | 'admin';
export type ToolRepeatPolicy = 'stable' | 'volatile' | 'pollable' | 'mutating';
export type ToolExecutionClass = 'read' | 'write' | 'execute' | 'control';
export type ToolEffectBoundaryKind =
  | 'filesystem'
  | 'shell'
  | 'network'
  | 'database'
  | 'external_mcp'
  /** The tool has no direct effect; every nested call is dispatched again through the registry. */
  | 'nested'
  /** In-process control state whose handler entry is the physical mutation boundary. */
  | 'control';

export interface ToolMutationEffect {
  kind: Exclude<ToolEffectBoundaryKind, 'nested'>;
  operation: string;
  /** Canonical/physical target observed at the port boundary. */
  resource?: string;
}

export interface ToolMutationFence {
  readonly mode: 'shadow' | 'enforce';
  /** Bound invocation evidence; raw tool input is never stored here. */
  readonly resourceBinding?: import('@mcp/agent-runtime-contracts').ResourceBinding;
  /** Aborted as soon as authoritative lease validation fails. */
  readonly signal?: AbortSignal;
  /**
   * Seal the normalized effective input and declared first-party boundary for
   * one invocation. The registry calls this again for code_exec nested calls.
   */
  bindInvocation(input: {
    toolName: string;
    toolUseId: string;
    effectiveInput: Record<string, unknown>;
    boundary?: ToolEffectBoundaryKind;
    requiresEffectBoundary: boolean;
  }): ToolMutationFence;
  /** Revalidate input/environment/lease binding immediately before an effect. */
  assertMutation(effect: ToolMutationEffect): void;
  /** Periodically validate ownership so in-flight cancellable ports are aborted. */
  startLeaseMonitor?(): () => void;
}

/**
 * Runtime-only progressive-disclosure metadata for tools contributed by a
 * dynamic provider (for example an installed plugin). The runner aggregates
 * these declarations into its tier map and `expand_toolset` catalog; this
 * metadata is never serialized into the provider-facing tool definition.
 */
export interface RuntimeToolTierMetadata {
  id: string;
  displayName: string;
}

export interface CoderTool {
  name: string;
  description: string;
  /** Authored compact contract for the stable catalog; never inferred by truncation. */
  catalogDescription?: string;
  parameters: JsonSchema;
  /** Tool source — used by the UI for rendering and by the registry for filtering. */
  source: 'native' | 'mcp' | 'mcp_external';
  /**
   * Canonical catalog provenance. `source` remains the legacy dispatch/UI
   * discriminator; this metadata preserves the real contributor identity so
   * plugin and remote-MCP capabilities do not collapse into one anonymous
   * `mcp_external` namespace.
   */
  capabilityProvenance?: {
    kind?: import('@mcp/agent-runtime-contracts').CapabilitySource['kind'];
    providerId?: string;
    serverId?: string;
    provenanceRef?: string;
    attestationRef?: string;
  };
  /** Human label used by the canonical catalog without changing wire name. */
  capabilityDisplayName?: string;
  /** Optional opt-in tier declared by a dynamic tool contributor. */
  runtimeTier?: RuntimeToolTierMetadata;
  /**
   * Model-facing output contract. The runner uses this to choose semantic
   * reduction, inline budget and recovery behaviour instead of applying one
   * blind head/tail cap to every tool family.
   *
   * Dynamic/plugin tools should declare this alongside `runtimeTier`. When it
   * is omitted the runner falls back to conservative name/content inference.
   */
  outputPolicy?: ToolOutputPolicy;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
  /**
   * Whether the tool changes any state outside its own response: filesystem
   * writes, shell commands, git mutations, MCP server-side mutations, etc.
   * Mutating tools are gated by plan-mode (must `submit_plan` first) and
   * are never paralelizable. Defaults to `true` for `mcp_external` tools
   * with no explicit value (conservative posture); `false` for native read
   * tools recognised by the built-in classifier.
   */
  mutates?: boolean;
  /**
   * Whether two invocations of this tool (or this tool against another
   * `parallelSafe: true` tool) can be dispatched concurrently without
   * data hazards. Pure reads are typically `true`. Anything that touches
   * the filesystem, shell, or git index is `false`. Defaults to
   * `!mutates` when omitted.
   */
  parallelSafe?: boolean;
  /**
   * Coarse risk bucket used by the dashboard for UI hints and (future) by
   * the policy module for tier-orthogonal gating. `read` < `write` <
   * `execute` < `admin`. Defaults are derived in `core/policy.ts`.
   */
  riskLevel?: ToolRiskLevel;
  /**
   * Dynamic risk classifier consulted by the permission gate BEFORE the
   * static metadata chain, so one tool can be read-risk for some inputs and
   * write-risk for others (e.g. `db_query`: SELECT → 'read', INSERT →
   * 'write'). Must be PURE and non-throwing over arbitrary input; the gate
   * treats a throw as 'write' (fail-safe). When absent, classification falls
   * back to the static chain exactly as before.
   */
  riskOf?(input: unknown): ToolRiskLevel;
  /**
   * Declares where this first-party tool revalidates the current AgentRun and
   * resource binding immediately before its physical effect. Mutating or
   * non-read tools without this declaration are refused in AgentRun ENFORCE;
   * SHADOW/default-off retain legacy behaviour.
   */
  effectBoundary?: ToolEffectBoundaryKind;
  /**
   * Tool requires a sandbox runtime to execute safely (e.g., scaffolders
   * that materialize new projects, or shell tools that should never touch
   * the host filesystem). The runner blocks invocation when no sandbox is
   * bound to the session. Defaults to `false`.
   */
  requiresSandbox?: boolean;
  /**
   * Tool's path arguments must be inside the active inline task scope
   * (when one is open). Today only the file-mutating tools opt in; setting
   * this to `true` makes the path-confinement check kick in for any tool
   * that takes file paths.
   */
  scopeAware?: boolean;
  /**
   * Tool pauses the runner waiting for human input (`submit_plan`,
   * `ask_user`, `task_list`, …). Interactive tools are never run in
   * parallel, even if `parallelSafe` is otherwise `true`.
   */
  interactive?: boolean;
  /**
   * A control boundary called only as a top-level tool call, never inside
   * code_exec (create_chat: it delegates and waits for the whole result).
   * Such a tool is therefore part of the direct catalog.
   */
  topLevelOnly?: boolean;
  /**
   * Continuation control: names of the tools that open the work this one
   * finishes (`task_complete` closes the scope `execute_tasks` opens). A
   * read-only session does not authorize it when none of them is authorized.
   */
  continues?: readonly string[];
  /**
   * Tool legitimately produces different results when called repeatedly
   * with identical args because it polls / awaits external state changes.
   * Examples: `wait_for_compile_clean` (Unity assembly state), `wait_agents`
   * (subordinate terminal status), tail-style log readers. Marking the tool
   * `repeatable: true` is the legacy spelling for `repeatPolicy: 'pollable'`.
   * Pollable tools may repeat identical calls, so polling-stuck (not tuple
   * dedup) owns unchanged-result intervention. This does not imply an infinite
   * timeout; declare `timeoutMs: Infinity` explicitly when required.
   *
   * Defaults to `false`. The dup-call cap remains active for all other
   * tools, including MCP external tools that don't follow the
   * `wait_for_/await_/poll_/tail_/monitor_` naming convention (which the
   * MCP loader auto-flags). Only set this when repeated calls with
   * identical args are an expected workflow, not a regression.
   */
  repeatable?: boolean;
  /**
   * Repetition semantics. `volatile` means results may change but invocation
   * timeout remains active; only `pollable` opts into unbounded waiting.
   */
  repeatPolicy?: ToolRepeatPolicy;
  /**
   * Input-sensitive repetition semantics — the `repeatPolicy` counterpart of
   * `riskOf` (write_stdin: an empty poll is pollable, a write is mutating).
   * Consulted by `resolveToolInvocationMetadata`; must be pure. A throw or an
   * unknown value keeps the static policy. Only a statically declared
   * pollable policy exempts failures from the failure-streak guard.
   */
  repeatPolicyOf?(input: unknown): ToolRepeatPolicy;
  /** Scheduling class used by nested and future parallel dispatchers. */
  executionClass?: ToolExecutionClass;
  /**
   * Hard timeout for a single invocation, in milliseconds. When undefined,
   * the runner applies a default from `core/tool-timeouts.ts` based on the
   * tool's name/source classification. Set `Infinity` to opt OUT of the
   * runner-level timeout (used by tools that legitimately manage their own
   * wait, e.g. `wait_for_compile_clean`).
   *
   * On timeout the runner emits a synthetic `tool_call_result` with
   * `isError: true` and aborts a per-call `AbortController` chained off the
   * session signal, so cooperative tools (those passing `ctx.signal` to
   * `fetch`/child processes) can clean up.
   */
  timeoutMs?: number;
  /**
   * Optional per-invocation timeout resolver. Use this when the handler accepts
   * a bounded timeout argument (for example `run_command.timeout_ms`) so queue
   * acquisition and the runner backstop share the same deadline. Invalid or
   * throwing resolvers fall back to `timeoutMs` / the normal timeout policy.
   */
  resolveTimeoutMs?: (args: Record<string, unknown>) => number;
}

/** One nested tool invocation outcome, reported by code_exec's proxy. */
export interface NestedToolCallRecord {
  /** Host-typed uncertainty; result text is never used as effect evidence. */
  effectOutcome?: 'unknown';
  /** tool_use id of the parent code_exec block. */
  parentToolUseId: string;
  /**
   * Stable parent-scoped identity assigned when the nested invocation starts.
   * Unlike `seq`, this does not change when concurrent siblings finish out of
   * order and is therefore safe as the persisted tool_use_id.
   */
  invocationId: string;
  /** 1-based completion-order sequence within the parent call. */
  seq: number;
  name: string;
  args: Record<string, unknown>;
  isError: boolean;
  durationMs: number;
  resultChars: number;
  /** First ~2k chars of the result/error — telemetry preview, not transcript. */
  resultPreview: string;
  /** Explicit omission metadata from the nested tool producer. */
  sourceTruncations?: ToolSourceTruncation[];
  /** Guard refusal tag when the observer blocked the call (dedup/failure-streak). */
  refusalKind?: string;
  logicalOperationId?: string;
  productive?: boolean;
  resultNovel?: boolean;
  coverageNovel?: boolean;
  /** Resolved repeatPolicy is pollable/volatile. */
  repeatable?: boolean;
  /** False for policy/dedup refusals that should be audited but not count as a tool failure. */
  affectsFailureStreak?: boolean;
  /** Structured invocation/no-progress verdict for direct/nested parity. */
  guardVerdict?: GuardVerdict;
  /** Whether this result was actually delivered back to the script/model. */
  delivered?: boolean;
  /** State version observed by the nested invocation. */
  stateEpoch?: number;
  repeatPolicy?: ToolRepeatPolicy;
  executionClass?: ToolExecutionClass;
  /** The tool itself declares polling (`declaresPolling`); failures then do not build a streak. */
  failureStreakExempt?: boolean;
}

/** Resolve the durable identity for one nested audit row. */
export function nestedToolCallUseId(
  record: Pick<NestedToolCallRecord, 'invocationId' | 'parentToolUseId' | 'seq'>,
): string {
  return record.invocationId ||
    `${record.parentToolUseId}#completion:${record.seq}`;
}

/**
 * Loop-guard + telemetry hooks for tool calls made INSIDE another tool
 * (code_exec scripts). Implemented over the run's own guard state by
 * runner/guards/nested-observer.ts; consumed by code-exec.ts around each
 * nested `registry.invoke`. Both methods are non-throwing by contract.
 */
export interface NestedToolObserver {
  /**
   * Consult the guards BEFORE a nested call. Non-null = refuse: the caller
   * surfaces `refusalText` as a (catchable) JS exception inside the script.
   */
  beforeNestedCall(
    name: string,
    args: Record<string, unknown>,
    opts?: {
      repeatable?: boolean;
      repeatPolicy?: ToolRepeatPolicy;
      executionClass?: ToolExecutionClass;
      stateEpoch?: number;
      forceReread?: boolean;
      /** See `NestedToolCallRecord.failureStreakExempt`; defaults to repeatPolicy === pollable. */
      failureStreakExempt?: boolean;
      /** Parent-scoped physical attempt id supplied by code_exec. */
      originToolUseId?: string;
    },
  ): (GuardVerdict & {
    /** Human-facing detail for a blocking verdict. */
    refusalText?: string;
    /** Compatibility alias used by refusal/error classification. */
    kind?: 'dedup' | 'failure-streak' | 'allow-with-reminder' | 'shadow';
  }) | null;
  /** Feed guard state + telemetry AFTER a nested call settles. Never throws. */
  afterNestedCall(e: Omit<NestedToolCallRecord, 'parentToolUseId' | 'seq'>): void;
}

export interface CapabilityPolicyInput {
  tool: CoderTool | null;
  toolUseId: string;
  toolName: string;
  /** Normalized/effective input that will reach the handler. */
  toolInput: Record<string, unknown>;
  turn: number;
}

export type CapabilityPolicyPort = (
  input: CapabilityPolicyInput,
) => { refuse: true; refusalText: string } | { refuse: false } | null | undefined
  | Promise<{ refuse: true; refusalText: string } | { refuse: false } | null | undefined>;

export interface CapabilityLifecycleHooks {
  before(input: {
    toolUseId: string;
    toolName: string;
    turn: number;
    known: boolean;
  }): void | Promise<void>;
  after(input: {
    toolUseId: string;
    toolName: string;
    turn: number;
    known: boolean;
    isError: boolean;
    refused: boolean;
    durationMs: number;
  }): void | Promise<void>;
}

export interface CapabilityPreflightResult {
  content: string;
  isError: boolean;
  refusalKind?: string;
  guardVerdict?: GuardVerdict;
}

export type CapabilityPreflightPort = (
  input: CapabilityPolicyInput & { toolMutates: boolean },
) => CapabilityPreflightResult | null | undefined
  | Promise<CapabilityPreflightResult | null | undefined>;

/**
 * The exact capability authority attached to a visible tool invocation.
 * Nested dispatchers (currently code_exec) must reuse it rather than calling
 * handlers through a weaker policy/hook path.
 */
export interface NestedCapabilityDispatch {
  turn: number;
  preflight?: CapabilityPreflightPort;
  policyShadow?: CapabilityPolicyPort;
  capabilityHooks?: CapabilityLifecycleHooks;
  /** The owning runner restricts discovery and execution to its admitted tools. */
  visibleToolNames?: ReadonlySet<string>;
  invocableToolNames?: ReadonlySet<string>;
  /** Includes permission and grant validation; called with the script clock paused. */
  invoke?: (name: string, args: Record<string, unknown>, context: ToolContext,
    dispatched: () => void) => Promise<ToolResult>;
}

export interface ToolSettledEvent {
  readonly toolName: string;
  readonly toolArgs: Readonly<Record<string, unknown>>;
  readonly result: { readonly isError: boolean };
  readonly durationMs: number;
}

export type { GuardAction, GuardVerdict, ToolErrorKind, ToolErrorInfo, ToolOutputMode, ToolOutputRecovery, ToolOutputPolicy, ToolSourceTruncation, ToolResult } from '@mcp/agent-runtime-host/tool-result.js';
export { ok, err, unknownToolOutcome } from '@mcp/agent-runtime-host/tool-result.js';

export interface ToolContext extends ToolContextServices {
  /** The user created this session inside a shared worktree workspace. */
  worktreeWorkspace?: boolean;
  /** Best-effort post-handler observation, shared by built-in, external and nested calls.
   * It cannot change policy or tool inputs/results and is not awaited by dispatch. */
  onToolSettled?: (event: ToolSettledEvent) => void | Promise<void>;
  /**
   * Loop-guard + telemetry observer for nested tool calls (code_exec).
   * Built per parent call by the Executing node over the run's own guard
   * state; absent in tests/subagent paths. See runner/guards/nested-observer.ts.
   */
  nestedToolObserver?: NestedToolObserver;
  /**
   * Current direct-dispatch authority inherited by nested capability calls.
   * The runner refreshes this per visible invocation so task-scoped policy,
   * effective inputs and lifecycle hooks are identical at every depth.
   */
  nestedCapabilityDispatch?: NestedCapabilityDispatch;
  /**
   * Invocation-scoped AgentRun/resource fence. First-party effect ports call
   * `assertMutation` synchronously as their final action before dispatch.
   */
  mutationFence?: ToolMutationFence;
}
