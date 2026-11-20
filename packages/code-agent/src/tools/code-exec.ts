/**
 * code_exec — execute a JS snippet that batches tool calls.
 *
 * Inspired by codex's `code_mode` / `exec` tool. Lets the model collapse a
 * multi-turn exploration into a single turn by writing a script that calls
 * the registry's read/search tools through async function proxies.
 *
 * Scope:
 *  - Read/search AND mutating/shell tools are exposed (write_file, edit_file,
 *    manage_path, run_command, exec_command, git_*); each nested
 *    call goes through the SAME plan-mode / task-scope policy as a direct call.
 *    Only interactive/orchestration tools are withheld (see `isSafeTool`).
 *  - Sandbox is `node:vm` (NOT a security boundary; the agent is trusted —
 *    same trust level as direct tool calls).
 *  - Timeout measures the script's own JS-active time and is PAUSED while a
 *    nested tool call is in flight (codex `code_mode` model: the script is not
 *    charged for time spent inside a tool). Each nested tool is bounded by its
 *    own tier (`resolveToolTimeoutMs`), so a long `run_command` install runs to
 *    its 10-min budget instead of being killed by the script clock. A tool-free
 *    spin still trips the JS budget; the node:vm sync timeout guards synchronous
 *    loops. A per-tool-call counter bounds runaway scripts.
 *
 * Each registered safe tool becomes `await tools.<name>(args)`. Result is
 * the tool's text content, or thrown Error when the tool reports isError.
 */
import { Buffer } from 'node:buffer';
import { canInvokeInsideCodeExec as isSafeTool } from './code-exec-eligibility.js';
import type { Context } from 'node:vm';
import { superviseCodeExec } from './code-exec-supervisor.js';
import type { CoderTool, GuardVerdict, ToolContext, ToolErrorInfo, ToolResult } from '@mcp/code-agent/core/tool.js';
import type { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { ok, err, unknownToolOutcome } from '@mcp/code-agent/core/tool.js';
import { inferToolErrorInfo } from '@mcp/code-agent/core/tool-error-info.js';
import { declaresPolling } from '@mcp/code-agent/core/tool-classification.js';
import {
  evaluateToolInvocation,
  findScopeViolations,
  resolveToolInvocationMetadata,
  isExplicitlyParallelSafeRead,
  type PolicyContext,
} from '@mcp/code-agent/core/policy.js';
import { isReadOnlyAgent } from '@mcp/code-agent/agents/index.js';
import { extractPathsFromToolArgs, isPathInsideScope } from '@mcp/code-agent/core/runner.js';
import { resolveToolTimeoutMs } from '@mcp/code-agent/core/tool-timeouts.js';
import { capFor } from '@mcp/code-agent/core/runner/output-caps.js';
import type { ToolTier } from '@mcp/code-agent/tools/tiers.js';
import { buildCodeExecFailureHint, wrapToolsBinding } from '@mcp/code-agent/tools/code-exec-hints.js';
import { buildStashSandboxApi, createCodeExecStash } from '@mcp/code-agent/tools/code-exec-stash.js';
import { buildChangeSandboxApi } from '@mcp/code-agent/tools/code-exec-change.js';
import { completedReadResults } from './code-exec-partial-results.js';
import { getToolTier } from '@mcp/code-agent/tools/tiers.js';
import { paramSummary } from '@mcp/code-agent/tools/find-tools.js';
import { REPLACED_TOOL_NAMES, suggestToolName, toolReplacement } from '@mcp/code-agent/core/tool-name-suggest.js';
import { stableArgsKey } from '@mcp/code-agent/core/runner/dup-utils.js';
import { normalizeGuardInput } from '@mcp/code-agent/core/runner/guards/tuple-hash-dedup.js';
import { normalizeSourceTruncations } from '@mcp/code-agent/core/runner/tool-output-telemetry.js';
import { ToolCallLedger } from '@mcp/code-agent/core/tool-call-ledger.js';
import { renderBatchReturn } from '@mcp/code-agent/core/batch-return-format.js';
import { nestedToolConcurrencyGate } from './code-exec-concurrency.js';
import { preserveCodeExecEffectOutcome } from './code-exec-effect-outcome.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const WALL_TIMEOUT_MS = 35 * 60_000;
const DRAIN_TIMEOUT_MS = 5_000;
const ABORT_DRAIN_GRACE_MS = 250;
const MAX_TOOL_CALLS = 50;
const MAX_PARALLEL_TOOL_CALLS = 4;
const MAX_OUTPUT_BYTES = 50_000;
const PRIORITY_ERROR_LOG_RATIO = 0.2;
const MIN_PRIORITY_ERROR_LOG_BYTES = 1_024;
const MAX_PRIORITY_ERROR_LOG_BYTES = 16_384;

/**
 * Attach a rejection observer directly to every promise created by the
 * sandbox. The original promise remains rejected for `await`, `attempt()` and
 * `Promise.all`, while Node no longer reports it as unhandled if evaluation
 * stops before the script can attach its own consumer (for example, a later
 * array element references a sandbox-excluded control tool).
 *
 * A process-level `unhandledRejection` listener cannot provide this guarantee:
 * every listener still receives the event, so the worker crash classifier
 * would terminalize the run even if another listener tried to "swallow" it.
 */
function observeCodeExecPromise<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => undefined);
  return promise;
}
/**
 * Raised ceiling for sessions with `unrestricted_tool_output` on. NOT
 * Infinity — large outputs still pay context cost; this just lets verbose
 * Unity/MCP batches arrive intact in the turn that produced them. Override
 * with `CODER_UNRESTRICTED_CODE_EXEC_BYTES`.
 */
const UNRESTRICTED_MAX_OUTPUT_BYTES = 1_000_000;

const CODE_EXEC_DESC =
  'Execute a JS snippet that batches tool calls in one turn. Saves round-trips when you need to chain reads/searches/edits with logic, loops, or filtering.\n' +
  '\n' +
  'API inside the snippet:\n' +
  '  - `tools["exact-name"](args)` calls any registered tool that is callable inside code_exec, including hidden non-interactive tools under the same plan-mode and scope policy. Keep punctuation in the registered name, for example `tools["ext_codestudio-figma__get_metadata"](args)`. Dot notation and bare calls work for JavaScript identifier names such as `read_file`. Returns the tool text and throws on tool error.\n' +
  '  - `attempt(toolPromise)` — use ONLY for one probe that may legitimately fail. Returns `{ok:true,value}` or `{ok:false,error:{tool,code,kind,message,retryable,suggestedAction}}` so the rest of a `Promise.all` batch can finish. Policy refusals, permission errors, timeouts, and cancellations still throw.\n' +
  '  - `list_tools()` → `[{name, tier, params, description}]` for EVERY tool callable inside code_exec. `tool_schema(name)` introspects ANY registered tool and returns its full JSON Schema plus `callableInsideCodeExec` and `invokeAs`. When `invokeAs` is `top_level`, call that tool directly outside code_exec. Use these (or `find_tools({query})`) to discover exact names and args.\n' +
  '  - `log(...)` — appends to the captured output. JSON-friendly.\n' +
  '  - `stash.set(key, value)` / `stash.get(key)` / `stash.keys()` / `stash.delete(key)` — key-value store that PERSISTS across code_exec calls for the whole session (~2 MB, JSON values). Carry file content or intermediate results into a later script through the stash instead of printing them or re-reading files.\n' +
  '  - `change.*` — THIS SESSION\'s pending edits as a queryable object (reviewing your own work): `await change.files()` (shape-classified summary), `change.hunks(path)`, `change.raw(path)` → {before, after}, `change.symbol(path, name)` → before/after body, `change.callers(symbolName)`, `change.dependents(path)`, `change.search(regex, {side:"before"|"after"})`, `change.absences()` → untouched references of contract-changed symbols. Prefer these over re-reading files to audit what you changed.\n' +
  '  - `JSON`, `Math`, `String`, `Number`, `Boolean`, `Array`, `Object`, `Promise`, `Set`, `Map` are available.\n' +
  '  - The snippet runs as an async IIFE; await every tool promise and return the result. Never launch fire-and-forget calls.\n' +
  '  - No Node APIs: `require`/`import`/`process`/`fs`/`path`/`Buffer` are unavailable in the isolated evaluator. Use registered filesystem and shell tools.\n' +
  '\n' +
  'Policy: every tool call inside the script goes through the same plan-mode / task-scope policy as a direct call. ' +
  'Mutations must satisfy active mode, permission and task-scope gates. When Plan/Spec is active, obtain its required approval first; ordinary action mode does not create a new plan requirement. ' +
  'Interactive approvals, spawn/resume controls, task_complete and image/video tools are NOT executable inside code_exec — call them directly as top-level tools. `tool_schema(name)` remains safe for introspection.\n' +
  '\n' +
  'Limits: ' + DEFAULT_TIMEOUT_MS + ' ms default budget for the script\'s OWN JS time (max ' + MAX_TIMEOUT_MS + '); the clock PAUSES while a nested tool call runs, so long installs/builds via run_command/exec_command are fine (each keeps its own timeout). An absolute ' + WALL_TIMEOUT_MS + ' ms wall-clock backstop still bounds the whole batch. ' + MAX_TOOL_CALLS + ' tool calls per script, at most ' + MAX_PARALLEL_TOOL_CALLS + ' independent read calls at once; writes, commands and unknown classifications form sequential barriers, ' + (MAX_OUTPUT_BYTES / 1024) + ' KB captured console-log cap. Excess console output is counted and elided without aborting the script; the structured return is serialized separately.\n' +
  '\n' +
  'Example — required reads plus one optional symbol probe:\n' +
  '```\n' +
  'const [file, symbol] = await Promise.all([\n' +
  '  read_file({path:"src/core.ts"}),\n' +
  '  attempt(mcp__get_symbol_body({symbol_name:"maybeMissing", file_path:"src/core.ts"}))\n' +
  ']);\n' +
  'return {file, symbol};\n' +
  '```\n' +
  '\n' +
  'Example — exploration + sequential edits (when authorized by the active mode):\n' +
  '```\n' +
  'const grep = await tools.mcp__grep_code({ pattern: "from \\"@old/ui\\"", literal: true, max_results: 50 });\n' +
  'const files = [...new Set(grep.split("\\n").map(l => l.split(":")[0]).filter(Boolean))];\n' +
  'const out = [];\n' +
  'for (const f of files) {\n' +
  '  await tools.edit_file({ path: f, old_string: "from \\"@old/ui\\"", new_string: "from \\"@new/ui\\"" });\n' +
  '  out.push(f);\n' +
  '}\n' +
  'return `migrated ${out.length} files: ${out.join(", ")}`;\n' +
  '```\n' +
  '\n' +
  "USE: when an exploration would otherwise need 3+ sequential tool calls with simple logic between them.\n" +
  "USE: wrap only uncertain read/probe calls with attempt(...); keep required calls fail-fast.\n" +
  "RECOVERY: a failed batch may have completed earlier calls. Inspect results and reconcile unknown effects before retrying; never replay the whole batch blindly.\n" +
  "USE: when a refactor touches many files in the same way — one script beats N edit_file rounds.\n" +
  "DON'T: write large programs here — this is batched orchestration, not implementation. For complex logic, call tools directly across multiple turns.\n" +
  "DON'T: try to bypass plan-mode by calling mutating tools from inside code_exec — the policy applies the same way as direct calls.\n" +
  "DON'T: echo whole files — everything you log()/return lands verbatim in your context and is re-sent every turn. Return extracted facts and short summaries; keep bulk content in variables or `stash`.";

/**
 * Tools that can be exposed inside a code_exec script. Mutating tools are
 * allowed (per-call policy gates them at dispatch time, mirroring the
 * runner's plan-mode / task-scope checks). What we block here is the set
 * that doesn't make sense from inside a script:
 *
 *  - Interactive prompts (submit_plan, ask_user, ...) — they need the
 *    runner's pause/resume cycle, which we can't drive from inside a
 *    sync script.
 *  - Orchestration / recursion (spawn_*, code_exec itself)
 *    — would let a script spin up nested coder runs unbounded.
 *  - view_image — relies on `extraUserBlocks` injection, which only fires
 *    on direct tool dispatch.
 *  - Goal/plan/task lifecycle — these are control-plane boundaries whose
 *    result and durable session transition must stay attributable to a direct
 *    top-level tool_use id.
 */
type NestedRefusalError = Error & {
  code: string;
  refusalKind: string;
  tool: string;
  detail: string;
  guardVerdict: GuardVerdict;
};

type NestedToolExecutionError = Error & ToolErrorInfo & {
  tool: string;
  detail: string;
};

interface NestedOutcome {
  name: string;
  args: Record<string, unknown>;
  content: string;
  isError: boolean;
  delivered: boolean;
  readOnly: boolean;
  durationMs: number;
  status: 'succeeded' | 'failed' | 'refused' | 'cancelled';
  refusalKind?: string;
  error?: ToolErrorInfo;
}

function nestedToolExecutionError(
  tool: string,
  detail: string,
  info: ToolErrorInfo,
): NestedToolExecutionError {
  const error = new Error(`tool ${tool}: ${detail}`) as NestedToolExecutionError;
  error.name = 'NestedToolExecutionError';
  error.tool = tool;
  error.detail = detail;
  error.code = info.code;
  error.kind = info.kind;
  error.retryable = info.retryable;
  if (info.suggestedAction) error.suggestedAction = info.suggestedAction;
  return error;
}

function isNestedToolExecutionError(value: unknown): value is NestedToolExecutionError {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<NestedToolExecutionError>;
  return candidate.name === 'NestedToolExecutionError' &&
    typeof candidate.tool === 'string' &&
    typeof candidate.code === 'string' &&
    typeof candidate.kind === 'string';
}

function nestedErrorInfo(value: unknown): ToolErrorInfo | undefined {
  if (!isNestedToolExecutionError(value)) return undefined;
  return {
    code: value.code,
    kind: value.kind,
    retryable: value.retryable,
    ...(value.suggestedAction ? { suggestedAction: value.suggestedAction } : {}),
  };
}

function refusalErrorInfo(kind: string): ToolErrorInfo {
  return {
    code: 'TOOL_CALL_REFUSED',
    kind: 'refusal',
    retryable: false,
    suggestedAction: `Resolve the ${kind} refusal before issuing another call.`,
  };
}

function nestedRefusalError(
  tool: string,
  kind: string,
  detail: string,
  guardVerdict: GuardVerdict,
): NestedRefusalError {
  const error = new Error(`tool ${tool} refused (${kind}): ${detail}`) as NestedRefusalError;
  error.name = 'ToolCallRefusalError';
  error.code = 'TOOL_CALL_REFUSED';
  error.refusalKind = kind;
  error.tool = tool;
  error.detail = detail;
  error.guardVerdict = guardVerdict;
  return error;
}

function refusalVerdict(args: {
  tool: string;
  reason: string;
  refusalKind: string;
  shouldReflect?: boolean;
  stateEpoch: number;
  originToolUseId?: string;
}): GuardVerdict {
  return {
    action: 'block',
    reason: args.reason,
    refusalKind: args.refusalKind,
    shouldReflect: args.shouldReflect === true,
    affectsFailureStreak: false,
    sourceTool: args.tool,
    ...(args.originToolUseId ? { originToolUseId: args.originToolUseId } : {}),
    stateEpoch: args.stateEpoch,
  };
}

function isNestedRefusal(value: unknown): value is NestedRefusalError {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<NestedRefusalError>;
  return candidate.code === 'TOOL_CALL_REFUSED' && !!candidate.guardVerdict;
}

export function buildCodeExecTool(
  registry: ToolRegistry,
  tierOverrides?: ReadonlyMap<string, ToolTier>,
): CoderTool {
  return {
    name: 'code_exec',
    effectBoundary: 'nested',
    description: CODE_EXEC_DESC,
    source: 'native',
    outputPolicy: { mode: 'logs', reducer: 'smart', recovery: 'output_store', preserveOnError: true },
    mutates: false,
    // The wrapper itself owns no mutable resource. Nested shell/write calls
    // reserve the shared unsafe lane individually; reserving it for the parent
    // would deadlock when the first nested unsafe call tries to re-acquire it.
    parallelSafe: true,
    riskLevel: 'read',
    // The wrapper can contain arbitrary reads/writes and must never be reused
    // as though the script itself were a stable read.
    repeatPolicy: 'volatile',
    // Internal wall-clock watchdog fires first and returns structured nested
    // outcomes; this outer backstop is only a final guard around cleanup.
    timeoutMs: WALL_TIMEOUT_MS + DRAIN_TIMEOUT_MS + 1_000,
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'JS body executed as `async () => { <code> }`. Use top-level `await` and `return` the result.',
        },
        timeout_ms: {
          type: 'number',
          description: `Budget (ms) for the script's OWN JS work (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}). The clock is PAUSED while a nested tool call is in flight, so long installs/builds via run_command/exec_command don't trip it — each nested tool keeps its own timeout.`,
        },
      },
      required: ['code'],
      additionalProperties: false,
    },
    handler: async (args, ctx: ToolContext): Promise<ToolResult> => {

      const code = String(args.code ?? '');
      if (!code.trim()) {
        ctx.toolOutcomeScope?.markEvaluatorClosed();
        // PR 5 — guide the model towards the right tool when `code` is
        // missing. A bare "code cannot be empty" message in session 798
        // produced a 3ms failure with no clue what to do next.
        return err(
          'code_exec: `code` is required and non-empty. ' +
          'If you wanted to run a shell command, use `exec_command`. ' +
          'If you wanted to call a stored script, use `run_command` with the path. ' +
          'code_exec runs a JS snippet that can call other tools via the `tools` proxy.',
        );
      }
      const requested = typeof args.timeout_ms === 'number' ? args.timeout_ms : DEFAULT_TIMEOUT_MS;
      const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(500, requested));

      // Per-session tool-output cap LEVEL. Scales the script's output cap from
      // the 50 KB base (economic) up to ~1 MB (max) / ~4 MB (ultra) so batched
      // Unity / MCP work isn't truncated mid-flight. Auto-compaction still runs.
      const effectiveMaxOutput = capFor(
        ctx.toolOutputCapLevel ?? 'economic',
        MAX_OUTPUT_BYTES,
        UNRESTRICTED_MAX_OUTPUT_BYTES,
      );

      // Snapshot the registry once per invocation. Execution stays restricted
      // to safe tools, while read-only schema introspection may inspect all of
      // them (including control/lifecycle tools).
      const authority = ctx.nestedCapabilityDispatch;
      const allTools = registry.list().filter(t => !authority?.visibleToolNames || authority.visibleToolNames.has(t.name));
      const safe = allTools.filter(t => isSafeTool(t) && (!authority?.invocableToolNames || authority.invocableToolNames.has(t.name)));
      const exposedNames = safe.map((t) => t.name).sort();
      const exposedNameSet = new Set(exposedNames);
      const allNames = allTools.map((t) => t.name).sort();
      const allToolsByName = new Map(allTools.map((t) => [t.name, t]));
      // Full registry (incl. sandbox-excluded control/lifecycle tools) so the
      // ReferenceError hint below can tell "exists but not exposed here" apart
      // from "typo / absent Node global".
      const allToolNames = new Set(allNames);
      const logBuffer: string[] = [];
      const priorityErrorBuffer: string[] = [];
      let toolCalls = 0;
      let emittedLogBytes = 0;
      let retainedLogBytes = 0;
      let omittedLogBytes = 0;
      let omittedLogLines = 0;
      let priorityErrorBytes = 0;
      let stateEpoch = 0;
      let executionClosing = false;
      let executionAborting = false;
      // Both maps are scoped to THIS handler call: no result or counter can
      // leak into a later code_exec script.
      const stableCalls = new Map<string, {
        promise: Promise<string>;
        originToolUseId: string;
        count: number;
      }>();
      const activeToolPromises = new Set<Promise<unknown>>();
      const activeControllers = new Map<AbortController, number>();
      const nestedOutcomes: NestedOutcome[] = [];
      const nestedBlocks = new Map<number, NonNullable<ToolResult['extraUserBlocks']>>();
      // One shared FIFO lane per runner. Lightweight/standalone tests get an
      // invocation-local ledger with the exact same abortable queue contract.
      const unsafeLedger = ctx.toolCallLedger ?? new ToolCallLedger();
      const concurrencyGate = nestedToolConcurrencyGate(unsafeLedger, MAX_PARALLEL_TOOL_CALLS);

      const priorityErrorLimit = Math.max(
        MIN_PRIORITY_ERROR_LOG_BYTES,
        Math.min(MAX_PRIORITY_ERROR_LOG_BYTES, Math.floor(effectiveMaxOutput * PRIORITY_ERROR_LOG_RATIO)),
      );

      const formatLogLine = (parts: unknown[]): string => parts.map((p) => {
        if (typeof p === 'string') return p;
        try { return JSON.stringify(p); } catch { return String(p); }
      }).join(' ');

      const retainPriorityError = (line: string): void => {
        const prefix = '[console.error] ';
        const full = `${prefix}${line}`;
        const fullBytes = Buffer.byteLength(`${full}\n`, 'utf8');
        const utf8Tail = (value: string, maxBytes: number): string => {
          const bytes = Buffer.from(value, 'utf8');
          let start = Math.max(0, bytes.length - Math.max(0, maxBytes));
          while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
          return bytes.subarray(start).toString('utf8');
        };
        const entry = fullBytes <= priorityErrorLimit
          ? full
          : `${prefix}[tail preserved] ${utf8Tail(line, Math.max(1, priorityErrorLimit - 64))}`;
        const entryBytes = Buffer.byteLength(`${entry}\n`, 'utf8');
        priorityErrorBuffer.push(entry);
        priorityErrorBytes += entryBytes;
        while (priorityErrorBytes > priorityErrorLimit && priorityErrorBuffer.length > 1) {
          const removed = priorityErrorBuffer.shift()!;
          priorityErrorBytes -= Buffer.byteLength(`${removed}\n`, 'utf8');
        }
      };

      const appendCapturedLog = (level: 'log' | 'warn' | 'error', parts: unknown[], observedBytes?: number): void => {
        const line = formatLogLine(parts);
        const lineBytes = observedBytes === undefined ? Buffer.byteLength(`${line}\n`, 'utf8') : observedBytes + 1;
        emittedLogBytes += lineBytes;
        if (retainedLogBytes + lineBytes <= effectiveMaxOutput) {
          logBuffer.push(line);
          retainedLogBytes += lineBytes;
          return;
        }

        omittedLogLines++;
        omittedLogBytes += lineBytes;
        // A late diagnostic is often the only useful part of a noisy script.
        // Keep a small bounded tail for console.error without allowing verbose
        // logging to consume unbounded host memory or abort the script.
        if (level === 'error') retainPriorityError(line);
      };

      const appendLog = (...parts: unknown[]): void => {
        appendCapturedLog('log', parts);
      };

      const renderCapturedLogs = (): string => {
        const sections: string[] = [];
        if (logBuffer.length > 0) sections.push(logBuffer.join('\n'));
        if (omittedLogLines > 0) {
          sections.push(
            `[logs truncated: ${omittedLogLines} line(s), ${omittedLogBytes} byte(s) ` +
            `omitted from sequential output; log_cap=${effectiveMaxOutput} bytes]`,
          );
        }
        if (priorityErrorBuffer.length > 0) {
          sections.push(`[errors preserved after log cap]\n${priorityErrorBuffer.join('\n')}`);
        }
        return sections.join('\n');
      };

      // Excess console lines are discarded as they arrive. The output store
      // accepts only a complete string, so persisting the retained preview
      // would create a false promise of lossless recovery. Keep this source
      // cap explicitly irreversible until a bounded streaming spool exists.
      const withLogTruncation = (rawResult: ToolResult): ToolResult => {
        const extraUserBlocks = [...nestedBlocks].sort(([a], [b]) => a - b).flatMap(([, blocks]) => blocks);
        const result = preserveCodeExecEffectOutcome({ ...rawResult,
          ...(extraUserBlocks.length ? { extraUserBlocks } : {}),
        }, unsafeLedger);
        return omittedLogLines > 0 ? {
            ...result,
            sourceTruncations: [{
              technique: 'bounded-console-cap',
              inputSize: emittedLogBytes,
              outputSize: retainedLogBytes + priorityErrorBytes,
              unit: 'bytes',
              recoverable: false,
            }],
          }
        : result;
      };

      // Build the per-call policy context once; it reflects runner state at
      // the moment code_exec was dispatched. plan_approved / task_scope can
      // change DURING the script (e.g. a tool mutated state) — re-read them
      // per call inside the proxy.
      const runner = ctx.runner;
      const buildPolicyCtx = (): PolicyContext => ({
        planMode: runner ? !!(runner as unknown as { opts?: { planMode?: boolean } }).opts?.planMode : false,
        planApproved: runner ? runner.isPlanApproved() : true,
        specMode: runner?.specMode ?? false,
        specApproved: runner?.isSpecApproved?.() ?? false,
        taskScope: runner && runner.currentTaskScopeId()
          ? { id: runner.currentTaskScopeId()!, files: runner.currentTaskScopeFiles() ?? [] }
          : null,
        sandboxBound: !!ctx.ports?.fs || !!ctx.ports?.shell,
        readOnly: isReadOnlyAgent(runner?.agentId),
      });

      // JS-time budget controller. The timeout bounds the script's OWN JS work,
      // NOT time spent awaiting nested tool calls: while any tool call is in
      // flight the clock is PAUSED (codex `code_mode` model). A tool-free spin
      // still trips it; a script awaiting a 3-minute install does not.
      let budgetRemainingMs = timeout;
      let inFlight = 0;
      let clockTimer: ReturnType<typeof setTimeout> | null = null;
      let clockStartedAt = 0;
      let rejectTimeout: (e: Error) => void = () => {};
      const timeoutError = (): Error => Object.assign(
        new Error(`code_exec: timed out after ${timeout} ms (JS time)`),
        { code: 'CODE_EXEC_JS_TIMEOUT' },
      );
      const timeoutPromise = new Promise<never>((_, reject) => {
        rejectTimeout = reject;
      });
      let wallTimer: ReturnType<typeof setTimeout> | null = null;
      const wallDeadline = Date.now() + WALL_TIMEOUT_MS;
      const wallTimeoutError = (): Error => Object.assign(
        new Error(`code_exec: wall-clock limit exceeded after ${WALL_TIMEOUT_MS} ms`),
        { code: 'CODE_EXEC_WALL_TIMEOUT' },
      );
      const wallTimeoutPromise = new Promise<never>((_, reject) => {
        wallTimer = setTimeout(() => reject(wallTimeoutError()), WALL_TIMEOUT_MS);
      });
      const armClock = (): void => {
        if (executionClosing || clockTimer) return;
        clockStartedAt = Date.now();
        clockTimer = setTimeout(() => rejectTimeout(timeoutError()), budgetRemainingMs);
      };
      const pauseClock = (): void => {
        if (clockTimer) {
          clearTimeout(clockTimer);
          clockTimer = null;
          budgetRemainingMs -= Date.now() - clockStartedAt;
        }
      };
      const resumeClock = (): void => {
        if (executionClosing) return;
        if (budgetRemainingMs <= 0) {
          rejectTimeout(timeoutError());
          return;
        }
        armClock();
      };

      const toolsProxy: Record<string, (a: unknown) => Promise<string>> = {};
      const structuredRequests = new WeakSet<object>();
      const structuredResults = new WeakMap<object, ToolResult>();
      for (const t of safe) {
        const impl = async (rawArgs: unknown): Promise<string> => {
          if (executionClosing) {
            throw new Error('code_exec: script already finished; refusing a late nested call');
          }
          if (++toolCalls > MAX_TOOL_CALLS) {
            throw new Error(`code_exec: exceeded ${MAX_TOOL_CALLS} tool calls per script`);
          }
          const rawArgObj = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
          // Isolate normalized input before any approval/queue await. The script
          // must not change the resource after policy has approved it.
          const argObj = JSON.parse(JSON.stringify(normalizeGuardInput(t, rawArgObj))) as Record<string, unknown>;
          const invocationIndex = toolCalls;
          const metadata = resolveToolInvocationMetadata(t, argObj);
          const parallelRead = isExplicitlyParallelSafeRead(t);
          const observer = ctx.nestedToolObserver;
          const repeatable = metadata.repeatPolicy === 'pollable';
          const forceReread = argObj.force_reread === true;
          // A queued barrier invalidates earlier read promises immediately;
          // a later read must not coalesce across an intervening mutation.
          stateEpoch = parallelRead ? Math.max(stateEpoch, concurrencyGate.epoch) : concurrencyGate.invalidate();
          const callEpoch = stateEpoch;
          const attemptOrigin = `${ctx.currentToolUseId ?? ctx.approvalAnchorId ?? 'code_exec'}#${toolCalls}`;
          const nestedToolUseId =
            `nx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
          const nestedAuthority = ctx.nestedCapabilityDispatch;
          const hookBase = {
            toolUseId: nestedToolUseId,
            toolName: t.name,
            turn: nestedAuthority?.turn ?? 0,
            known: true,
          };
          let hookOutcome: {
            isError: boolean;
            refused: boolean;
            durationMs: number;
          } | undefined;
          const recordNestedOutcome = (input: {
            effectOutcome?: 'unknown';
            content: string;
            isError: boolean;
            durationMs: number;
            structuredData?: unknown;
            sourceTruncations?: ToolResult['sourceTruncations'];
            refusalKind?: string;
            error?: ToolErrorInfo;
            affectsFailureStreak?: boolean;
            guardVerdict?: GuardVerdict;
            delivered?: boolean;
          }) => {
            hookOutcome = {
              isError: input.isError,
              refused: input.refusalKind !== undefined,
              durationMs: input.durationMs,
            };
            const delivered = input.delivered !== false;
            const ledgerEntry = ctx.toolCallLedger?.record({
              name: t.name,
              args: argObj,
              content: input.content,
              isError: input.isError,
              structuredData: input.structuredData,
              refusalKind: input.refusalKind,
              mutates: metadata.mutates,
              riskLevel: metadata.riskLevel,
              durationMs: input.durationMs,
              executionClass: metadata.executionClass,
              repeatPolicy: metadata.repeatPolicy,
            });
            observer?.afterNestedCall({
              ...(input.effectOutcome ? { effectOutcome: input.effectOutcome } : {}),
              invocationId: attemptOrigin,
              name: t.name,
              args: argObj,
              isError: input.isError,
              durationMs: input.durationMs,
              resultChars: input.content.length,
              resultPreview: input.content,
              sourceTruncations: input.sourceTruncations,
              ...(input.refusalKind ? { refusalKind: input.refusalKind } : {}),
              logicalOperationId: ledgerEntry?.logicalOperationId,
              productive: ledgerEntry?.productive,
              resultNovel: ledgerEntry?.resultNovel,
              coverageNovel: ledgerEntry?.coverageNovel,
              repeatable,
              affectsFailureStreak: input.affectsFailureStreak,
              guardVerdict: input.guardVerdict,
              delivered,
              stateEpoch: callEpoch,
              repeatPolicy: metadata.repeatPolicy,
              executionClass: metadata.executionClass,
              failureStreakExempt: declaresPolling(t),
            });
            nestedOutcomes.push({
              name: t.name,
              args: argObj,
              content: input.content,
              isError: input.isError,
              delivered,
              readOnly: metadata.executionClass === 'read' && !metadata.mutates,
              durationMs: input.durationMs,
              status: !input.isError
                ? 'succeeded'
                : input.error?.kind === 'cancelled' || input.refusalKind === 'abort'
                  ? 'cancelled'
                  : input.error?.kind === 'refusal' || input.error?.kind === 'permission' ||
                      (input.refusalKind && input.refusalKind !== 'timeout')
                    ? 'refused'
                    : 'failed',
              ...(input.refusalKind ? { refusalKind: input.refusalKind } : {}),
              ...(input.error ? { error: input.error } : {}),
            });
            return ledgerEntry;
          };
          if (nestedAuthority?.capabilityHooks) {
            try {
              await nestedAuthority.capabilityHooks.before(hookBase);
            } catch {
              // Capability hooks are observation-only and never alter dispatch.
            }
          }
          try {
          const preflight = await nestedAuthority?.preflight?.({
            tool: t,
            toolUseId: nestedToolUseId,
            toolName: t.name,
            toolInput: argObj,
            turn: nestedAuthority.turn,
            toolMutates: metadata.mutates,
          });
          if (preflight) {
            const refusalKind = preflight.refusalKind ?? 'gate';
            const guardVerdict = preflight.guardVerdict ?? (
              preflight.isError
                ? refusalVerdict({
                    tool: t.name,
                    reason: 'preflight-gate',
                    refusalKind,
                    stateEpoch: callEpoch,
                    originToolUseId: attemptOrigin,
                  })
                : {
                    action: 'reuse' as const,
                    reason: 'preflight-reuse',
                    shouldReflect: false,
                    affectsFailureStreak: false,
                    sourceTool: t.name,
                    originToolUseId: attemptOrigin,
                    stateEpoch: callEpoch,
                  }
            );
            recordNestedOutcome({
              content: preflight.content,
              isError: preflight.isError,
              durationMs: 0,
              ...(preflight.isError ? {
                refusalKind,
                error: refusalErrorInfo(refusalKind),
                delivered: false,
              } : {}),
              affectsFailureStreak: false,
              guardVerdict,
            });
            if (preflight.isError) {
              throw nestedRefusalError(
                t.name,
                refusalKind,
                preflight.content,
                guardVerdict,
              );
            }
            return preflight.content;
          }
          // Standalone code_exec hosts keep the legacy local evaluator. Runner
          // dispatch supplies the unified preflight above, which is the sole
          // authority there so direct and nested decisions cannot diverge.
          if (!nestedAuthority?.preflight && !nestedAuthority?.invoke) {
            const policyCtx = buildPolicyCtx();
            const decision = evaluateToolInvocation(t, argObj, policyCtx);
            if (!decision.allowed) {
            // Mirror the runner's task-scope unlock: scopeAware + plan-mode
            // block + all candidate paths inside the active scope → run.
            const canUnlock =
              decision.reason === 'plan_mode' &&
              decision.metadata.scopeAware &&
              !!policyCtx.taskScope;
            let unlocked = false;
            if (canUnlock && policyCtx.taskScope) {
              const candidatePaths = extractPathsFromToolArgs(t.name, argObj);
              const violators = findScopeViolations(candidatePaths, policyCtx.taskScope.files, isPathInsideScope);
              unlocked = candidatePaths.length > 0 && violators.length === 0;
              if (!unlocked) {
                const detail =
                  `tool ${t.name} blocked: ${decision.detail} ` +
                   `Active task scope ${policyCtx.taskScope.id} declares files=[${policyCtx.taskScope.files.join(', ')}]; ` +
                   `tried to touch [${violators.join(', ')}].`;
                const guardVerdict = refusalVerdict({
                  tool: t.name, reason: 'policy-gate', refusalKind: 'gate', stateEpoch: callEpoch,
                  originToolUseId: attemptOrigin,
                });
                recordNestedOutcome({
                  content: detail, isError: true, durationMs: 0, refusalKind: 'gate',
                  error: refusalErrorInfo('gate'),
                  affectsFailureStreak: false, guardVerdict, delivered: false,
                });
                throw nestedRefusalError(t.name, 'gate', detail, guardVerdict);
              }
            }
            if (!unlocked) {
              const detail = `tool ${t.name} blocked: ${decision.detail}`;
              const guardVerdict = refusalVerdict({
                tool: t.name, reason: 'policy-gate', refusalKind: 'gate', stateEpoch: callEpoch,
                originToolUseId: attemptOrigin,
              });
              recordNestedOutcome({
                content: detail, isError: true, durationMs: 0, refusalKind: 'gate',
                error: refusalErrorInfo('gate'),
                affectsFailureStreak: false, guardVerdict, delivered: false,
              });
              throw nestedRefusalError(t.name, 'gate', detail, guardVerdict);
            }
            }
          }

          // A nested call is the same capability boundary as a direct call.
          // Reuse the visible code_exec invocation's exact scoped policy port,
          // with the normalized arguments that will reach the handler. Policy
          // evaluation failures intentionally bubble and fail closed.
          if (nestedAuthority?.policyShadow) {
            const shadow = await nestedAuthority.policyShadow({
              tool: t,
              toolUseId: nestedToolUseId,
              toolName: t.name,
              toolInput: argObj,
              turn: nestedAuthority.turn,
            });
            if (shadow?.refuse) {
              const guardVerdict = refusalVerdict({
                tool: t.name,
                reason: 'policy-gate',
                refusalKind: 'user_denied',
                stateEpoch: callEpoch,
                originToolUseId: attemptOrigin,
              });
              recordNestedOutcome({
                content: shadow.refusalText,
                isError: true,
                durationMs: 0,
                refusalKind: 'user_denied',
                error: refusalErrorInfo('user_denied'),
                affectsFailureStreak: false,
                guardVerdict,
                delivered: false,
              });
              throw nestedRefusalError(
                t.name,
                'user_denied',
                shadow.refusalText,
                guardVerdict,
              );
            }
          }

          // Permission must be decided before the local repetition observer:
          // a denial is not a tool attempt and must never advance its counter.
          inFlight += 1;
          if (inFlight === 1) pauseClock();
          try {
            if (ctx.permissionGate && !nestedAuthority?.invoke) {
              const decision = await ctx.permissionGate.check({
                outcomeRecovery: ctx.outcomeRecovery,
                toolUseId: nestedToolUseId,
                toolName: t.name,
                input: argObj,
                tool: t,
                parentToolUseId: ctx.approvalAnchorId ?? ctx.currentToolUseId,
                nested: true,
              });
              if (!decision.allowed) {
                const guardVerdict = refusalVerdict({
                  tool: t.name, reason: 'user-denied', refusalKind: 'user_denied', stateEpoch: callEpoch,
                  originToolUseId: attemptOrigin,
                });
                recordNestedOutcome({
                  content: decision.refusalText,
                  isError: true,
                  durationMs: 0,
                  refusalKind: 'user_denied',
                  error: refusalErrorInfo('user_denied'),
                  affectsFailureStreak: false,
                  guardVerdict,
                  delivered: false,
                });
                throw nestedRefusalError(t.name, 'user_denied', decision.refusalText, guardVerdict);
              }
            }

            const observedGuardVerdict = observer?.beforeNestedCall(t.name, argObj, {
              repeatable,
              repeatPolicy: metadata.repeatPolicy,
              failureStreakExempt: declaresPolling(t),
              executionClass: metadata.executionClass,
              stateEpoch: callEpoch,
              forceReread,
              originToolUseId: attemptOrigin,
            }) ?? null;
            const guardVerdict: (typeof observedGuardVerdict) = observedGuardVerdict
              ? {
                  ...observedGuardVerdict,
                  sourceTool: observedGuardVerdict.sourceTool ?? t.name,
                  originToolUseId: observedGuardVerdict.originToolUseId ?? attemptOrigin,
                }
              : null;
            if (guardVerdict?.action === 'block') {
              const kind = guardVerdict.refusalKind ?? guardVerdict.kind ?? 'dedup';
              const detail = guardVerdict.refusalText ?? `nested guard blocked ${t.name}`;
              recordNestedOutcome({
                content: detail,
                isError: true,
                durationMs: 0,
                refusalKind: kind,
                error: refusalErrorInfo(kind),
                affectsFailureStreak: guardVerdict.affectsFailureStreak,
                guardVerdict,
                delivered: false,
              });
              throw nestedRefusalError(t.name, kind, detail, guardVerdict);
            }

            const eligibleStableRead =
              metadata.repeatPolicy === 'stable' &&
              metadata.executionClass === 'read' &&
              !metadata.mutates &&
              metadata.parallelSafe &&
              !forceReread;
            const stableKey = eligibleStableRead && !structuredRequests.has(rawArgObj)
              ? `${t.name}|epoch:${callEpoch}|${stableArgsKey(argObj)}`
              : null;
            const cached = stableKey ? stableCalls.get(stableKey) : undefined;
            if (cached) {
              cached.count += 1;
              const reuseVerdict: GuardVerdict = {
                action: 'reuse',
                reason: 'same-scope-stable-call',
                shouldReflect: false,
                affectsFailureStreak: false,
                count: cached.count,
                sourceTool: t.name,
                originToolUseId: cached.originToolUseId,
                stateEpoch: callEpoch,
              };
              const started = Date.now();
              try {
                const content = await cached.promise;
                recordNestedOutcome({
                  content, isError: false, durationMs: Date.now() - started,
                  guardVerdict: reuseVerdict, affectsFailureStreak: false,
                });
                return content;
              } catch (e) {
                const content = e instanceof Error ? e.message : String(e);
                recordNestedOutcome({
                  content, isError: true, durationMs: Date.now() - started,
                  error: nestedErrorInfo(e) ?? inferToolErrorInfo(t.name, content),
                  guardVerdict: reuseVerdict, affectsFailureStreak: false,
                });
                throw e;
              }
            }

            const invokePhysical = async (): Promise<string> => {
              const perToolMs = Math.min(resolveToolTimeoutMs(t, argObj),
                ctx.deadlineAtEpochMs === undefined ? Infinity : Math.max(1, ctx.deadlineAtEpochMs - Date.now()));
              let toolTimer: ReturnType<typeof setTimeout> | null = null;
              let releaseCapacity: (() => void) | undefined;
              let releaseLane: (() => void) | undefined;
              let releasesOwnedByInvocation = false;
              let outcomeRecorded = false;
              let dispatched = false;
              let resultReceived = false;
              const mayHaveEffects = metadata.mutates || metadata.executionClass !== 'read'
                || metadata.riskLevel !== 'read' || t.effectBoundary !== undefined;
              const started = Date.now();
              // The controller and deadline exist BEFORE unsafe-lane
              // acquisition. A queued call can therefore time out/cancel
              // without waiting forever behind an uncooperative prior owner.
              const callAbort = new AbortController();
              activeControllers.set(callAbort, Math.min(started + perToolMs, wallDeadline));
              const parentAbort = (): void => {
                const reason = ctx.signal?.reason;
                try {
                  callAbort.abort(reason instanceof Error ? reason : new Error(`tool ${t.name} cancelled`));
                } catch { /* ignore */ }
              };
              if (ctx.signal?.aborted) parentAbort();
              else ctx.signal?.addEventListener('abort', parentAbort, { once: true });
              const cancelled = new Promise<never>((_, reject) => {
                const rejectCancelled = (): void => {
                  const reason = callAbort.signal.reason;
                  reject(reason instanceof Error ? reason : new Error(`tool ${t.name} cancelled`));
                };
                if (callAbort.signal.aborted) rejectCancelled();
                else callAbort.signal.addEventListener('abort', rejectCancelled, { once: true });
              });
              const timedOut = perToolMs === Infinity
                ? null
                : new Promise<never>((_, reject) => {
                    toolTimer = setTimeout(() => {
                      const error = Object.assign(
                        new Error(`tool ${t.name} timed out after ${perToolMs} ms`),
                        { code: 'TOOL_TIMEOUT' },
                      );
                      try { callAbort.abort(error); } catch { /* ignore */ }
                      reject(error);
                    }, perToolMs);
                  });
              try {
                releaseCapacity = await Promise.race([
                  concurrencyGate.reserve(parallelRead, callAbort.signal),
                  cancelled,
                  ...(timedOut ? [timedOut] : []),
                ]);
                if (metadata.mutates || !metadata.parallelSafe) {
                  // The deadline starts before queue acquisition so a call
                  // cannot wait forever behind an uncooperative owner. Attach
                  // both rejecting promises to a race immediately; otherwise
                  // a queued timeout rejects outside the script and reaches
                  // the worker as an `unhandledRejection`.
                  releaseLane = await Promise.race([
                    unsafeLedger.reserveUnsafe(callAbort.signal),
                    cancelled,
                    ...(timedOut ? [timedOut] : []),
                  ]);
                }
                if (executionAborting) {
                  const error = new Error(`tool ${t.name} cancelled because code_exec is aborting`);
                  try { callAbort.abort(error); } catch { /* ignore */ }
                  throw error;
                }
                const nestedContext: ToolContext = {
                  ...ctx,
                  toolCallLedger: unsafeLedger,
                  currentToolUseId: nestedToolUseId,
                  parentToolUseId:
                    ctx.currentToolUseId ?? ctx.parentToolUseId ?? ctx.approvalAnchorId,
                  signal: callAbort.signal,
                  deadlineAtEpochMs: Number.isFinite(perToolMs) ? Math.min(ctx.deadlineAtEpochMs ?? Infinity, started + perToolMs) : ctx.deadlineAtEpochMs,
                };
                const invocation = nestedAuthority?.invoke
                  ? nestedAuthority.invoke(t.name, argObj, nestedContext, () => { dispatched = true; })
                  : (() => { dispatched = true; return registry.invoke(t.name, argObj, nestedContext); })();
                // A timed-out handler may ignore AbortSignal. Keep both its
                // global-capacity permit and unsafe lane (when any) occupied
                // until the physical invocation settles, preventing runaway
                // overlap after the model-facing call has already returned.
                releasesOwnedByInvocation = true;
                const releaseInvocationResources = (): void => {
                  releaseLane?.();
                  releaseCapacity?.();
                };
                void invocation.then(releaseInvocationResources, releaseInvocationResources);
                const guarded = Promise.race([
                  invocation,
                  cancelled,
                  ...(timedOut ? [timedOut] : []),
                ]);
                const result = await guarded;
                if (structuredRequests.has(rawArgObj)) structuredResults.set(rawArgObj, result);
                resultReceived = true;
                if (result.extraUserBlocks?.length) nestedBlocks.set(invocationIndex, result.extraUserBlocks);
                let nestedContent = result.content;
                if (result.structuredData !== undefined) {
                  try {
                    nestedContent = JSON.stringify(result.structuredData) ?? result.content;
                  } catch {
                    // Keep the model-facing text when a third-party tool
                    // violates the JSON-serializable structured-data contract.
                  }
                }
                recordNestedOutcome({
                  content: nestedContent,
                  ...(result.effectOutcome ? { effectOutcome: result.effectOutcome } : {}),
                  isError: !!result.isError,
                  durationMs: Date.now() - started,
                  structuredData: result.structuredData,
                  sourceTruncations: normalizeSourceTruncations(result.sourceTruncations),
                  ...(result.isError
                    ? { error: result.error ?? inferToolErrorInfo(t.name, result.content) }
                    : {}),
                  // A handler-level block (e.g. the overwrite rule) is a refusal, not a failure.
                  ...(result.guardVerdict?.action === 'block' && result.guardVerdict.refusalKind
                    ? { refusalKind: result.guardVerdict.refusalKind } : {}),
                  guardVerdict: guardVerdict ?? undefined,
                });
                outcomeRecorded = true;
                if (result.isError) {
                  throw nestedToolExecutionError(
                    t.name,
                    result.content,
                    result.error ?? inferToolErrorInfo(t.name, result.content),
                  );
                }
                if (
                  metadata.mutates ||
                  metadata.repeatPolicy === 'mutating' ||
                  metadata.executionClass === 'write' ||
                  metadata.executionClass === 'execute'
                ) {
                  stateEpoch = concurrencyGate.invalidate();
                }
                return nestedContent;
              } catch (e) {
                // A timeout/cancellation settles the proxy, not necessarily
                // its physical mutation. Keep this sticky even if JS catches
                // the error or the handler eventually returns a late result.
                if (dispatched && !resultReceived && mayHaveEffects) unsafeLedger.markOutcomeUnknown(t.name);
                if (isNestedToolExecutionError(e) && outcomeRecorded) throw e;
                const errorText = e instanceof Error ? e.message : String(e);
                const refusalKind = (e as { code?: unknown })?.code === 'TOOL_TIMEOUT' || /timed out/i.test(errorText)
                  ? 'timeout'
                  : callAbort.signal.aborted ? 'abort' : undefined;
                const error = unsafeLedger.outcomeUnknownTool ? unknownToolOutcome(errorText).error! : refusalKind === 'abort'
                  ? inferToolErrorInfo(t.name, `tool ${t.name} cancelled`)
                  : inferToolErrorInfo(t.name, errorText);
                recordNestedOutcome({
                  content: errorText,
                  ...(dispatched && !resultReceived && mayHaveEffects ? { effectOutcome: 'unknown' as const } : {}),
                  isError: true,
                  durationMs: Date.now() - started,
                  ...(refusalKind ? { refusalKind } : {}),
                  error,
                  guardVerdict: guardVerdict ?? undefined,
                });
                outcomeRecorded = true;
                throw nestedToolExecutionError(t.name, errorText, error);
              } finally {
                if (toolTimer) clearTimeout(toolTimer);
                ctx.signal?.removeEventListener('abort', parentAbort);
                activeControllers.delete(callAbort);
                if (!releasesOwnedByInvocation) {
                  releaseLane?.();
                  releaseCapacity?.();
                }
              }
            };

            const physical = invokePhysical();
            if (stableKey) {
              stableCalls.set(stableKey, {
                promise: physical,
                originToolUseId: attemptOrigin,
                count: 1,
              });
            }
            try {
              return await physical;
            } catch (e) {
              // A failed stable result is shared only with already-concurrent
              // callers. A later retry gets a fresh physical invocation.
              if (stableKey && stableCalls.get(stableKey)?.promise === physical) {
                stableCalls.delete(stableKey);
              }
              throw e;
            }
          } finally {
            inFlight -= 1;
            if (inFlight === 0) resumeClock();
          }
          } finally {
            if (nestedAuthority?.capabilityHooks) {
              try {
                await nestedAuthority.capabilityHooks.after({
                  ...hookBase,
                  isError: hookOutcome?.isError ?? true,
                  refused: hookOutcome?.refused ?? false,
                  durationMs: hookOutcome?.durationMs ?? 0,
                });
              } catch {
                // Capability hooks are observation-only and never alter dispatch.
              }
            }
          }
        };
        toolsProxy[t.name] = (rawArgs: unknown): Promise<string> => {
          const p = observeCodeExecPromise(impl(rawArgs));
          activeToolPromises.add(p);
          void p.then(
            () => { activeToolPromises.delete(p); },
            () => { activeToolPromises.delete(p); },
          );
          return p;
        };
      }

      // Names of JS globals we never want to shadow with a tool. Any tool
      // that happens to share one of these gets the `tools.<name>` form
      // only — keeps `JSON`, `Math`, `Promise`, etc. predictable inside
      // user scripts.
      const RESERVED_GLOBALS = new Set([
        'JSON', 'Math', 'Number', 'String', 'Boolean', 'Array', 'Object',
        'Promise', 'Set', 'Map', 'Date', 'RegExp', 'Error', 'console', 'log',
        'tools', 'list_tools', 'tool_schema', 'attempt', 'stash', 'change',
      ]);
      // Shadow-safe bare-global aliases. Without this, the agent's natural
      // `await edit_file(...)` throws ReferenceError; with this, both
      // `tools.edit_file(...)` and `edit_file(...)` work. The sandbox has
      // no security boundary (declared above) so this is a UX choice, not
      // a privilege boundary.
      const bareGlobals: Record<string, (a: unknown) => Promise<string>> = {};
      for (const [name, fn] of Object.entries(toolsProxy)) {
        if (RESERVED_GLOBALS.has(name)) continue;
        bareGlobals[name] = fn;
      }
      // Registered control/lifecycle tools remain non-callable in code_exec,
      // but expose a rejection-shaped alias instead of leaving a bare
      // ReferenceError. This lets Promise.all attach to every earlier sibling
      // before the batch fails, so no partially evaluated promise is orphaned.
      // The message intentionally preserves the historical ReferenceError
      // wording consumed by buildCodeExecFailureHint.
      const blockedToolGlobals: Record<string, (_args: unknown) => Promise<never>> = {};
      for (const name of allNames) {
        if (
          exposedNameSet.has(name) ||
          RESERVED_GLOBALS.has(name) ||
          !/^[A-Za-z_$][\w$]*$/.test(name)
        ) {
          continue;
        }
        blockedToolGlobals[name] = () => observeCodeExecPromise(
          Promise.reject(new ReferenceError(`${name} is not defined`)),
        );
      }
      // Retired names (multi_edit, create_file, …) and unregistered primary
      // twins (mcp__read_file when read_file serves) reject with the
      // replacement instruction instead of a bare ReferenceError; they are not
      // aliases. The evaluator also answers tool_schema(<name>) with it.
      const retiredInstructions: Record<string, string> = {};
      for (const name of REPLACED_TOOL_NAMES) {
        if (exposedNameSet.has(name) || allToolsByName.has(name) || RESERVED_GLOBALS.has(name)) continue;
        retiredInstructions[name] = toolReplacement(name)!.text;
        blockedToolGlobals[name] = () => observeCodeExecPromise(
          Promise.reject(new Error(`${name}: ${retiredInstructions[name]}`)),
        );
      }

      // In-sandbox tool discovery. code_exec is tier-agnostic (it runs the full
      // catalog minus isSafeTool), but the model may not know a hidden tool's
      // name/args. `list_tools()` enumerates the callable surface; `tool_schema`
      // safely introspects the full registry without making control tools
      // executable in the sandbox.
      const listTools = (): Array<{ name: string; tier: string; params: string; description: string }> =>
        safe.map((t) => ({
          name: t.name,
          tier: getToolTier(t.name, tierOverrides),
          params: paramSummary(t.parameters),
          description: (t.description ?? '').split(/(?<=[.!?])\s+/)[0]?.slice(0, 180) ?? '',
        }));
      const toolSchema = (name: unknown): {
        name: string;
        tier: string;
        params: string;
        schema: unknown;
        callableInsideCodeExec: boolean;
        invokeAs: 'code_exec' | 'top_level';
      } => {
        const key = String(name ?? '');
        const t = allToolsByName.get(key);
        if (t) {
          const callableInsideCodeExec = exposedNameSet.has(t.name);
          return {
            name: t.name,
            tier: getToolTier(t.name, tierOverrides),
            params: paramSummary(t.parameters),
            schema: t.parameters ?? null,
            callableInsideCodeExec,
            invokeAs: callableInsideCodeExec ? 'code_exec' : 'top_level',
          };
        }
        const close = suggestToolName(key, allNames);
        throw new Error(
          `tool_schema: unknown tool "${key}"${close ? ` — did you mean "${close}"?` : ''}. ` +
          `Call list_tools() for the ${exposedNames.length} code_exec-callable tools ` +
          `or find_tools({query}) for the full catalog.`,
        );
      };

      const attemptImpl = async (operation: unknown): Promise<
        | { ok: true; value: unknown }
        | {
            ok: false;
            error: {
              tool: string;
              code: string;
              kind: string;
              message: string;
              retryable: boolean;
              suggestedAction?: string;
            };
          }
      > => {
        try {
          return { ok: true, value: await operation };
        } catch (e) {
          // attempt() is intentionally narrow: it handles an explicitly
          // optional tool probe, not arbitrary JS bugs or harness controls.
          if (isNestedRefusal(e) || !isNestedToolExecutionError(e)) throw e;
          if (e.kind === 'refusal' || e.kind === 'permission' || e.kind === 'timeout' || e.kind === 'cancelled') {
            throw e;
          }
          return {
            ok: false,
            error: {
              tool: e.tool,
              code: e.code,
              kind: e.kind,
              message: e.detail,
              retryable: e.retryable,
              ...(e.suggestedAction ? { suggestedAction: e.suggestedAction } : {}),
            },
          };
        }
      };
      const attempt = (operation: unknown): ReturnType<typeof attemptImpl> => (
        observeCodeExecPromise(attemptImpl(operation))
      );

      const sandbox: Context = {
        // Bare aliases first so the explicit fields below win on conflict
        // (e.g. a future tool named `JSON` would not shadow the global).
        ...blockedToolGlobals,
        ...bareGlobals,
        // Unknown `tools.<name>` access throws a suggestion-bearing error
        // instead of yielding undefined → "is not a function" (telemetry).
        tools: wrapToolsBinding(toolsProxy, exposedNames),
        list_tools: listTools,
        tool_schema: toolSchema,
        attempt,
        // Session-persistent stash (P1a pivot): ctx-provided in real sessions;
        // ephemeral per-call fallback keeps the API present in tests/subagents.
        stash: buildStashSandboxApi(ctx.codeExecStash ?? createCodeExecStash()),
        // Interrogable diff over THIS session's pending edits. Reference
        // queries route through the same nested proxy as any other call, so
        // guards/permissions/telemetry apply unchanged.
        ...(ctx.sessionChanges
          ? {
              change: buildChangeSandboxApi(
                ctx.sessionChanges,
                (name, args) => {
                  const fn = toolsProxy[name];
                  if (!fn) throw new Error(`change: tool ${name} is not callable here`);
                  return fn(args);
                },
                ctx.projectName,
              ),
            }
          : {}),
        log: appendLog,
        console: {
          log: (...parts: unknown[]) => appendCapturedLog('log', parts),
          warn: (...parts: unknown[]) => appendCapturedLog('warn', parts),
          error: (...parts: unknown[]) => appendCapturedLog('error', parts),
        },
        JSON,
        Math,
        Number,
        String,
        Boolean,
        Array,
        Object,
        Promise,
        Set,
        Map,
        Date,
        RegExp,
        Error,
        // Intentionally NO require/import/process/Buffer/global/__dirname.
      };

      // Pass the primary API as a formal parameter instead of letting the
      // snippet resolve it only through the vm global. A lexical declaration
      // such as `const [result, tools] = ...` otherwise shadows the injected
      // binding for the whole function body. If earlier array elements start
      // tool calls before a later `tools.*` access hits that TDZ, the script
      // aborts with several misleading nested-tool cancellations. Making
      // `tools` a parameter turns the shadow into a parse-time duplicate
      // declaration, before any physical tool call can start.
      const wrapped = `(async (tools) => {\n${code}\n})(tools)`;

      const settleActiveWithin = async (limitMs: number): Promise<boolean> => {
        const deadline = Date.now() + Math.max(0, limitMs);
        while (activeToolPromises.size > 0) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) return false;
          let timer: ReturnType<typeof setTimeout> | null = null;
          const settled = await Promise.race([
            Promise.allSettled([...activeToolPromises]).then(() => true),
            new Promise<false>((resolve) => {
              timer = setTimeout(() => resolve(false), remaining);
            }),
          ]);
          if (timer) clearTimeout(timer);
          if (!settled) return false;
        }
        return true;
      };

      const abortActiveCalls = (reason?: unknown): void => {
        executionAborting = true;
        const abortReason = reason instanceof Error
          ? reason
          : new Error(reason === undefined ? 'code_exec finished' : String(reason));
        for (const controller of activeControllers.keys()) {
          try { controller.abort(abortReason); } catch { /* ignore */ }
        }
      };

      const closeAndSettle = async (reason?: unknown, abortActive = false, drainMs = DRAIN_TIMEOUT_MS): Promise<boolean> => {
        executionClosing = true;
        pauseClock();
        if (clockTimer) {
          clearTimeout(clockTimer);
          clockTimer = null;
        }
        if (abortActive) abortActiveCalls(reason);

        // A detached continuation can enqueue one more proxy promise while a
        // sibling settles. Refuse late calls (executionClosing) and drain until
        // the set is genuinely empty, but never let an uncooperative nested
        // invocation pin the parent tool forever.
        const drained = await settleActiveWithin(drainMs);
        if (drained) return true;
        if (!abortActive) abortActiveCalls(reason ?? new Error('code_exec nested-call drain timed out'));
        await settleActiveWithin(ABORT_DRAIN_GRACE_MS);
        return false;
      };

      const unsettledResult = (): ToolResult => {
        const batch = buildNestedBatchReport();
        return {
          content:
            `code_exec stopped with nested calls still unsettled after ${DRAIN_TIMEOUT_MS} ms. ` +
            `Do not fire-and-forget tool calls; await every call.${batch.note}`,
          isError: true,
          error: {
            code: 'CODE_EXEC_UNSETTLED_CALLS',
            kind: 'timeout',
            retryable: true,
            suggestedAction: 'Await every nested tool promise and retry only the unfinished operations.',
          },
          structuredData: {
            kind: 'code_exec_failure',
            error: {
              code: 'CODE_EXEC_UNSETTLED_CALLS',
              kind: 'timeout',
              retryable: true,
              message: 'Nested tool calls did not settle before the bounded drain expired.',
            },
            nested: {
              summary: batch.summary,
              output_id: batch.outputId,
              outcomes: nestedOutcomes,
            },
          },
        };
      };

      const buildNestedBatchReport = (): {
        note: string;
        summary: {
          total: number;
          succeeded: number;
          failed: number;
          refused: number;
          cancelled: number;
          unsettled: number;
        };
        outputId: string | null;
      } => {
        const summary = {
          total: toolCalls,
          succeeded: nestedOutcomes.filter((entry) => entry.status === 'succeeded').length,
          failed: nestedOutcomes.filter((entry) => entry.status === 'failed').length,
          refused: nestedOutcomes.filter((entry) => entry.status === 'refused').length,
          cancelled: nestedOutcomes.filter((entry) => entry.status === 'cancelled').length,
          unsettled: Math.max(0, toolCalls - nestedOutcomes.length),
        };
        if (toolCalls === 0 && nestedOutcomes.length === 0) {
          return { note: '', summary, outputId: null };
        }
        const payload = JSON.stringify({
          kind: 'code_exec_nested_outcomes',
          summary,
          results: nestedOutcomes,
        }, null, 2);
        const outputId = ctx.toolOutputStore?.put(payload) ?? null;
        const counts =
          `total=${summary.total}, succeeded=${summary.succeeded}, failed=${summary.failed}, ` +
          `refused=${summary.refused}, cancelled=${summary.cancelled}, unsettled=${summary.unsettled}`;
        const reads = completedReadResults(nestedOutcomes);
        if (outputId) {
          return {
            note: `\n\n[nested call summary: ${counts}; ` +
              `full outcomes preserved in get_tool_output({output_id:"${outputId}"}).]${reads}`,
            summary,
            outputId,
          };
        }
        const names = nestedOutcomes.map((entry) => `${entry.name}:${entry.status}`).slice(0, 8).join(', ');
        return {
          note: `\n\n[nested call summary: ${counts}${names ? `; ${names}` : ''}.]${reads}`,
          summary,
          outputId: null,
        };
      };

      // Arm the JS-time budget BEFORE running: invoking the async IIFE executes
      // its synchronous prefix immediately, so a script that opens with
      // `await tools.foo()` calls `pauseClock()` during `runInNewContext`. The
      // clock must already be armed for that pause to subtract correctly. The
      // clock pauses itself while a nested tool call is in flight (see the proxy
      // `impl` above), so it only fires on the script's own JS work — not on
      // time spent awaiting tools. The sync `timeout` option covers synchronous
      // infinite loops, which never reach an await.
      let evaluator: ReturnType<typeof superviseCodeExec> | undefined;
      let scriptPromise: Promise<unknown>;
      try {
        {
          const stashApi = sandbox.stash as ReturnType<typeof buildStashSandboxApi>;
          evaluator = superviseCodeExec({
            code: wrapped, timeoutMs: timeout, maxOutputBytes: effectiveMaxOutput,
            priorityErrorBytes: MAX_PRIORITY_ERROR_LOG_BYTES,
            tools: exposedNames, blocked: Object.keys(blockedToolGlobals), retired: retiredInstructions,
            schemas: allNames.map(toolSchema), listing: listTools(),
            changes: Object.keys(sandbox.change ?? {}),
            stash: (stashApi.keys as () => string[])().map(key => [key, (stashApi.get as (k: string) => unknown)(key)]),
            stashMaxBytes: ctx.codeExecStash?.maxBytes?.() ?? 2_000_000,
          }, {
            ready: armClock,
            log: (level, parts, inputBytes) => appendCapturedLog(level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log', parts, inputBytes),
            logOmission: (lines, bytes) => { omittedLogLines += lines; omittedLogBytes += bytes; emittedLogBytes += bytes; },
            stash: (op, key, value) => {
              if (op === 'set') (stashApi.set as (k: string, v: unknown) => void)(key, value);
              else if (op === 'delete') (stashApi.delete as (k: string) => void)(key);
              else throw new Error('Invalid stash operation');
            },
            invoke: async (kind, name, input) => {
              if (executionClosing) throw new Error('code_exec execution is closing');
              if (kind === 'change') {
                const fn = sandbox.change?.[name];
                if (typeof fn !== 'function' || !Array.isArray(input)) throw new Error('Invalid change operation');
                return fn(...input);
              }
              if (kind !== 'tool' && kind !== 'structured') throw new Error('Invalid invocation kind');
              const fn = sandbox.tools[name] as (args: unknown) => Promise<string>;
              const args = input && typeof input === 'object' ? input : {};
              if (kind === 'structured') structuredRequests.add(args);
              const text = await fn(args);
              if (kind !== 'structured') return text;
              const result = structuredResults.get(args);
              return { text: result?.content ?? text, data: result?.structuredData, evidence: result?.evidence,
                isError: result?.isError ?? false, error: result?.error, effectOutcome: result?.effectOutcome,
                completeness: result?.sourceTruncations?.length ? 'partial' : 'complete',
                sourceTruncations: result?.sourceTruncations,
                extraUserBlocks: result?.extraUserBlocks };
            },
          });
          scriptPromise = evaluator.promise;
        }
      } catch (e) {
        await evaluator?.close();
        ctx.toolOutcomeScope?.markEvaluatorClosed();
        await closeAndSettle(e, true);
        if (wallTimer) clearTimeout(wallTimer);
        const msg = e instanceof Error ? e.message : String(e);
        // Parse-time failures get hints too — `import x from 'y'` dies here
        // ("Cannot use import statement"), never reaching the async catch.
        const hint = buildCodeExecFailureHint(msg, { exposedNames, allToolNames });
        return withLogTruncation(err(`code_exec parse/sync error: ${msg}${hint}`, {
          code: 'CODE_EXEC_PARSE_ERROR',
          kind: 'invalid_input',
          retryable: false,
          suggestedAction: 'Correct the JavaScript syntax before retrying.',
        }));
      }

      let returnValue: unknown;
      try {
        returnValue = await Promise.race([scriptPromise, timeoutPromise, wallTimeoutPromise]);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Close admission before waiting for the evaluator to exit. A queued
        // sibling must not start just because the failed call released its lane.
        executionClosing = true;
        executionAborting = true;
        await evaluator?.close();
        // A known tool error (e.g. a diagnostic command exiting 1) is not a
        // cancellation of another command that already started. Drain that
        // command first: aborting it here used to manufacture an unknown effect
        // and permanently block an otherwise recoverable conversation.
        // Explicit cancellation/deadlines/unknown effects still abort promptly;
        // remaining siblings retain their original tool deadlines, capped by
        // the batch wall limit. The short fire-and-forget drain must not cut a
        // legitimate command's already-admitted timeout to five seconds.
        const failureCode = (e as { code?: unknown })?.code;
        const cancelImmediately = ctx.signal?.aborted === true
          || !!unsafeLedger.outcomeUnknownTool
          || failureCode === 'CODE_EXEC_WALL_TIMEOUT'
          || failureCode === 'CODE_EXEC_JS_TIMEOUT';
        const drainMs = cancelImmediately ? DRAIN_TIMEOUT_MS : Math.max(0, Math.min(
          wallDeadline - Date.now(),
          Math.max(Date.now(), ...activeControllers.values()) - Date.now() + ABORT_DRAIN_GRACE_MS,
        ));
        await closeAndSettle(e, cancelImmediately, drainMs);
        // Defense-in-depth hints (wrong call shape, control tool, absent Node
        // builtin, import, nested-failure try/catch) — see code-exec-hints.ts.
        // Matching is on message text, never instanceof: errors thrown inside
        // node:vm carry the sandbox realm's constructors.
        const hint = buildCodeExecFailureHint(msg, { exposedNames, allToolNames });
        const capturedLogs = renderCapturedLogs();
        const stderr = capturedLogs ? `\n[output before failure]\n${capturedLogs}` : '';
        const batch = buildNestedBatchReport();
        const codeExecTimeout = (e as { code?: unknown })?.code === 'CODE_EXEC_WALL_TIMEOUT'
          ? {
              code: 'CODE_EXEC_WALL_TIMEOUT',
              kind: 'timeout' as const,
              retryable: true,
              suggestedAction: 'Split the batch into smaller awaited code_exec calls.',
            }
          : (e as { code?: unknown })?.code === 'CODE_EXEC_JS_TIMEOUT'
            ? {
                code: 'CODE_EXEC_JS_TIMEOUT',
                kind: 'timeout' as const,
                retryable: true,
                suggestedAction: 'Reduce synchronous JavaScript work or split the batch.',
              }
            : null;
        const errorInfo = isNestedRefusal(e)
          ? refusalErrorInfo(e.refusalKind)
          : codeExecTimeout ?? nestedErrorInfo(e) ?? {
              code: 'CODE_EXEC_FAILED',
              kind: 'internal' as const,
              retryable: false,
              suggestedAction: 'Inspect the script error and change the failing operation before retrying.',
            };
        const result: ToolResult = {
          content: `code_exec ${(e as Error)?.name === 'SyntaxError' ? 'parse/sync error' : 'failed'}: ${msg}${hint}${stderr}${batch.note}`,
          isError: true,
          error: errorInfo,
          structuredData: {
            kind: 'code_exec_failure',
            error: {
              ...errorInfo,
              message: isNestedToolExecutionError(e) ? e.detail : msg,
              ...(isNestedToolExecutionError(e) ? { tool: e.tool } : {}),
            },
            nested: {
              summary: batch.summary,
              output_id: batch.outputId,
              outcomes: nestedOutcomes,
            },
          },
        };
        if (isNestedRefusal(e)) result.guardVerdict = e.guardVerdict;
        return withLogTruncation(result);
      } finally {
        await evaluator?.close();
        ctx.toolOutcomeScope?.markEvaluatorClosed();
        if (clockTimer) clearTimeout(clockTimer);
        if (wallTimer) clearTimeout(wallTimer);
      }

      // Fire-and-forget proxy calls are still owned by this batch. Let them
      // settle before returning, while preventing a late sibling from rearming
      // the JS clock after the parent has completed.
      const drained = await closeAndSettle();
      if (!drained) return withLogTruncation(unsettledResult());

      const lines: string[] = [];
      const omissionSummary = omittedLogLines > 0
        ? `, console_truncated=${omittedLogLines} line(s)/${omittedLogBytes} byte(s)`
        : '';
      lines.push(
        `code_exec: ${toolCalls} tool call(s), ${(emittedLogBytes / 1024).toFixed(1)} KB console emitted, ` +
        `${((retainedLogBytes + priorityErrorBytes) / 1024).toFixed(1)} KB retained` +
        `${omissionSummary}, exposed=${exposedNames.length} tools`,
      );
      const capturedLogs = renderCapturedLogs();
      if (capturedLogs) {
        lines.push('');
        lines.push('[output]');
        lines.push(capturedLogs);
      }
      if (returnValue !== undefined) {
        lines.push('');
        lines.push('[return]');
        // Text values (tool outputs) stay raw in labeled sections instead of
        // one JSON-escaped string; small structured values remain JSON.
        lines.push(renderBatchReturn(returnValue));
      }
      const out = lines.join('\n');
      // Console capture is already memory-bounded above. A large structured
      // return must reach the central finalizer unchanged so it is spilled
      // once, reduced with full context, and measured truthfully.
      return withLogTruncation(ok(out));
    },
  };
}

/** Test-only: which tool names a code_exec built right now would expose. */
export function _exposedToolNames(registry: ToolRegistry): string[] {
  return registry.list().filter(isSafeTool).map((t) => t.name).sort();
}

/** Test-only: effective physical fan-out ceiling for one code_exec batch. */
export const _maxParallelToolCalls = MAX_PARALLEL_TOOL_CALLS;
