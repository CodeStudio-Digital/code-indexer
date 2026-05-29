/**
 * A2 — Safety filter for tool selection (Sprint 3).
 *
 * Removes tools from the per-turn selection when the current context
 * makes them risky:
 *
 *   - The active file contains apparent secrets (API keys, private keys,
 *     password literals) → block mutating shell tools that could leak
 *     them via PowerShell/Bash output.
 *   - The runner is in plan mode → tools tagged `mutates: true` would
 *     be blocked anyway by `policy.ts`; the safety filter drops them
 *     EARLIER (before serialization to the provider) so prompt tokens
 *     don't pay for tools the agent can't call.
 *   - Network-bound tools (WebFetch, mcp_external) when the session is
 *     marked offline-only.
 *
 * Mirrors the `home-mixer/filters/age_filter.rs` + `muted_keyword_filter.rs`
 * pattern from xai-org/x-algorithm: cheap predicates that drop items
 * AFTER scoring/selection but BEFORE delivery.
 *
 * **Backward compat**: applied ONLY when explicitly requested via
 * `applyToolSelectionThinSafety(...)`. The thin runtime path
 * (`runtime-helper-thin.ts`) does NOT wire this filter today — Sprint 3
 * lands the filter and exposes it; the host opts in via env flag in a
 * follow-up.
 *
 * **Performance**: each predicate is regex-based on tool name +
 * description. Per-call cost is O(N tools × M predicates) — N≈30,
 * M≈3, sub-ms.
 */
import type { ThinTool } from './runtime-helper-thin.js';

export interface SafetyContext {
  /** Recent file contents (cropped to ~5k chars each) to scan for secret-like patterns. */
  recentFileContents?: ReadonlyArray<{ path: string; content: string }>;
  /** True when the runner is in plan mode — block mutating tools. */
  planMode?: boolean;
  /** True when the session is offline-only — block network tools. */
  offlineOnly?: boolean;
}

export interface SafetyFilterResult {
  kept: ThinTool[];
  removed: Array<{ tool: ThinTool; reason: string }>;
}

/**
 * Heuristic patterns that suggest a file holds secrets. Conservative
 * by design — false positives are tolerable (filter removes a tool
 * we'd block anyway via policy.ts later); false negatives are not
 * (would mean the filter doesn't fire when it should).
 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN (RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----/i,
  /api[_-]?key\s*[=:]\s*['"][A-Za-z0-9_\-]{16,}['"]/i,
  /(?:secret|password|passwd|pwd)\s*[=:]\s*['"][^'"]{8,}['"]/i,
  /aws_secret_access_key\s*[=:]\s*['"][A-Za-z0-9/+=]{20,}['"]/i,
  /bearer\s+[A-Za-z0-9_\-.]{20,}/i,
  /sk-[A-Za-z0-9]{32,}/, // OpenAI-like tokens
  /xoxb-\d+-\d+-[A-Za-z0-9]+/, // Slack bot tokens
  /github_pat_[A-Za-z0-9_]{20,}/, // GitHub PATs
];

function fileContentsSuggestSecrets(
  files: ReadonlyArray<{ path: string; content: string }> | undefined,
): boolean {
  if (!files) return false;
  for (const f of files) {
    for (const re of SECRET_PATTERNS) {
      if (re.test(f.content)) return true;
    }
  }
  return false;
}

/**
 * Tool-name patterns considered "leaky" — they emit data into a turn's
 * conversation that the model might echo back. When secrets are visible,
 * these are the tools we don't want exposed to the LLM.
 */
const LEAKY_TOOL_NAMES = new Set([
  'PowerShell', 'Bash', 'code_exec', 'run_in_sandbox',
]);

/**
 * Mutating tool-name prefixes — blocked by policy.ts in plan mode but
 * cheaper to drop here.
 */
const MUTATING_TOOL_PREFIXES = ['write_', 'create_', 'edit_', 'multi_edit', 'manage_path', 'apply_patch'];

function isLeaky(tool: ThinTool): boolean {
  return LEAKY_TOOL_NAMES.has(tool.name);
}

function isMutating(tool: ThinTool): boolean {
  return MUTATING_TOOL_PREFIXES.some((p) => tool.name.startsWith(p));
}

function isNetwork(tool: ThinTool): boolean {
  return tool.name === 'WebFetch' || tool.name.startsWith('ext_') || tool.name.startsWith('mcp__');
}

/**
 * Run the safety predicates against a list of tools. Returns kept +
 * removed (with reasons) so the caller can surface a diagnostic in
 * the tool_result and the user can ask "why did the model not have
 * tool X?" via the dashboard.
 */
export function applyToolSelectionSafety(
  tools: ReadonlyArray<ThinTool>,
  ctx: SafetyContext,
): SafetyFilterResult {
  const secretsVisible = fileContentsSuggestSecrets(ctx.recentFileContents);
  const kept: ThinTool[] = [];
  const removed: Array<{ tool: ThinTool; reason: string }> = [];

  for (const tool of tools) {
    if (ctx.planMode && isMutating(tool)) {
      removed.push({ tool, reason: 'plan-mode: mutating tools blocked until plan approved' });
      continue;
    }
    if (secretsVisible && isLeaky(tool)) {
      removed.push({ tool, reason: 'secret-shaped content detected in recent files; leaky tool dropped' });
      continue;
    }
    if (ctx.offlineOnly && isNetwork(tool)) {
      removed.push({ tool, reason: 'session is offline-only; network tool dropped' });
      continue;
    }
    kept.push(tool);
  }
  return { kept, removed };
}
