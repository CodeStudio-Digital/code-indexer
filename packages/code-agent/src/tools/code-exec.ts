/**
 * code_exec — execute a JS snippet that batches tool calls.
 *
 * Inspired by codex's `code_mode` / `exec` tool. Lets the model collapse a
 * multi-turn exploration into a single turn by writing a script that calls
 * the registry's read/search tools through async function proxies.
 *
 * Scope:
 *  - Read/search AND mutating/shell tools are exposed (write_file, edit_file,
 *    multi_edit, manage_path, run_command, exec_command, git_*); each nested
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
import { runInNewContext, type Context } from 'node:vm';
import type { CoderTool, GuardVerdict, ToolContext, ToolErrorInfo, ToolResult } from '@mcp/code-agent/core/tool.js';
import type { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { inferToolErrorInfo } from '@mcp/code-agent/core/tool-error-info.js';
import { evaluateToolInvocation, findScopeViolations, resolveToolMetadata, type PolicyContext } from '@mcp/code-agent/core/policy.js';
import { extractPathsFromToolArgs, isPathInsideScope } from '@mcp/code-agent/core/runner.js';
import { resolveToolTimeoutMs } from '@mcp/code-agent/core/tool-timeouts.js';
import { maybeTerse } from '@mcp/code-agent/tools/descriptions.js';
import { capFor } from '@mcp/code-agent/core/runner/output-caps.js';
import { capToolContent } from '@mcp/code-agent/core/runner/pure-helpers.js';
import { buildCodeExecFailureHint, wrapToolsBinding } from '@mcp/code-agent/tools/code-exec-hints.js';
import { buildStashSandboxApi, createCodeExecStash } from '@mcp/code-agent/tools/code-exec-stash.js';
import { buildChangeSandboxApi } from '@mcp/code-agent/tools/code-exec-change.js';
import { getToolTier } from '@mcp/code-agent/tools/tiers.js';
import { paramSummary } from '@mcp/code-agent/tools/find-tools.js';
import { suggestToolName } from '@mcp/code-agent/core/tool-name-suggest.js';
import { stableArgsKey } from '@mcp/code-agent/core/runner/dup-utils.js';
import { normalizeGuardInput } from '@mcp/code-agent/core/runner/guards/tuple-hash-dedup.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_TOOL_CALLS = 50;
const MAX_OUTPUT_BYTES = 50_000;

/**
 * Promises returned by an active code_exec toolsProxy. The module-level
 * `unhandledRejection` listener below swallows ONLY rejections whose promise
 * sits in this set — anything outside code_exec keeps Node's default
 * "terminate on unhandled rejection" behavior. Without this guard, a script
 * that writes `files.forEach(f => edit_file({...}))` (fire-and-forget) takes
 * the whole host down: the proxy throw becomes an unhandled rejection that
 * never reached the script's `await`.
 */
const ownedToolPromises = new WeakSet<Promise<unknown>>();
let unhandledHandlerInstalled = false;
function ensureUnhandledHandler(): void {
  if (unhandledHandlerInstalled) return;
  unhandledHandlerInstalled = true;
  process.on('unhandledRejection', (reason, promise) => {
    if (!ownedToolPromises.has(promise as Promise<unknown>)) return;
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.warn(`[code_exec] swallowed fire-and-forget tool rejection: ${msg}`);
  });
}
/**
 * Raised ceiling for sessions with `unrestricted_tool_output` on. NOT
 * Infinity — large outputs still pay context cost; this just lets verbose
 * Unity/MCP batches arrive intact in the turn that produced them. Override
 * with `CODER_UNRESTRICTED_CODE_EXEC_BYTES`.
 */
const UNRESTRICTED_MAX_OUTPUT_BYTES = Number(
  process.env.CODER_UNRESTRICTED_CODE_EXEC_BYTES ?? 1_000_000,
);

const CODE_EXEC_DESC =
  'Execute a JS snippet that batches tool calls in one turn. Saves round-trips when you need to chain reads/searches/edits with logic, loops, or filtering.\n' +
  '\n' +
  'API inside the snippet:\n' +
  '  - `tools.<name>(args)` OR `<name>(args)` — both work. Calls any registered tool that is callable inside code_exec, INCLUDING non-interactive tools that are NOT in your current visible toolset / tier, so you never need `expand_toolset` to reach those tools from here (the per-call plan-mode / task-scope policy still applies to each call). The bare-global alias exists for every tool whose name does not collide with a JS builtin (read_file, edit_file, mcp__grep_code, etc). Returns the tool\'s text content (string). Throws on tool error.\n' +
  '  - `attempt(toolPromise)` — use ONLY for one probe that may legitimately fail. Returns `{ok:true,value}` or `{ok:false,error:{tool,code,kind,message,retryable,suggestedAction}}` so the rest of a `Promise.all` batch can finish. Policy refusals, permission errors, timeouts, and cancellations still throw.\n' +
  '  - `list_tools()` → `[{name, tier, params, description}]` for EVERY tool callable inside code_exec. `tool_schema(name)` introspects ANY registered tool and returns its full JSON Schema plus `callableInsideCodeExec` and `invokeAs`. When `invokeAs` is `top_level`, call that tool directly outside code_exec. Use these (or `find_tools({query})`) to discover exact names and args.\n' +
  '  - `log(...)` — appends to the captured output. JSON-friendly.\n' +
  '  - `stash.set(key, value)` / `stash.get(key)` / `stash.keys()` / `stash.delete(key)` — key-value store that PERSISTS across code_exec calls for the whole session (~2 MB, JSON values). Carry file content or intermediate results into a later script through the stash instead of printing them or re-reading files.\n' +
  '  - `change.*` — THIS SESSION\'s pending edits as a queryable object (reviewing your own work): `await change.files()` (shape-classified summary), `change.hunks(path)`, `change.raw(path)` → {before, after}, `change.symbol(path, name)` → before/after body, `change.callers(symbolName)`, `change.dependents(path)`, `change.search(regex, {side:"before"|"after"})`, `change.absences()` → untouched references of contract-changed symbols. Prefer these over re-reading files to audit what you changed.\n' +
  '  - `JSON`, `Math`, `String`, `Number`, `Boolean`, `Array`, `Object`, `Promise`, `Set`, `Map` are available.\n' +
  '  - The snippet runs as an async IIFE; use top-level `await` and `return` the result.\n' +
  '  - NO Node runtime: `require`/`import`/`process`/`fs`/`path`/`Buffer` are NOT available (this is a node:vm sandbox, not Node). For file I/O call the registered `write_file`/`create_file` tools; for shell, `exec_command`.\n' +
  '\n' +
  'Policy: every tool call inside the script goes through the same plan-mode / task-scope policy as a direct call. ' +
  'Mutating tools (write_file, edit_file, multi_edit, create_file, manage_path, apply_patch, git_add/commit/branch) work only when the plan is approved (or the active task scope unlocks the touched paths). ' +
  'Interactive prompts (decision_gate, submit_plan, submit_tasks, task_list, ask_user), orchestration tools (spawn_*, expand_toolset), and task-lifecycle tools (task_complete, execute_task) are NOT executable inside code_exec — call them directly as top-level tools. `tool_schema(name)` remains safe for introspection.\n' +
  '\n' +
  'Limits: ' + DEFAULT_TIMEOUT_MS + ' ms default budget for the script\'s OWN JS time (max ' + MAX_TIMEOUT_MS + '); the clock PAUSES while a nested tool call runs, so long installs/builds via run_command/exec_command are fine (each keeps its own timeout). ' + MAX_TOOL_CALLS + ' tool calls per script, ' + (MAX_OUTPUT_BYTES / 1024) + ' KB output cap.\n' +
  '\n' +
  'Example — required reads plus one optional symbol probe:\n' +
  '```\n' +
  'const [file, symbol] = await Promise.all([\n' +
  '  mcp__read_file({file_path:"src/core.ts"}),\n' +
  '  attempt(mcp__get_symbol_body({symbol_name:"maybeMissing", file_path:"src/core.ts"}))\n' +
  ']);\n' +
  'return {file, symbol};\n' +
  '```\n' +
  '\n' +
  'Example — exploration + batched edit (after plan approval):\n' +
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
 *  - Orchestration / recursion (spawn_*, code_exec itself, expand_toolset)
 *    — would let a script spin up nested coder runs unbounded.
 *  - view_image — relies on `extraUserBlocks` injection, which only fires
 *    on direct tool dispatch.
 *  - Plan/task lifecycle (execute_task, task_complete) — same pause/resume
 *    coupling as the interactive prompts.
 */
function isSafeTool(tool: CoderTool): boolean {
  if (resolveToolMetadata(tool).interactive) return false;
  if (
    tool.name === 'spawn_agent' ||
    tool.name === 'code_exec' ||
    tool.name.startsWith('spawn_') ||
    tool.name === 'execute_task' ||
    tool.name === 'task_complete' ||
    tool.name === 'expand_toolset' ||
    tool.name === 'view_image'
  ) return false;
  return true;
}

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

export function buildCodeExecTool(registry: ToolRegistry): CoderTool {
  return {
    name: 'code_exec',
    description: maybeTerse(CODE_EXEC_DESC),
    source: 'native',
    mutates: false,
    // The wrapper itself owns no mutable resource. Nested shell/write calls
    // reserve the shared unsafe lane individually; reserving it for the parent
    // would deadlock when the first nested unsafe call tries to re-acquire it.
    parallelSafe: true,
    riskLevel: 'read',
    // The wrapper can contain arbitrary reads/writes and must never be reused
    // as though the script itself were a stable read.
    repeatPolicy: 'volatile',
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
        // PR 5 — guide the model towards the right tool when `code` is
        // missing. A bare "code cannot be empty" message in session 798
        // produced a 3ms failure with no clue what to do next.
        return err(
          'code_exec: `code` is required and non-empty. ' +
          'If you wanted to run a shell command, use `exec_command`. ' +
          'If you wanted to call a stored script, use `run_command` with the path. ' +
          'code_exec runs an in-process JS snippet that can call other tools via the `tools` proxy.',
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

      // Make sure the host doesn't crash if the model's script fires a
      // tool call without awaiting it (the proxy throws into a Promise
      // nobody owns). Idempotent — installs the listener at most once.
      ensureUnhandledHandler();

      // Snapshot the registry once per invocation. Execution stays restricted
      // to safe tools, while read-only schema introspection may inspect all of
      // them (including control/lifecycle tools).
      const allTools = registry.list();
      const safe = allTools.filter(isSafeTool);
      const exposedNames = safe.map((t) => t.name).sort();
      const exposedNameSet = new Set(exposedNames);
      const allNames = allTools.map((t) => t.name).sort();
      const allToolsByName = new Map(allTools.map((t) => [t.name, t]));
      // Full registry (incl. sandbox-excluded control/lifecycle tools) so the
      // ReferenceError hint below can tell "exists but not exposed here" apart
      // from "typo / absent Node global".
      const allToolNames = new Set(allNames);
      const logBuffer: string[] = [];
      let toolCalls = 0;
      let outputBytes = 0;
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
      const activeControllers = new Set<AbortController>();
      const nestedOutcomes: NestedOutcome[] = [];
      // Reservation chain for mutating / non-parallel-safe tools. A timed-out
      // caller gets its rejection promptly, but the lane is held until the
      // underlying invocation actually settles, preventing late writes from
      // racing the next call.
      let unsafeLane: Promise<void> = Promise.resolve();
      const reserveLocalUnsafe = async (): Promise<() => void> => {
        const prior = unsafeLane;
        let release!: () => void;
        const reservation = new Promise<void>((resolve) => { release = resolve; });
        unsafeLane = prior.then(() => reservation, () => reservation);
        await prior;
        return release;
      };

      const appendLog = (...parts: unknown[]): void => {
        const line = parts.map((p) => {
          if (typeof p === 'string') return p;
          try { return JSON.stringify(p); } catch { return String(p); }
        }).join(' ');
        outputBytes += line.length + 1;
        if (outputBytes > effectiveMaxOutput) {
          throw new Error(`code_exec: output cap (${effectiveMaxOutput} bytes) exceeded`);
        }
        logBuffer.push(line);
      };

      // Build the per-call policy context once; it reflects runner state at
      // the moment code_exec was dispatched. plan_approved / task_scope can
      // change DURING the script (e.g. a tool mutated state) — re-read them
      // per call inside the proxy.
      const runner = ctx.runner;
      const buildPolicyCtx = (): PolicyContext => ({
        planMode: runner ? !!(runner as unknown as { opts?: { planMode?: boolean } }).opts?.planMode : false,
        planApproved: runner ? runner.isPlanApproved() : true,
        taskScope: runner && runner.currentTaskScopeId()
          ? { id: runner.currentTaskScopeId()!, files: runner.currentTaskScopeFiles() ?? [] }
          : null,
        strict: false,
        adminOverride: true,
        sandboxBound: !!ctx.ports?.fs || !!ctx.ports?.shell,
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
      const timeoutError = (): Error => new Error(`code_exec: timed out after ${timeout} ms (JS time)`);
      const timeoutPromise = new Promise<never>((_, reject) => {
        rejectTimeout = reject;
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
      for (const t of safe) {
        const metadata = resolveToolMetadata(t);
        const impl = async (rawArgs: unknown): Promise<string> => {
          if (executionClosing) {
            throw new Error('code_exec: script already finished; refusing a late nested call');
          }
          if (++toolCalls > MAX_TOOL_CALLS) {
            throw new Error(`code_exec: exceeded ${MAX_TOOL_CALLS} tool calls per script`);
          }
          const rawArgObj = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
          const argObj = normalizeGuardInput(t, rawArgObj);
          const observer = ctx.nestedToolObserver;
          const repeatable = metadata.repeatPolicy === 'pollable';
          const forceReread = argObj.force_reread === true;
          const callEpoch = stateEpoch;
          const attemptOrigin = `${ctx.currentToolUseId ?? ctx.approvalAnchorId ?? 'code_exec'}#${toolCalls}`;
          const recordNestedOutcome = (input: {
            content: string;
            isError: boolean;
            durationMs: number;
            refusalKind?: string;
            error?: ToolErrorInfo;
            affectsFailureStreak?: boolean;
            guardVerdict?: GuardVerdict;
            delivered?: boolean;
          }) => {
            const delivered = input.delivered !== false;
            const ledgerEntry = ctx.toolCallLedger?.record({
              name: t.name,
              args: argObj,
              content: input.content,
              isError: input.isError,
              refusalKind: input.refusalKind,
              mutates: metadata.mutates,
              durationMs: input.durationMs,
              executionClass: metadata.executionClass,
              repeatPolicy: metadata.repeatPolicy,
            });
            observer?.afterNestedCall({
              name: t.name,
              args: argObj,
              isError: input.isError,
              durationMs: input.durationMs,
              resultChars: input.content.length,
              resultPreview: input.content,
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
            });
            nestedOutcomes.push({
              name: t.name,
              args: argObj,
              content: input.content,
              isError: input.isError,
              delivered,
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

          // Permission must be decided before the local repetition observer:
          // a denial is not a tool attempt and must never advance its counter.
          inFlight += 1;
          if (inFlight === 1) pauseClock();
          try {
            if (ctx.permissionGate) {
              const decision = await ctx.permissionGate.check({
                toolUseId: `nx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
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
            const stableKey = eligibleStableRead
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
              const perToolMs = resolveToolTimeoutMs(t);
              let toolTimer: ReturnType<typeof setTimeout> | null = null;
              let releaseLane: (() => void) | undefined;
              let laneReleaseOwnedByInvocation = false;
              const started = Date.now();
              try {
                if (metadata.mutates || !metadata.parallelSafe) {
                  const sharedReserve = ctx.toolCallLedger?.reserveUnsafe;
                  releaseLane = typeof sharedReserve === 'function'
                    ? await sharedReserve.call(ctx.toolCallLedger)
                    : await reserveLocalUnsafe();
                }
                if (executionAborting) {
                  const content = `tool ${t.name} cancelled because code_exec is aborting`;
                  const error = inferToolErrorInfo(t.name, content);
                  recordNestedOutcome({
                    content,
                    isError: true,
                    durationMs: Date.now() - started,
                    refusalKind: 'abort',
                    error,
                  });
                  throw nestedToolExecutionError(t.name, content, error);
                }
                const callAbort = new AbortController();
                activeControllers.add(callAbort);
                const parentAbort = (): void => {
                  try { callAbort.abort(ctx.signal?.reason); } catch { /* ignore */ }
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
                const invocation = registry.invoke(t.name, argObj, { ...ctx, signal: callAbort.signal });
                const cleanupAbort = (): void => {
                  ctx.signal?.removeEventListener('abort', parentAbort);
                  activeControllers.delete(callAbort);
                };
                void invocation.then(cleanupAbort, cleanupAbort);
                if (releaseLane) {
                  laneReleaseOwnedByInvocation = true;
                  void invocation.then(releaseLane, releaseLane);
                }
                const guarded = Promise.race([
                  invocation,
                  cancelled,
                  ...(perToolMs === Infinity ? [] : [new Promise<never>((_, reject) => {
                    toolTimer = setTimeout(() => {
                      const error = new Error(`tool ${t.name} timed out after ${perToolMs} ms`);
                      try { callAbort.abort(error); } catch { /* ignore */ }
                      reject(error);
                    }, perToolMs);
                  })]),
                ]);
                let result: Awaited<typeof invocation>;
                try {
                  result = await guarded;
                } catch (e) {
                  const errorText = e instanceof Error ? e.message : String(e);
                  const refusalKind = /timed out/i.test(errorText)
                    ? 'timeout'
                    : callAbort.signal.aborted ? 'abort' : undefined;
                  const error = refusalKind === 'abort'
                    ? inferToolErrorInfo(t.name, `tool ${t.name} cancelled`)
                    : inferToolErrorInfo(t.name, errorText);
                  recordNestedOutcome({
                    content: errorText,
                    isError: true,
                    durationMs: Date.now() - started,
                    ...(refusalKind ? { refusalKind } : {}),
                    error,
                    guardVerdict: guardVerdict ?? undefined,
                  });
                  throw nestedToolExecutionError(t.name, errorText, error);
                }
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
                  isError: !!result.isError,
                  durationMs: Date.now() - started,
                  ...(result.isError
                    ? { error: result.error ?? inferToolErrorInfo(t.name, result.content) }
                    : {}),
                  guardVerdict: guardVerdict ?? undefined,
                });
                if (result.isError) {
                  throw nestedToolExecutionError(
                    t.name,
                    result.content,
                    result.error ?? inferToolErrorInfo(t.name, result.content),
                  );
                }
                if (
                  metadata.mutates ||
                  metadata.executionClass === 'write' ||
                  metadata.executionClass === 'execute'
                ) {
                  stateEpoch += 1;
                }
                return nestedContent;
              } finally {
                if (toolTimer) clearTimeout(toolTimer);
                if (releaseLane && !laneReleaseOwnedByInvocation) releaseLane();
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
        };
        toolsProxy[t.name] = (rawArgs: unknown): Promise<string> => {
          const p = impl(rawArgs);
          ownedToolPromises.add(p);
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

      // In-sandbox tool discovery. code_exec is tier-agnostic (it runs the full
      // catalog minus isSafeTool), but the model may not know a hidden tool's
      // name/args. `list_tools()` enumerates the callable surface; `tool_schema`
      // safely introspects the full registry without making control tools
      // executable in the sandbox.
      const listTools = (): Array<{ name: string; tier: string; params: string; description: string }> =>
        safe.map((t) => ({
          name: t.name,
          tier: getToolTier(t.name),
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
            tier: getToolTier(t.name),
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

      const attempt = async (operation: unknown): Promise<
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

      const sandbox: Context = {
        // Bare aliases first so the explicit fields below win on conflict
        // (e.g. a future tool named `JSON` would not shadow the global).
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
        console: { log: appendLog, warn: appendLog, error: appendLog },
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

      // Wrap as async IIFE so user code can use top-level await + return.
      const wrapped = `(async () => {\n${code}\n})()`;

      const closeAndSettle = async (reason?: unknown, abortActive = false): Promise<void> => {
        executionClosing = true;
        if (abortActive) executionAborting = true;
        pauseClock();
        if (clockTimer) {
          clearTimeout(clockTimer);
          clockTimer = null;
        }
        if (abortActive) {
          const abortReason = reason instanceof Error
            ? reason
            : new Error(reason === undefined ? 'code_exec finished' : String(reason));
          for (const controller of activeControllers) {
            try { controller.abort(abortReason); } catch { /* ignore */ }
          }
        }
        // A detached continuation can enqueue one more proxy promise while a
        // sibling settles. Refuse late calls (executionClosing) and drain until
        // the set is genuinely empty.
        while (activeToolPromises.size > 0) {
          await Promise.allSettled([...activeToolPromises]);
        }
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
        if (outputId) {
          return {
            note: `\n\n[nested call summary: ${counts}; ` +
              `full outcomes preserved in get_tool_output({output_id:"${outputId}"}).]`,
            summary,
            outputId,
          };
        }
        const names = nestedOutcomes.map((entry) => `${entry.name}:${entry.status}`).slice(0, 8).join(', ');
        return {
          note: `\n\n[nested call summary: ${counts}${names ? `; ${names}` : ''}.]`,
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
      armClock();
      let scriptPromise: Promise<unknown>;
      try {
        scriptPromise = runInNewContext(wrapped, sandbox, {
          timeout: timeout, // protects against synchronous infinite loops
          filename: 'code_exec.js',
        }) as Promise<unknown>;
      } catch (e) {
        await closeAndSettle(e, true);
        const msg = e instanceof Error ? e.message : String(e);
        // Parse-time failures get hints too — `import x from 'y'` dies here
        // ("Cannot use import statement"), never reaching the async catch.
        const hint = buildCodeExecFailureHint(msg, { exposedNames, allToolNames });
        return err(`code_exec parse/sync error: ${msg}${hint}`, {
          code: 'CODE_EXEC_PARSE_ERROR',
          kind: 'invalid_input',
          retryable: false,
          suggestedAction: 'Correct the JavaScript syntax before retrying.',
        });
      }

      let returnValue: unknown;
      try {
        returnValue = await Promise.race([scriptPromise, timeoutPromise]);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Once the script has failed it cannot consume any sibling result.
        // Cancel cooperative work, then settle every proxy before returning;
        // already-completed siblings remain available in nestedOutcomes.
        await closeAndSettle(e, true);
        // Defense-in-depth hints (wrong call shape, control tool, absent Node
        // builtin, import, nested-failure try/catch) — see code-exec-hints.ts.
        // Matching is on message text, never instanceof: errors thrown inside
        // node:vm carry the sandbox realm's constructors.
        const hint = buildCodeExecFailureHint(msg, { exposedNames, allToolNames });
        const stderr = logBuffer.length > 0 ? `\n[output before failure]\n${logBuffer.join('\n')}` : '';
        const batch = buildNestedBatchReport();
        const errorInfo = isNestedRefusal(e)
          ? refusalErrorInfo(e.refusalKind)
          : nestedErrorInfo(e) ?? {
              code: 'CODE_EXEC_FAILED',
              kind: 'internal' as const,
              retryable: false,
              suggestedAction: 'Inspect the script error and change the failing operation before retrying.',
            };
        const result: ToolResult = {
          content: `code_exec failed: ${msg}${hint}${stderr}${batch.note}`,
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
        return result;
      } finally {
        if (clockTimer) clearTimeout(clockTimer);
      }

      // Fire-and-forget proxy calls are still owned by this batch. Let them
      // settle before returning, while preventing a late sibling from rearming
      // the JS clock after the parent has completed.
      await closeAndSettle();

      const lines: string[] = [];
      lines.push(`code_exec: ${toolCalls} tool call(s), ${(outputBytes / 1024).toFixed(1)} KB output, exposed=${exposedNames.length} tools`);
      if (logBuffer.length > 0) {
        lines.push('');
        lines.push('[output]');
        lines.push(logBuffer.join('\n'));
      }
      if (returnValue !== undefined) {
        lines.push('');
        lines.push('[return]');
        if (typeof returnValue === 'string') {
          lines.push(returnValue);
        } else {
          try { lines.push(JSON.stringify(returnValue, null, 2)); } catch { lines.push(String(returnValue)); }
        }
      }
      const out = lines.join('\n');
      if (out.length > effectiveMaxOutput) {
        const outputId = ctx.toolOutputStore?.put(out) ?? undefined;
        return ok(capToolContent(out, effectiveMaxOutput, outputId, 'code_exec').content);
      }
      return ok(out);
    },
  };
}

/** Test-only: which tool names a code_exec built right now would expose. */
export function _exposedToolNames(registry: ToolRegistry): string[] {
  return registry.list().filter(isSafeTool).map((t) => t.name).sort();
}
