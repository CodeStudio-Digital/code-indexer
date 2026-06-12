/**
 * Failure hints for `code_exec` — turn opaque sandbox errors into a precise
 * next step. Extracted from code-exec.ts so the catch blocks stay small and
 * the hint surface is testable on its own.
 *
 * Every matcher works on the error MESSAGE text, never `instanceof`: errors
 * thrown inside node:vm carry the sandbox realm's constructors, so they are
 * NOT instances of the host's ReferenceError/Error.
 *
 * All hints are deterministic over their inputs (no timestamps/ids) — they
 * land in the transcript and must not destabilize the provider prefix cache.
 */
import { suggestToolName } from '@mcp/code-agent/core/tool-name-suggest.js';

/**
 * Node globals the sandbox intentionally omits. A script reaching for one of
 * these gets a bare `ReferenceError: <name> is not defined`; we recognize the
 * name to emit a precise nudge toward the registered tools instead of an
 * opaque failure.
 */
export const ABSENT_NODE_GLOBALS = new Set([
  'require', 'import', 'module', 'exports', 'process', 'Buffer',
  '__dirname', '__filename', 'global', 'globalThis', 'fetch',
]);

export interface CodeExecHintContext {
  /** Tool names exposed inside this code_exec's sandbox, sorted. */
  exposedNames: ReadonlyArray<string>;
  /** Every registered tool name, including sandbox-excluded control tools. */
  allToolNames: ReadonlySet<string>;
}

/**
 * Best hint for a code_exec failure message, or '' when we have nothing
 * useful to add. The returned string starts with `\n\nHint:` so callers can
 * append it verbatim.
 */
export function buildCodeExecFailureHint(msg: string, ctx: CodeExecHintContext): string {
  // import()/import statements — V8's messages for a vm context without a
  // module loader. Telemetry: "A dynamic import callback was not specified".
  if (msg.includes('dynamic import callback') || msg.includes('Cannot use import statement')) {
    return (
      '\n\nHint: `import` is not available — code_exec runs the snippet as a plain async ' +
      'function body in a node:vm sandbox with NO module loader (no require, no import()). ' +
      'Registered tools are already in scope: call `await read_file({ path })`, ' +
      '`await run_command({ command })`, etc. To run node/npm itself, go through ' +
      '`run_command`/`exec_command`.'
    );
  }

  // A nested tool call failed → the proxy throw aborted the whole script.
  // Matches the proxy's `tool <name>: <content>` failure shape but NOT
  // `tool <name> blocked: ...` (policy) or `tool <name> timed out ...`,
  // where a retry-in-try/catch would be the wrong advice.
  if (/^tool [\w$.]+: /.test(msg)) {
    return (
      '\n\nHint: a nested tool call failed and aborted the WHOLE script — work after that ' +
      'point was lost (partial output above, if any). If a specific call may legitimately ' +
      'fail (e.g. create_file on a file that may already exist, a probe read), wrap THAT ' +
      'call in try/catch and continue; do not wrap everything blindly.'
    );
  }

  const refMatch = /(?:^|ReferenceError:\s*)([A-Za-z_$][\w$]*) is not defined/.exec(msg);
  if (!refMatch) return '';
  const name = refMatch[1];

  if (ctx.exposedNames.includes(name)) {
    return (
      `\n\nHint: \`${name}\` is a registered tool. Call it as ` +
      `\`await ${name}(args)\` or \`await tools.${name}(args)\`.`
    );
  }
  if (ctx.allToolNames.has(name)) {
    // Registered at top-level but excluded from the sandbox (a control/
    // lifecycle tool). Weak models loop here retrying it inside code_exec —
    // steer them to a direct top-level call.
    return (
      `\n\nHint: \`${name}\` is a registered tool but is NOT exposed inside code_exec ` +
      `— it's a control/lifecycle tool (task_complete, execute_task, expand_toolset, spawn_*, ask_user, submit_*) ` +
      `that needs the runner's own turn cycle. End this code_exec and call \`${name}\` directly as a top-level tool call.`
    );
  }
  if (ABSENT_NODE_GLOBALS.has(name)) {
    // node:vm sandbox with NO Node builtins — not a bug, by design.
    return (
      `\n\nHint: \`${name}\` and other Node builtins (require/import/fs/path/process) ` +
      `are not available — code_exec runs in a node:vm sandbox that only exposes the ` +
      `\`tools\` proxy plus JSON/Math/etc., not a Node runtime. To write a file, call the ` +
      `registered tool: \`await write_file({ path, content })\` (or \`create_file\`). ` +
      `To run a shell command, use \`exec_command\`. code_exec only orchestrates tool calls.`
    );
  }
  const close = suggestToolName(name, ctx.exposedNames as string[]);
  if (close) {
    return `\n\nHint: did you mean \`${close}\`? (case-sensitive)`;
  }
  return '';
}

/**
 * Wrap the sandbox's `tools` binding so an unknown property access fails
 * LOUDLY with a suggestion instead of yielding `undefined` and the opaque
 * "tools.x is not a function" TypeError telemetry caught.
 *
 * Inherited Object.prototype members (`toString`, `hasOwnProperty`, …) pass
 * through via the `prop in target` check; `then/catch/finally/toJSON` are
 * runtime probes (await/JSON.stringify), not tool lookups, so they stay
 * transparent too. Symbols always pass through.
 */
export function wrapToolsBinding<T extends object>(
  target: T,
  exposedNames: ReadonlyArray<string>,
): T {
  const PASSTHROUGH = new Set(['then', 'catch', 'finally', 'toJSON']);
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop !== 'string' || prop in t || PASSTHROUGH.has(prop)) {
        return Reflect.get(t, prop, receiver);
      }
      const close = suggestToolName(prop, exposedNames as string[]);
      throw new Error(
        `tools.${prop} is not an available tool in this code_exec` +
          (close ? ` — did you mean \`tools.${close}\`?` : '') +
          `. ${exposedNames.length} tools are exposed; ` +
          `log(Object.keys(tools).sort().join(', ')) to list them.`,
      );
    },
  });
}
