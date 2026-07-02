/**
 * Classify a REAL tool error into a coarse machine-readable class for the
 * `coder_tool_calls.error_class` column (mig 186). Complements `refusal_kind`
 * (mig 124): harness refusals return NULL here — analytics read
 * COALESCE(refusal_kind, error_class).
 *
 * Heuristics over result_text, ordered specific → generic. They are tuned to
 * the messages the runner and tools actually produce (registry.ts unknown-tool
 * / "Tool 'x' failed:", fs + MCP "not found" errors, shell exit codes, sandbox
 * containment) — keep patterns in sync when those messages change.
 *
 * Dependency-free on purpose: imported by BOTH the store (messages.ts) and
 * the dbWriter worker mirror (packages/indexer), which must classify
 * identically.
 */
import { classifyToolRefusal } from './tool-refusal.js';

const NOT_FOUND = /\bnot found\b|ENOENT|no such file or directory|does not exist/i;
const PERMISSION = /EACCES|EPERM|permission denied/i;
const TIMEOUT = /ETIMEDOUT|timed? ?out/i;
const NETWORK = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|network error|socket hang up/i;
const COMMAND_FAILED = /exited with code \d+|exit code \d+|command failed|non-zero exit/i;
const POLICY = /outside (the )?project root|path traversal|is blocked|not allowed|write-protected|sandbox/i;
const INVALID_ARGS = /^Invalid |invalid arguments?|missing required|required (argument|parameter|field)|must be an? |expected .+ got /i;

export function classifyToolError(resultText: string, isError: boolean): string | null {
  if (!isError || !resultText) return null;
  if (classifyToolRefusal(resultText, isError)) return null; // refusal_kind owns it
  const t = resultText;

  if (t.startsWith('Unknown tool:')) return 'unknown_tool';

  // registry.ts wraps handler throws as "Tool 'x' failed: <msg>" — classify
  // by the inner message, defaulting to handler_exception.
  if (/^Tool '[^']+' failed:/.test(t)) {
    if (NOT_FOUND.test(t)) return 'not_found';
    if (PERMISSION.test(t)) return 'permission';
    if (TIMEOUT.test(t)) return 'timeout';
    if (NETWORK.test(t)) return 'network';
    return 'handler_exception';
  }

  if (POLICY.test(t)) return 'policy';
  if (NOT_FOUND.test(t)) return 'not_found';
  if (COMMAND_FAILED.test(t)) return 'command_failed';
  if (NETWORK.test(t)) return 'network';
  if (TIMEOUT.test(t)) return 'timeout';
  if (PERMISSION.test(t)) return 'permission';
  if (INVALID_ARGS.test(t)) return 'invalid_args';
  return 'other';
}
