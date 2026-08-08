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
 * `normalizeToolArgs` rewrites a wrong name to the tool's REAL param name,
 * using the tool's own JSON Schema as the source of truth so it is safe for
 * native AND MCP tools alike. It is invisible to every model — no schema
 * change, no reminder; the model never learns the alias exists.
 *
 * Aliases are SYMMETRIC groups, not a fixed canonical direction: whichever
 * member the tool's schema declares becomes the rewrite target. This covers
 * both directions seen in telemetry — `file_path` sent to fs tools (which
 * declare `path`) AND `path` sent to LSP tools (which declare `file_path`),
 * `cmd` sent to run_command AND `command` sent to exec_command, etc.
 *
 * Called from the single tool-dispatch chokepoint (`ToolRegistry.invoke`),
 * which covers the main runner loop, subagents, and `code_exec`'s nested
 * tool calls.
 */
import type { JsonSchema } from '@mcp/code-agent/core/tool.js';

/**
 * Groups of names models use interchangeably for the same concept. Order
 * inside a group is the donor-precedence order (first present donor wins).
 *
 * SAFETY: every rewrite is gated by the per-call rules in `normalizeToolArgs`
 * — a group is applied ONLY when the tool declares EXACTLY ONE of its members
 * (so a tool that legitimately declares two members, or none, is never
 * touched), the declared member is currently blank, and the donor value is a
 * non-empty-typed string. Tools that legitimately use an "alias" name are
 * therefore never robbed: LSP / diagnostics declare `file_path` (that becomes
 * the target, not a donor); `exec_command` declares `cmd`/`workdir`;
 * `record_memo` declares `text`; `http_request`/`save_note` declare `body`.
 */
export const ALIAS_GROUPS: ReadonlyArray<readonly string[]> = [
  ['path', 'file_path', 'filepath', 'filePath', 'filename', 'fileName', 'file_name', 'file', 'pathname'],
  ['content', 'contents', 'file_content', 'file_contents', 'fileContents', 'data', 'text', 'body'],
  ['old_string', 'old_str', 'oldStr', 'oldString', 'old', 'old_text'],
  ['new_string', 'new_str', 'newStr', 'newString', 'new', 'new_text', 'replacement'],
  ['command', 'cmd', 'commandline', 'command_line', 'shell'],
  ['cwd', 'workdir', 'working_dir', 'workingDir', 'work_dir'],
  ['pattern', 'glob', 'globPattern', 'glob_pattern', 'search_pattern'],
];

/**
 * Kill switch — default ON. Set `CODER_TOOL_ARG_ALIASES_DISABLE=1` to pass
 * model args through untouched (matches the repo's `_DISABLE … !== '1'` idiom).
 */
export function aliasNormalizationEnabled(): boolean {
  return true;
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
 * Rules (ALL must hold for a rewrite, per group):
 *  (a) the tool declares EXACTLY ONE member of the group — that member is the
 *      target; zero declared means the group doesn't apply, two+ means the
 *      tool genuinely distinguishes them and is never touched;
 *  (b) the target value is currently blank — never clobber a real value;
 *  (c) a donor member is present with a non-null value;
 *  (d) donors are never declared params (implied by (a));
 *  (e) the donor value is a string — every group names string params, so a
 *      typed value (e.g. a `shell: true` boolean) is never moved.
 */
export function normalizeToolArgs(
  toolParams: JsonSchema | undefined,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const props = toolParams?.properties;
  if (!props || typeof props !== 'object' || !args || typeof args !== 'object') return args;
  const declares = (k: string): boolean => Object.prototype.hasOwnProperty.call(props, k);

  let out: Record<string, unknown> | null = null;
  for (const group of ALIAS_GROUPS) {
    const declared = group.filter(declares);
    if (declared.length !== 1) continue; // (a)
    const target = declared[0];
    if (!isBlank((out ?? args)[target])) continue; // (b)
    for (const donor of group) {
      if (donor === target) continue;
      const value = (out ?? args)[donor];
      if (value === undefined || value === null) continue; // (c)
      if (typeof value !== 'string') continue; // (e)
      if (!out) out = { ...args };
      out[target] = value;
      delete out[donor];
      break; // first matching donor wins per group
    }
  }
  return out ?? args;
}
