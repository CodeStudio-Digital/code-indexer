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
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import type { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { evaluateToolInvocation, findScopeViolations, type PolicyContext } from '@mcp/code-agent/core/policy.js';
import { extractPathsFromToolArgs, isPathInsideScope } from '@mcp/code-agent/core/runner.js';
import { resolveToolTimeoutMs } from '@mcp/code-agent/core/tool-timeouts.js';
import { maybeTerse } from '@mcp/code-agent/tools/descriptions.js';
import { capFor } from '@mcp/code-agent/core/runner/output-caps.js';
import { buildCodeExecFailureHint, wrapToolsBinding } from '@mcp/code-agent/tools/code-exec-hints.js';
import { buildStashSandboxApi, createCodeExecStash } from '@mcp/code-agent/tools/code-exec-stash.js';
import { truncationMarker } from '@mcp/code-agent/tools/truncation-marker.js';
import { getToolTier } from '@mcp/code-agent/tools/tiers.js';
import { paramSummary } from '@mcp/code-agent/tools/find-tools.js';
import { suggestToolName } from '@mcp/code-agent/core/tool-name-suggest.js';

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
  '  - `tools.<name>(args)` OR `<name>(args)` — both work. Calls ANY registered tool, INCLUDING tools that are NOT in your current visible toolset / tier: code_exec runs against the full tool catalog, so you never need `expand_toolset` to reach a tool from in here (the per-call plan-mode / task-scope policy still applies to each call). The bare-global alias exists for every tool whose name does not collide with a JS builtin (read_file, edit_file, mcp__grep_code, etc). Returns the tool\'s text content (string). Throws on tool error.\n' +
  '  - `list_tools()` → `[{name, tier, params, description}]` for EVERY callable tool (incl. ones hidden from your visible toolset). `tool_schema(name)` → that tool\'s full JSON Schema. Use these (or `find_tools({query})`) to discover the exact name + args of a tool you cannot see, then call it directly here.\n' +
  '  - `log(...)` — appends to the captured output. JSON-friendly.\n' +
  '  - `stash.set(key, value)` / `stash.get(key)` / `stash.keys()` / `stash.delete(key)` — key-value store that PERSISTS across code_exec calls for the whole session (~2 MB, JSON values). Carry file content or intermediate results into a later script through the stash instead of printing them or re-reading files.\n' +
  '  - `JSON`, `Math`, `String`, `Number`, `Boolean`, `Array`, `Object`, `Promise`, `Set`, `Map` are available.\n' +
  '  - The snippet runs as an async IIFE; use top-level `await` and `return` the result.\n' +
  '  - NO Node runtime: `require`/`import`/`process`/`fs`/`path`/`Buffer` are NOT available (this is a node:vm sandbox, not Node). For file I/O call the registered `write_file`/`create_file` tools; for shell, `exec_command`.\n' +
  '\n' +
  'Policy: every tool call inside the script goes through the same plan-mode / task-scope policy as a direct call. ' +
  'Mutating tools (write_file, edit_file, multi_edit, create_file, manage_path, apply_patch, git_add/commit/branch) work only when the plan is approved (or the active task scope unlocks the touched paths). ' +
  'Interactive prompts (submit_plan, submit_tasks, ask_user), orchestration tools (spawn_*, expand_toolset), and task-lifecycle tools (task_complete, execute_task) are NOT exposed — call them directly outside code_exec.\n' +
  '\n' +
  'Limits: ' + DEFAULT_TIMEOUT_MS + ' ms default budget for the script\'s OWN JS time (max ' + MAX_TIMEOUT_MS + '); the clock PAUSES while a nested tool call runs, so long installs/builds via run_command/exec_command are fine (each keeps its own timeout). ' + MAX_TOOL_CALLS + ' tool calls per script, ' + (MAX_OUTPUT_BYTES / 1024) + ' KB output cap.\n' +
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
  if (tool.interactive) return false;
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

export function buildCodeExecTool(registry: ToolRegistry): CoderTool {
  return {
    name: 'code_exec',
    description: maybeTerse(CODE_EXEC_DESC),
    source: 'native',
    mutates: false,
    parallelSafe: false,
    riskLevel: 'read',
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

      // Build the tools proxy: one async function per safe registered tool.
      const safe = registry.list().filter(isSafeTool);
      const exposedNames = safe.map((t) => t.name).sort();
      // Full registry (incl. sandbox-excluded control/lifecycle tools) so the
      // ReferenceError hint below can tell "exists but not exposed here" apart
      // from "typo / absent Node global".
      const allToolNames = new Set(registry.list().map((t) => t.name));
      const logBuffer: string[] = [];
      let toolCalls = 0;
      let outputBytes = 0;

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
        if (budgetRemainingMs <= 0) {
          rejectTimeout(timeoutError());
          return;
        }
        armClock();
      };

      const toolsProxy: Record<string, (a: unknown) => Promise<string>> = {};
      for (const t of safe) {
        const impl = async (rawArgs: unknown): Promise<string> => {
          if (++toolCalls > MAX_TOOL_CALLS) {
            throw new Error(`code_exec: exceeded ${MAX_TOOL_CALLS} tool calls per script`);
          }
          const argObj = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
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
                throw new Error(
                  `tool ${t.name} blocked: ${decision.detail} ` +
                  `Active task scope ${policyCtx.taskScope.id} declares files=[${policyCtx.taskScope.files.join(', ')}]; ` +
                  `tried to touch [${violators.join(', ')}].`,
                );
              }
            }
            if (!unlocked) {
              throw new Error(`tool ${t.name} blocked: ${decision.detail}`);
            }
          }
          // Nested loop guards (tuple-hash dedup + failure-streak pre-check),
          // AFTER the policy gate so blocked calls don't pollute the dedup
          // counter — same ordering as top-level dispatch. A refusal is a
          // catchable JS exception, like every other nested failure.
          const observer = ctx.nestedToolObserver;
          const nestedRefusal =
            observer?.beforeNestedCall(t.name, argObj, { repeatable: !!t.repeatable }) ?? null;
          if (nestedRefusal) {
            observer?.afterNestedCall({
              name: t.name,
              args: argObj,
              isError: true,
              durationMs: 0,
              resultChars: nestedRefusal.refusalText.length,
              resultPreview: nestedRefusal.refusalText,
              refusalKind: nestedRefusal.kind,
            });
            throw new Error(`tool ${t.name} refused: ${nestedRefusal.refusalText}`);
          }
          // Pause the JS-time budget while this tool runs (the script is not
          // charged for time inside a tool), and bound the tool by its OWN tier
          // so a hung tool can't stall the batch — `run_command` gets its 10-min
          // budget, reads get NORMAL, etc.
          inFlight += 1;
          if (inFlight === 1) pauseClock();
          const perToolMs = resolveToolTimeoutMs(t);
          let toolTimer: ReturnType<typeof setTimeout> | null = null;
          try {
            // Permission gate (modes 'ask'/'auto') — INSIDE the try so a
            // denial throw still hits the finally (inFlight/clock restore),
            // and BEFORE the per-tool timer so the user's decision time is
            // free. The clock is already paused (inFlight ≥ 1), so the
            // script's JS budget isn't burned while waiting. The approval
            // card anchors to the chat-visible code_exec block.
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
                // Same propagation shape as the policy-block throw above —
                // the script sees the denial as a JS exception.
                throw new Error(decision.refusalText);
              }
            }
            const t0 = Date.now();
            const invocation = registry.invoke(t.name, argObj, ctx);
            const guarded =
              perToolMs === Infinity
                ? invocation
                : Promise.race([
                    invocation,
                    new Promise<never>((_, rej) => {
                      toolTimer = setTimeout(
                        () => rej(new Error(`tool ${t.name} timed out after ${perToolMs} ms`)),
                        perToolMs,
                      );
                    }),
                  ]);
            let result: Awaited<typeof invocation>;
            try {
              result = await guarded;
            } catch (e) {
              // Timeout / unexpected throw — still an invocation outcome the
              // failure-streak state (and telemetry) must see.
              observer?.afterNestedCall({
                name: t.name,
                args: argObj,
                isError: true,
                durationMs: Date.now() - t0,
                resultChars: 0,
                resultPreview: e instanceof Error ? e.message : String(e),
              });
              throw e;
            }
            observer?.afterNestedCall({
              name: t.name,
              args: argObj,
              isError: !!result.isError,
              durationMs: Date.now() - t0,
              resultChars: result.content.length,
              resultPreview: result.content,
            });
            if (result.isError) {
              throw new Error(`tool ${t.name}: ${result.content}`);
            }
            return result.content;
          } finally {
            if (toolTimer) clearTimeout(toolTimer);
            inFlight -= 1;
            if (inFlight === 0) resumeClock();
          }
        };
        toolsProxy[t.name] = (rawArgs: unknown): Promise<string> => {
          const p = impl(rawArgs);
          ownedToolPromises.add(p);
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
        'tools', 'list_tools', 'tool_schema', 'stash',
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
      // returns one tool's full schema — no prior `find_tools` turn required.
      const listTools = (): Array<{ name: string; tier: string; params: string; description: string }> =>
        safe.map((t) => ({
          name: t.name,
          tier: getToolTier(t.name),
          params: paramSummary(t.parameters),
          description: (t.description ?? '').split(/(?<=[.!?])\s+/)[0]?.slice(0, 180) ?? '',
        }));
      const toolSchema = (name: unknown): { name: string; tier: string; params: string; schema: unknown } => {
        const key = String(name ?? '');
        const t = safe.find((x) => x.name === key);
        if (t) {
          return { name: t.name, tier: getToolTier(t.name), params: paramSummary(t.parameters), schema: t.parameters ?? null };
        }
        // Registered but sandbox-excluded (control/lifecycle) → say so instead
        // of a bare "unknown", mirroring the ReferenceError hint's distinction.
        if (allToolNames.has(key)) {
          throw new Error(
            `tool_schema: "${key}" is registered but NOT callable inside code_exec ` +
            `(control/lifecycle tool). Call it directly as a top-level tool.`,
          );
        }
        const close = suggestToolName(key, exposedNames);
        throw new Error(
          `tool_schema: unknown tool "${key}"${close ? ` — did you mean "${close}"?` : ''}. ` +
          `Call list_tools() to enumerate the ${exposedNames.length} callable tools.`,
        );
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
        // Session-persistent stash (P1a pivot): ctx-provided in real sessions;
        // ephemeral per-call fallback keeps the API present in tests/subagents.
        stash: buildStashSandboxApi(ctx.codeExecStash ?? createCodeExecStash()),
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
        if (clockTimer) clearTimeout(clockTimer);
        const msg = e instanceof Error ? e.message : String(e);
        // Parse-time failures get hints too — `import x from 'y'` dies here
        // ("Cannot use import statement"), never reaching the async catch.
        const hint = buildCodeExecFailureHint(msg, { exposedNames, allToolNames });
        return err(`code_exec parse/sync error: ${msg}${hint}`);
      }

      let returnValue: unknown;
      try {
        returnValue = await Promise.race([scriptPromise, timeoutPromise]);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Defense-in-depth hints (wrong call shape, control tool, absent Node
        // builtin, import, nested-failure try/catch) — see code-exec-hints.ts.
        // Matching is on message text, never instanceof: errors thrown inside
        // node:vm carry the sandbox realm's constructors.
        const hint = buildCodeExecFailureHint(msg, { exposedNames, allToolNames });
        const stderr = logBuffer.length > 0 ? `\n[output before failure]\n${logBuffer.join('\n')}` : '';
        return err(`code_exec failed: ${msg}${hint}${stderr}`);
      } finally {
        if (clockTimer) clearTimeout(clockTimer);
      }

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
        // Recovery steers AWAY from the re-read/re-print loop (telemetry:
        // 34% of code_exec outputs truncated → model re-read the files and
        // printed them again). The durable fix is the stash, not a retry.
        return ok(out.slice(0, effectiveMaxOutput) + `\n${truncationMarker(
          `output exceeded ${effectiveMaxOutput} bytes`,
          'do NOT re-run to re-print — stash bulk content (stash.set) and return only extracted facts',
        )}`);
      }
      return ok(out);
    },
  };
}

/** Test-only: which tool names a code_exec built right now would expose. */
export function _exposedToolNames(registry: ToolRegistry): string[] {
  return registry.list().filter(isSafeTool).map((t) => t.name).sort();
}
