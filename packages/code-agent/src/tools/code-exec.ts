/**
 * code_exec — execute a JS snippet that batches tool calls.
 *
 * Inspired by codex's `code_mode` / `exec` tool. Lets the model collapse a
 * multi-turn exploration into a single turn by writing a script that calls
 * the registry's read/search tools through async function proxies.
 *
 * Scope (v1):
 *  - Read-only and search tools only. Mutating tools (write_file, edit_file,
 *    multi_edit, manage_path, run_command, git_*) are NOT exposed. Direct tool calls
 *    are still the path for those — they go through plan-mode policy.
 *  - Sandbox is `node:vm` (NOT a security boundary; the agent is trusted —
 *    same trust level as direct tool calls). Timeout via Promise.race plus
 *    a per-tool-call counter to bound runaway scripts.
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
import { maybeTerse } from '@mcp/code-agent/tools/descriptions.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_TOOL_CALLS = 50;
const MAX_OUTPUT_BYTES = 50_000;

/**
 * Node globals the sandbox intentionally omits (see the `sandbox` object's
 * trailing comment). A script reaching for one of these gets a bare
 * `ReferenceError: <name> is not defined`; we recognize the name to emit a
 * precise nudge toward the registered tools instead of an opaque failure.
 */
const ABSENT_NODE_GLOBALS = new Set([
  'require', 'import', 'module', 'exports', 'process', 'Buffer',
  '__dirname', '__filename', 'global', 'globalThis', 'fetch',
]);

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
  '  - `tools.<name>(args)` OR `<name>(args)` — both work. The latter is a bare-global alias for every registered tool whose name does not collide with a JS builtin (read_file, edit_file, mcp__grep_code, etc). Returns the tool\'s text content (string). Throws on tool error.\n' +
  '  - `log(...)` — appends to the captured output. JSON-friendly.\n' +
  '  - `JSON`, `Math`, `String`, `Number`, `Boolean`, `Array`, `Object`, `Promise`, `Set`, `Map` are available.\n' +
  '  - The snippet runs as an async IIFE; use top-level `await` and `return` the result.\n' +
  '  - NO Node runtime: `require`/`import`/`process`/`fs`/`path`/`Buffer` are NOT available (this is a node:vm sandbox, not Node). For file I/O call the registered `write_file`/`create_file` tools; for shell, `exec_command`.\n' +
  '\n' +
  'Policy: every tool call inside the script goes through the same plan-mode / task-scope policy as a direct call. ' +
  'Mutating tools (write_file, edit_file, multi_edit, create_file, manage_path, apply_patch, git_add/commit/branch) work only when the plan is approved (or the active task scope unlocks the touched paths). ' +
  'Interactive prompts (submit_plan, submit_tasks, ask_user) and orchestration tools (spawn_*, expand_toolset) are NOT exposed — call them directly outside code_exec.\n' +
  '\n' +
  'Limits: ' + DEFAULT_TIMEOUT_MS + ' ms default timeout (max ' + MAX_TIMEOUT_MS + '), ' + MAX_TOOL_CALLS + ' tool calls per script, ' + (MAX_OUTPUT_BYTES / 1024) + ' KB output cap.\n' +
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
  "DON'T: try to bypass plan-mode by calling mutating tools from inside code_exec — the policy applies the same way as direct calls.";

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
          description: `Per-script wall-clock timeout (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
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

      // Per-session "unrestricted tool output" toggle. Lifts the script's
      // output cap from 50 KB to ~1 MB so batched Unity / MCP work isn't
      // truncated mid-flight. Auto-compaction in the runner still runs.
      const effectiveMaxOutput = ctx.unrestrictedToolOutput
        ? UNRESTRICTED_MAX_OUTPUT_BYTES
        : MAX_OUTPUT_BYTES;

      // Make sure the host doesn't crash if the model's script fires a
      // tool call without awaiting it (the proxy throws into a Promise
      // nobody owns). Idempotent — installs the listener at most once.
      ensureUnhandledHandler();

      // Build the tools proxy: one async function per safe registered tool.
      const safe = registry.list().filter(isSafeTool);
      const exposedNames = safe.map((t) => t.name).sort();
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
          const result = await registry.invoke(t.name, argObj, ctx);
          if (result.isError) {
            throw new Error(`tool ${t.name}: ${result.content}`);
          }
          return result.content;
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
        'tools',
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

      const sandbox: Context = {
        // Bare aliases first so the explicit fields below win on conflict
        // (e.g. a future tool named `JSON` would not shadow the global).
        ...bareGlobals,
        tools: toolsProxy,
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
      let scriptPromise: Promise<unknown>;
      try {
        scriptPromise = runInNewContext(wrapped, sandbox, {
          timeout: timeout, // protects against synchronous infinite loops
          filename: 'code_exec.js',
        }) as Promise<unknown>;
      } catch (e) {
        return err(`code_exec parse/sync error: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Async timeout: races the script against a setTimeout-rejecting promise.
      // The sync `timeout` option above does not cover async waits.
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`code_exec: timed out after ${timeout} ms`)), timeout);
      });

      let returnValue: unknown;
      try {
        returnValue = await Promise.race([scriptPromise, timeoutPromise]);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Defense-in-depth hint: a ReferenceError on a name that IS a
        // registered tool means the model wrote the wrong call shape (e.g.
        // shadowed by a `let` / typo); on an absent Node builtin it means the
        // script reached for a runtime that isn't there. We match on the
        // message text rather than `instanceof ReferenceError`: errors thrown
        // inside node:vm carry the sandbox realm's constructors, so they are
        // NOT instances of the host's ReferenceError/Error — `msg` is then the
        // String(e) form, e.g. "ReferenceError: require is not defined".
        let hint = '';
        {
          const refMatch = /(?:^|ReferenceError:\s*)([A-Za-z_$][\w$]*) is not defined/.exec(msg);
          if (refMatch) {
            const name = refMatch[1];
            if (exposedNames.includes(name)) {
              hint =
                `\n\nHint: \`${name}\` is a registered tool. Call it as ` +
                `\`await ${name}(args)\` or \`await tools.${name}(args)\`.`;
            } else if (ABSENT_NODE_GLOBALS.has(name)) {
              // code_exec runs in a node:vm sandbox with NO Node builtins —
              // not a bug, by design. Steer the model to the registered tools
              // instead of arbitrary Node I/O.
              hint =
                `\n\nHint: \`${name}\` and other Node builtins (require/import/fs/path/process) ` +
                `are not available — code_exec runs in a node:vm sandbox that only exposes the ` +
                `\`tools\` proxy plus JSON/Math/etc., not a Node runtime. To write a file, call the ` +
                `registered tool: \`await write_file({ path, content })\` (or \`create_file\`). ` +
                `To run a shell command, use \`exec_command\`. code_exec only orchestrates tool calls.`;
            } else {
              const close = exposedNames.find((t) => t.toLowerCase() === name.toLowerCase());
              if (close) {
                hint = `\n\nHint: did you mean \`${close}\`? (case-sensitive)`;
              }
            }
          }
        }
        const stderr = logBuffer.length > 0 ? `\n[output before failure]\n${logBuffer.join('\n')}` : '';
        return err(`code_exec failed: ${msg}${hint}${stderr}`);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
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
        return ok(out.slice(0, effectiveMaxOutput) + `\n[truncated: output exceeded ${effectiveMaxOutput} bytes]`);
      }
      return ok(out);
    },
  };
}

/** Test-only: which tool names a code_exec built right now would expose. */
export function _exposedToolNames(registry: ToolRegistry): string[] {
  return registry.list().filter(isSafeTool).map((t) => t.name).sort();
}
