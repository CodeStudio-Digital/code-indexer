/**
 * Universal tool-timeout policy for `CoderRunner`.
 *
 * Background: a tool whose handler hangs forever (network socket without
 * timeout, sub-runner stuck on a slow LLM, MCP server with a broken DB
 * call) used to freeze the entire session — the runner awaited the
 * Promise indefinitely, no `tool_call_result` ever fired, and the
 * dashboard's StuckBanner displayed "Worker idle for Ns" until the user
 * gave up. The fix wraps every tool invocation in `Promise.race(invoke,
 * timeoutPromise)` inside the runner; this module owns the *policy*: how
 * long is "too long" for each kind of tool.
 *
 * Buckets:
 *   - NORMAL (5 min)  — native fast tools we know should return in
 *     seconds (`read_file`, `grep`, `glob`, `write_file`, `edit_file`,
 *     `apply_patch`, …). 5 min is the ceiling, not the expectation.
 *   - SLOW (30 min)   — anything we either KNOW takes long (deep
 *     research, subagents, parallel orchestrators) or whose latency we
 *     CAN'T predict (any MCP tool, vector-search/docs tools). MCP tools
 *     can transparently call a remote DB / API, so being generous here
 *     is correct. (`code_exec` declares a wall-clock backstop above its
 *     nested calls; `run_command` declares a request-aware timeout plus
 *     cleanup grace — neither relies on this tier in production.)
 *   - INFINITY        — interactive tools (`submit_plan`, `ask_user`,
 *     `task_list`) and tools that explicitly declare `timeoutMs: Infinity`.
 *     Repeat policy never implies an unbounded invocation.
 *
 * A valid per-invocation `tool.resolveTimeoutMs(args)` wins first, followed by
 * the static `tool.timeoutMs` value.
 */
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { isIndexTool } from './index-tool-identity.js';

const NORMAL_DEFAULT_MS = 5 * 60_000;
const SLOW_DEFAULT_MS = 30 * 60_000;

/**
 * Native tools we KNOW are long-running. Belt-and-suspenders alongside
 * the explicit `timeoutMs` we set on the tool definitions themselves —
 * if someone forgets to declare it, this catches it.
 */
const SLOW_NATIVE_NAMES = new Set<string>([
  'docs_deep_research',
  'implement_subagent',
  'review_subagent',
  // Orchestrators: spawn parallel/child agents that have their own internal
  // per-agent caps (10–20 min). A 30-min tool-level backstop sits above
  // those caps instead of the 5-min NORMAL default that was killing them.
  'spawn_agent',
  'execute_tasks',
  'workflow',
  // Fallback for synthetic/test definitions that omit code_exec's explicit
  // wall-clock backstop. The real tool declares its own timeoutMs.
  'code_exec',
]);
// NOTE: run_command is deliberately NOT here — shell.ts resolves each request:
// ordinary one-shot commands keep the 10-minute ceiling, while recognized
// Unity Editor batch/test jobs receive the 30-minute slow-work budget.

/**
 * Name-pattern fallback for tools that do vector search or documentation
 * retrieval — these can call rerankers, embedding models, or hit remote
 * indexes, all of which legitimately take minutes on a cold cache.
 */
const SLOW_NAME_RE = /^(rag_|docs_|search_)/;

/** Conservative bucket for any MCP "research" namespace. */
const SLOW_MCP_PREFIX = 'mcp__research';

export const NORMAL_TIMEOUT_MS = NORMAL_DEFAULT_MS;
export const SLOW_TIMEOUT_MS = SLOW_DEFAULT_MS;

/**
 * Pick the right timeout (ms) for a given tool. Returns `Infinity` for
 * interactive tools and tools that explicitly set `timeoutMs: Infinity`.
 *
 * Resolution order (first match wins):
 *   1. valid `tool.resolveTimeoutMs(args)` value (when args are available)
 *   2. `tool.timeoutMs` explicit value (including `Infinity`)
 *   3. `tool.interactive === true`  → Infinity
 *   4. name in `SLOW_NATIVE_NAMES`  → SLOW
 *   5. name matches `SLOW_NAME_RE`  → SLOW
 *   6. name starts with `SLOW_MCP_PREFIX` → SLOW
 *   7. an index tool (mcp__*, `isIndexTool`) → SLOW: the value they had as
 *      MCP tools, kept now that they are native
 *   8. `tool.source === 'mcp' | 'mcp_external'` → SLOW (latency unknown)
 *   9. otherwise → NORMAL
 */
export function resolveToolTimeoutMs(
  tool: CoderTool,
  args?: Record<string, unknown>,
): number {
  if (args && tool.resolveTimeoutMs) {
    try {
      const resolved = tool.resolveTimeoutMs(args);
      if (resolved === Infinity || (Number.isFinite(resolved) && resolved >= 0)) return resolved;
    } catch {
      // A dynamic classifier is policy metadata, not part of tool execution.
      // Fall through to the static/default tier instead of breaking dispatch.
    }
  }
  if (tool.timeoutMs !== undefined) return tool.timeoutMs;
  if (tool.interactive) return Infinity;
  if (SLOW_NATIVE_NAMES.has(tool.name)) return SLOW_TIMEOUT_MS;
  if (SLOW_NAME_RE.test(tool.name)) return SLOW_TIMEOUT_MS;
  if (tool.name.startsWith(SLOW_MCP_PREFIX)) return SLOW_TIMEOUT_MS;
  if (isIndexTool(tool)) return SLOW_TIMEOUT_MS;
  if (tool.source === 'mcp' || tool.source === 'mcp_external') return SLOW_TIMEOUT_MS;
  return NORMAL_TIMEOUT_MS;
}
