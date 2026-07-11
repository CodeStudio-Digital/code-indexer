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
 *     is correct. (code_exec self-caps at 30s; run_command declares its
 *     own 10-min timeoutMs — neither belongs in this tier.)
 *   - INFINITY        — interactive tools (`submit_plan`, `ask_user`,
 *     `submit_tasks`) and tools that explicitly declare `timeoutMs: Infinity`.
 *     Repeat policy never implies an unbounded invocation.
 *
 * Override the defaults at runtime via env:
 *   - MCP_TOOL_NORMAL_TIMEOUT_MS  (default 300_000 = 5 min)
 *   - MCP_TOOL_SLOW_TIMEOUT_MS    (default 1_800_000 = 30 min)
 *   - MCP_TOOL_HEARTBEAT_MS       (default 5_000; set 0 to disable
 *     heartbeats during tool execution)
 *
 * Explicit `tool.timeoutMs` on the tool definition always wins.
 */
import type { CoderTool } from '@mcp/code-agent/core/tool.js';

const NORMAL_DEFAULT_MS = 5 * 60_000;
const SLOW_DEFAULT_MS = 30 * 60_000;
const HEARTBEAT_DEFAULT_MS = 5_000;

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
  // code_exec batches nested tool calls — including long shell installs. Its
  // own timeout now measures only JS-active time (PAUSED while a nested tool
  // runs, codex `code_mode` model; see code-exec.ts), so the runner backstop
  // must sit ABOVE the longest nested tool (run_command = 10 min) instead of
  // the 5-min NORMAL default that would otherwise cut a multi-install batch.
  'code_exec',
]);
// NOTE: run_command is deliberately NOT here — it declares an explicit 10-min
// `timeoutMs` on its own tool definition (shell.ts), which wins over this tier;
// a one-shot command should not get the 30-min budget.

/**
 * Name-pattern fallback for tools that do vector search or documentation
 * retrieval — these can call rerankers, embedding models, or hit remote
 * indexes, all of which legitimately take minutes on a cold cache.
 */
const SLOW_NAME_RE = /^(rag_|docs_|search_)/;

/** Conservative bucket for any MCP "research" namespace. */
const SLOW_MCP_PREFIX = 'mcp__research';

function readEnvMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(
      `[tool-timeouts] ignoring invalid ${name}="${raw}" — must be a non-negative number, falling back to ${fallback}`,
    );
    return fallback;
  }
  return n;
}

/** Resolved at module load — change only via env, then restart. */
export const NORMAL_TIMEOUT_MS = readEnvMs('MCP_TOOL_NORMAL_TIMEOUT_MS', NORMAL_DEFAULT_MS);
export const SLOW_TIMEOUT_MS = readEnvMs('MCP_TOOL_SLOW_TIMEOUT_MS', SLOW_DEFAULT_MS);

/**
 * Heartbeat interval (ms) for `tool_progress` events emitted while a
 * tool is in flight. Set 0 (or `MCP_TOOL_HEARTBEAT_MS=0`) to disable.
 * Resolved fresh on every call so tests can mutate `process.env` between
 * runs without reimporting the module.
 */
export function resolveHeartbeatIntervalMs(): number {
  return readEnvMs('MCP_TOOL_HEARTBEAT_MS', HEARTBEAT_DEFAULT_MS);
}

/**
 * Pick the right timeout (ms) for a given tool. Returns `Infinity` for
 * interactive tools and tools that explicitly set `timeoutMs: Infinity`.
 *
 * Resolution order (first match wins):
 *   1. `tool.timeoutMs` explicit value (including `Infinity`)
 *   2. `tool.interactive === true`  → Infinity
 *   3. name in `SLOW_NATIVE_NAMES`  → SLOW
 *   4. name matches `SLOW_NAME_RE`  → SLOW
 *   5. name starts with `SLOW_MCP_PREFIX` → SLOW
 *   6. `tool.source === 'mcp' | 'mcp_external'` → SLOW (latency unknown)
 *   7. otherwise → NORMAL
 */
export function resolveToolTimeoutMs(tool: CoderTool): number {
  if (tool.timeoutMs !== undefined) return tool.timeoutMs;
  if (tool.interactive) return Infinity;
  if (SLOW_NATIVE_NAMES.has(tool.name)) return SLOW_TIMEOUT_MS;
  if (SLOW_NAME_RE.test(tool.name)) return SLOW_TIMEOUT_MS;
  if (tool.name.startsWith(SLOW_MCP_PREFIX)) return SLOW_TIMEOUT_MS;
  if (tool.source === 'mcp' || tool.source === 'mcp_external') return SLOW_TIMEOUT_MS;
  return NORMAL_TIMEOUT_MS;
}
