/**
 * Skip-stale check (PR-D).
 *
 * Before dispatching a task, fingerprint its inputs and compare against
 * the last successful run's fingerprint (stored in
 * `coder_task_run_items.inputs_fingerprint`). If they match, skip —
 * the work is provably unnecessary.
 *
 * Fingerprint composition (deterministic, order-independent):
 *
 *   sha256(
 *     SYSTEM_PROMPT_VERSION + '|' +
 *     task.kind + '|' +
 *     task.title + '|' +
 *     task.description + '|' +
 *     sorted(file:mtimeMs:size, ...)  for each path in task.files (cap 20)
 *   )
 *
 * Pre-check is `fs.statSync` only — no file content read. If the path
 * doesn't exist, we encode `missing:path` so creating the file later
 * invalidates the fingerprint. Files outside the project root are also
 * encoded as `external:path` to avoid stat'ing arbitrary filesystem.
 *
 * Bypass:
 *   - env `CODER_TASKS_DISABLE_SKIP_STALE=1` disables globally.
 *   - per-task `force_run: true` skips the check for one task.
 *   - missing `sessionStore` or `task.files.length === 0` → no skip.
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/index.js';
import type { SessionId } from '@mcp/session-storage';
import type { CoderTask } from '@mcp/code-agent/sessions/types.js';
import { SYSTEM_PROMPT_VERSION } from '@mcp/code-agent/core/runner/assembly/system-prompt.js';
import { taskKind } from './task-run-types.js';

/** Hard cap on files included in fingerprint (PR-D risk note). */
const MAX_FINGERPRINT_FILES = 20;

export interface ComputeFingerprintArgs {
  task: CoderTask;
  cwd: string;
  /** Override for tests; production uses SYSTEM_PROMPT_VERSION. */
  systemPromptVersion?: string;
}

/**
 * Deterministic 16-char hex digest of the task + its file metadata.
 * Returns `null` when the file list exceeds the cap — that signals the
 * caller to NEVER skip (we can't be confident the inputs are unchanged
 * when we didn't even sample them all).
 */
export function computeTaskFingerprint(args: ComputeFingerprintArgs): string | null {
  const { task, cwd } = args;
  if (task.files.length > MAX_FINGERPRINT_FILES) return null;

  const version = args.systemPromptVersion ?? SYSTEM_PROMPT_VERSION;
  const parts: string[] = [
    `v=${version}`,
    `kind=${taskKind(task)}`,
    `title=${task.title}`,
    `desc=${task.description}`,
  ];

  // Sort paths so file order in the task definition doesn't affect hash.
  const sortedPaths = [...task.files].sort();
  for (const rel of sortedPaths) {
    parts.push(`file=${describeFile(rel, cwd)}`);
  }

  const digest = createHash('sha256').update(parts.join('\n')).digest('hex');
  return digest.slice(0, 16);
}

function describeFile(pathInput: string, cwd: string): string {
  const trimmed = pathInput.trim();
  if (!trimmed) return 'empty:';
  const abs = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
  // Reject paths that try to escape the project root — encoded as
  // 'external' so the fingerprint still changes if the path changes,
  // but we never call statSync on them (defense in depth).
  const normalizedCwd = resolve(cwd);
  if (!abs.startsWith(normalizedCwd)) return `external:${trimmed}`;
  try {
    const s = statSync(abs);
    return `${trimmed}|mtime=${Math.floor(s.mtimeMs)}|size=${s.size}`;
  } catch {
    return `missing:${trimmed}`;
  }
}

// ─── Skip decision ──────────────────────────────────────────────

export interface ShouldSkipArgs {
  task: CoderTask;
  cwd: string;
  store: FsSessionStore | null | undefined;
  sessionId: SessionId | null | undefined;
  /** Override; tests pass a fixed string so the fingerprint is stable. */
  systemPromptVersion?: string;
}

export interface ShouldSkipResult {
  skip: boolean;
  /** Always returned (or null when uncomputable). Caller persists this on success. */
  fingerprint: string | null;
  /** Set when skip=true. */
  reason?: string;
}

/**
 * Decide whether `task` can be skipped because its inputs haven't
 * changed since the last successful run. Pure aside from a single DB
 * read + N fs.statSync calls.
 */
export async function shouldSkipTask(
  args: ShouldSkipArgs,
): Promise<ShouldSkipResult> {
  // Global bypass via env.
  if (process.env.CODER_TASKS_DISABLE_SKIP_STALE === '1') {
    return { skip: false, fingerprint: null };
  }
  // Per-task bypass.
  if (args.task.force_run) {
    return { skip: false, fingerprint: null };
  }
  // No files declared → no fingerprint possible → don't skip.
  if (args.task.files.length === 0) {
    return { skip: false, fingerprint: null };
  }

  const fingerprint = computeTaskFingerprint({
    task: args.task,
    cwd: args.cwd,
    systemPromptVersion: args.systemPromptVersion,
  });
  if (fingerprint == null) {
    // Too many files — refuse to skip (caller still runs the task).
    return { skip: false, fingerprint: null };
  }

  if (!args.store || args.sessionId == null) {
    // No persistence layer → no history to compare against.
    return { skip: false, fingerprint };
  }

  let lastItem;
  try {
    lastItem = await args.store.findLastCompletedTaskItem(
      args.sessionId,
      args.task.id,
    );
  } catch (e) {
    console.warn(
      `[coder/tasks] shouldSkipTask: bundle lookup failed (${e instanceof Error ? e.message : String(e)}); will not skip`,
    );
    return { skip: false, fingerprint };
  }

  if (!lastItem) return { skip: false, fingerprint };
  if (lastItem.inputs_fingerprint && lastItem.inputs_fingerprint === fingerprint) {
    return {
      skip: true,
      fingerprint,
      reason: 'inputs_unchanged',
    };
  }
  return { skip: false, fingerprint };
}
