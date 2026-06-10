/**
 * Silent, schema-guarded normalization of tool-call argument NAMES.
 *
 * Models are habituated to Claude Code's conventional parameter names
 * (`file_path`, `old_string`, `new_string`, `content`, `command`, `pattern`)
 * and frequently send them to this project's tools, which renamed several of
 * those params (notably `path`). The wrong name makes the handler read an
 * empty value and hard-fail (`read_file` → "path is required and cannot be
 * empty"), and after enough consecutive failures the failure-streak guard
 * refuses the tool and forces a planning turn.
 *
 * `normalizeToolArgs` rewrites a known wrong name to the tool's REAL param
 * name, using the tool's own JSON Schema as the source of truth so it is safe
 * for native AND MCP tools alike. It is invisible to every model — no schema
 * change, no reminder; the model never learns the alias exists.
 *
 * Called from the single tool-dispatch chokepoint (`ToolRegistry.invoke`),
 * which covers the main runner loop, subagents, and `code_exec`'s nested
 * tool calls.
 */
import type { JsonSchema } from '@mcp/code-agent/core/tool.js';

/**
 * Canonical (real) param name → wrong names models commonly send instead.
 * Array-of-tuples (not an object) for deterministic iteration order.
 *
 * SAFETY: every entry is gated by the per-call rules in `normalizeToolArgs`
 * — an alias is applied ONLY when the canonical name is a real property of
 * the tool AND the wrong name is NOT. So tools that legitimately use a
 * "wrong" name are never touched: LSP / diagnostics / MCP file tools use
 * `file_path`; `exec_command` uses `cmd`; `record_memo` / `preview_type` use
 * `text`; `http_request` / `save_note` use `body`.
 */
export const TOOL_ARG_ALIASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['path', ['file_path', 'filepath', 'filePath', 'filename', 'fileName', 'file_name', 'file', 'pathname']],
  ['content', ['contents', 'file_content', 'file_contents', 'fileContents', 'data', 'text', 'body']],
  ['old_string', ['old_str', 'oldStr', 'oldString', 'old', 'old_text']],
  ['new_string', ['new_str', 'newStr', 'newString', 'new', 'new_text', 'replacement']],
  ['command', ['cmd', 'commandline', 'command_line', 'shell']],
  ['pattern', ['glob', 'globPattern', 'glob_pattern', 'search_pattern']],
];

/**
 * Kill switch — default ON. Set `CODER_TOOL_ARG_ALIASES_DISABLE=1` to pass
 * model args through untouched (matches the repo's `_DISABLE … !== '1'` idiom).
 */
export function aliasNormalizationEnabled(): boolean {
  return process.env.CODER_TOOL_ARG_ALIASES_DISABLE !== '1';
}

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || v === '';
}

/**
 * Return `args` with any known wrong argument name rewritten to the tool's
 * real param name. Returns the SAME object reference when nothing matched (no
 * allocation on the happy path). Never mutates the input — a shallow copy is
 * made lazily on the first rewrite.
 *
 * Rules (ALL must hold for a rewrite):
 *  (a) the canonical name is a declared property of this tool;
 *  (b) the canonical value is currently blank — never clobber a real value;
 *  (c) the wrong name is present with a non-null value;
 *  (d) the wrong name is NOT itself a declared property of this tool.
 */
export function normalizeToolArgs(
  toolParams: JsonSchema | undefined,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const props = toolParams?.properties;
  if (!props || typeof props !== 'object' || !args || typeof args !== 'object') return args;
  const declares = (k: string): boolean => Object.prototype.hasOwnProperty.call(props, k);

  let out: Record<string, unknown> | null = null;
  for (const [canonical, aliases] of TOOL_ARG_ALIASES) {
    if (!declares(canonical)) continue; // (a)
    if (!isBlank((out ?? args)[canonical])) continue; // (b)
    for (const alias of aliases) {
      if (declares(alias)) continue; // (d)
      const value = (out ?? args)[alias];
      if (value === undefined || value === null) continue; // (c)
      if (!out) out = { ...args };
      out[canonical] = value;
      delete out[alias];
      break; // first matching alias wins per canonical
    }
  }
  return out ?? args;
}
