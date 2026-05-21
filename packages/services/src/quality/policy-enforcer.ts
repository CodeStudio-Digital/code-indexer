/**
 * Wire #5 (Nível 2) — Policy Hard-Block enforcer.
 *
 * Runs BEFORE tool dispatch when enabled. Cancels the tool call when the
 * proposed arguments match a high-confidence danger pattern. The runner
 * then surfaces the block as a tool-error result so the model sees:
 *
 *   "Tool blocked: <reason>. Adjust and retry."
 *
 * Two-layer defense:
 *
 *   1. **Regex pre-filter** (primary, always on when enabled). Static
 *      patterns for the canonical destructive operations: `rm -rf /`,
 *      `git push --force`, `git reset --hard`, `curl | sh`, fork bombs,
 *      chmod 777 root, dd-to-block-device, `--no-verify` git pushes.
 *      Microseconds; no LLM call; no false negatives on the patterns it
 *      knows.
 *
 *   2. **LLM classifier** (optional, gated by `useClassifier`). When
 *      enabled, the regex pre-filter ROUTES — every Bash call goes
 *      through the classifier for a fuzzy check, even when regex didn't
 *      hit. Provides defense against patterns the regex can't anticipate.
 *      Has a hard timeout (default 3s); on timeout we ALLOW the call
 *      (fail-open) — never block legitimate work on flaky network.
 *
 * Tools we check:
 *   - `Bash` / `run_command` — the high-value target. Almost every
 *     unsafe operation flows through a shell.
 *   - `Write` — when content looks like a hardcoded credential (regex
 *     covers AWS / Google / GitHub / generic API key formats).
 *
 * Tools we DON'T check (intentional):
 *   - `Read`, `Grep`, `Glob` — purely read-only.
 *   - `Edit` — content scrutiny is the classifier's job, not regex
 *     (TypeScript code legitimately contains snippets that look like
 *     keys for testing purposes).
 *   - MCP bridge tools — we don't have semantic knowledge of their
 *     behavior; operators audit those at server-registration time.
 *
 * Off by default. Operators turn it on via `MCP_PIPELINES_POLICY_HARD_BLOCK=1`.
 *
 * The enforcer is a plain class with no external state, so it's safe to
 * share across sessions / threads (Node is single-threaded, but the
 * pattern matters when we move to workers).
 */
import type { PolicyClassifier } from './classifiers.js';
import type { AgentOutputForClassification } from './types.js';

export interface PolicyDecision {
  /** True when the tool call is permitted to proceed. */
  allowed: boolean;
  /** Human-readable reason when `allowed=false`. Sent back to the model. */
  reason?: string;
  /** Which layer made the decision — useful for telemetry / debugging. */
  source?: 'regex' | 'classifier';
  /** When source='classifier', the model's confidence. */
  confidence?: number;
}

export interface PolicyEnforcerOptions {
  /**
   * Optional LLM classifier. When set AND `useClassifier=true`, every
   * checked-tool call goes through the classifier even when the regex
   * pre-filter found nothing. Adds ~500ms-1s latency per tool call.
   */
  classifier?: PolicyClassifier;
  /** Whether to actually invoke the classifier when one is provided. */
  useClassifier?: boolean;
  /** Confidence floor for classifier-sourced blocks. Default 0.9. */
  minClassifierConfidence?: number;
  /** Hard timeout for the classifier call (ms). Default 3000. */
  classifierTimeoutMs?: number;
}

/**
 * Canonical destructive Bash patterns. Each entry is a tuple of
 * `[regex, human-readable-reason]`. Reasons are intentionally specific
 * so the model can correct (`fixing PATH` instead of guessing).
 *
 * Tuning notes:
 *   - The `rm -rf /` pattern guards against root-relative deletion. We
 *     explicitly ALLOW `/tmp`, `/var/tmp` and the explicit user-home
 *     path — those are common in legitimate CI cleanup.
 *   - `git push --force` is blocked regardless of branch. Operators who
 *     want to allow force pushes to feature branches can edit this
 *     constant; we're conservative-by-default.
 *   - `curl | sh` is the canonical "execute untrusted code" pattern.
 *     We also catch `wget -O- ... | bash`, `iwr ... | iex`, etc.
 */
const BASH_DANGER_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\brm\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*\s+)+(?:\/(?:\s|$)|\/\*|\/(?!tmp\b|var\/tmp\b|home\/[^/\s]+\/(?:tmp|cache)\b))/,
    reason: 'rm -rf targeting a root-relative path (`rm -rf /` family). If you meant a workspace-relative path, use a relative path (e.g. `./build`) or an explicit allowlisted prefix (`/tmp/...`).',
  },
  {
    pattern: /\bgit\s+push\s+(?:[^|\n]*?(?:--force(?!-with-lease)\b|-f\b))/,
    reason: '`git push --force` without `--force-with-lease`. Use `--force-with-lease` so a teammate\'s concurrent push isn\'t silently overwritten.',
  },
  {
    // Allow bare `git reset --hard HEAD` (no drift). Block any other ref —
    // `HEAD~5`, `origin/main`, a SHA, etc. The negative lookahead requires
    // HEAD followed by whitespace OR end-of-string so HEAD-suffixed refs
    // (`HEAD~5`, `HEAD^`, `HEAD@{1}`) still trigger the block.
    pattern: /\bgit\s+reset\s+--hard(?!\s+HEAD(?:\s|$))/,
    reason: '`git reset --hard` to a non-HEAD ref discards uncommitted changes and rewrites history. Confirm intent or use `git stash` + `git reset` first.',
  },
  {
    pattern: /\b(?:curl|wget|fetch|iwr|invoke-webrequest)\b[^\n;]*\|\s*(?:bash|sh|zsh|fish|dash|pwsh|powershell|iex)\b/i,
    reason: 'Piping network-fetched content directly into a shell (`curl | sh` pattern). Download first, inspect the script, then run explicitly.',
  },
  {
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    reason: 'Fork-bomb pattern (`:(){:|:&};:`). This will exhaust system resources.',
  },
  {
    pattern: /\bchmod\s+(?:-R\s+)?(?:777|666|a\+rwx)\s+\//,
    reason: '`chmod 777 /` (or equivalent) on a root-relative path. Use the minimum permissions needed and a workspace-relative path.',
  },
  {
    pattern: /\bdd\s+(?:[^\n]*\s)?(?:if|of)\s*=\s*\/dev\/(?:sd[a-z]|nvme|disk|null)\b/,
    reason: '`dd` with /dev/sd[abc] / /dev/nvme / /dev/disk — block-device-level write. This wipes hardware. Confirm intent and run interactively, not via the agent.',
  },
  {
    pattern: /\bgit\s+(?:push|commit)\s+[^|\n]*--no-verify\b/,
    reason: '`--no-verify` skips git hooks (pre-commit / pre-push). If a hook is failing, investigate and fix the underlying issue rather than bypassing it.',
  },
  {
    pattern: /\bmkfs\.(?:[a-z0-9]+)\s+\/dev\//,
    reason: '`mkfs` on a block device — formats a disk. This is irreversible. Confirm intent and run interactively.',
  },
];

/**
 * Hard-coded credential patterns inside `Write` content. Keep these
 * conservative — false positives on legitimate test fixtures are common,
 * and we don't want to block real work. Only the most distinctive
 * formats are listed.
 */
const WRITE_CREDENTIAL_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\bAKIA[A-Z0-9]{16}\b/,
    reason: 'AWS access key ID detected in file content. Move it to an environment variable or a secret manager.',
  },
  {
    pattern: /\bAIza[A-Za-z0-9_-]{35}\b/,
    reason: 'Google API key detected in file content. Move it to an environment variable.',
  },
  {
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/,
    reason: 'GitHub personal-access token detected in file content. Rotate immediately and store in a secret manager.',
  },
  {
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
    reason: 'Slack bot/user token detected in file content. Rotate immediately and store in a secret manager.',
  },
];

const TOOLS_WITH_BASH_CHECK = new Set([
  'Bash',
  'run_command',
  'shell',
  'execute_command',
]);
const TOOLS_WITH_WRITE_CHECK = new Set([
  'Write',
  'write_file',
  'create_file',
]);

const ALLOWED = (): PolicyDecision => ({ allowed: true });

export class PolicyEnforcer {
  constructor(private opts: PolicyEnforcerOptions = {}) {}

  /**
   * Evaluate a proposed tool call. Returns `{ allowed: true }` when the
   * call may proceed; otherwise returns the structured block.
   *
   * Never throws — any internal error is treated as ALLOW (fail-open).
   * That's the conservative choice: a buggy enforcer must not break
   * legitimate work.
   */
  async evaluate(toolName: string, args: unknown): Promise<PolicyDecision> {
    try {
      // Phase 1 — Regex pre-filter on Bash-family tools.
      if (TOOLS_WITH_BASH_CHECK.has(toolName)) {
        const cmd = this.extractBashCommand(args);
        if (cmd) {
          for (const { pattern, reason } of BASH_DANGER_PATTERNS) {
            if (pattern.test(cmd)) {
              return { allowed: false, reason, source: 'regex' };
            }
          }
          // Phase 2 — optional classifier (fuzzy check).
          if (this.opts.classifier && this.opts.useClassifier) {
            return await this.classifyBash(cmd);
          }
        }
        return ALLOWED();
      }

      // Phase 1 — Regex pre-filter on Write-family tools (credentials).
      if (TOOLS_WITH_WRITE_CHECK.has(toolName)) {
        const content = this.extractWriteContent(args);
        if (content) {
          for (const { pattern, reason } of WRITE_CREDENTIAL_PATTERNS) {
            if (pattern.test(content)) {
              return { allowed: false, reason, source: 'regex' };
            }
          }
        }
        return ALLOWED();
      }

      // Other tools — pass through. Operators audit MCP tools at
      // registration time; Read/Edit/Grep are inherently safe.
      return ALLOWED();
    } catch {
      return ALLOWED(); // fail-open
    }
  }

  private extractBashCommand(args: unknown): string | null {
    if (!args || typeof args !== 'object') return null;
    const obj = args as Record<string, unknown>;
    // Common arg names: `command` (Bash), `cmd`, `script`.
    for (const key of ['command', 'cmd', 'script']) {
      const v = obj[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return null;
  }

  private extractWriteContent(args: unknown): string | null {
    if (!args || typeof args !== 'object') return null;
    const obj = args as Record<string, unknown>;
    for (const key of ['content', 'text', 'data']) {
      const v = obj[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return null;
  }

  private async classifyBash(command: string): Promise<PolicyDecision> {
    if (!this.opts.classifier) return ALLOWED();
    const minConf = this.opts.minClassifierConfidence ?? 0.9;
    const timeoutMs = this.opts.classifierTimeoutMs ?? 3000;
    const output: AgentOutputForClassification = {
      taskText: 'Pre-execution policy check',
      outputText: `Bash command about to run:\n\`${command}\``,
    };
    try {
      const verdict = await withTimeout(
        this.opts.classifier.classify(output),
        timeoutMs,
      );
      if (verdict.verdict === 'flagged' && (verdict.confidence ?? 0) >= minConf) {
        return {
          allowed: false,
          reason: verdict.reason ?? 'Policy classifier flagged this command as unsafe.',
          source: 'classifier',
          confidence: verdict.confidence ?? undefined,
        };
      }
    } catch {
      // Timeout or classifier error → fail-open.
    }
    return ALLOWED();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('policy-classifier-timeout')), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
