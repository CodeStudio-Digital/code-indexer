/**
 * Per-tool smart reducers for push-time truncation.
 *
 * The default push-time cap (runner.ts buildToolResultBlock) is a blind hard
 * cut at N chars. That works for most tools but throws away the most useful
 * information for a few high-volume ones:
 *
 *   - git_log: a 30k-char log gets cut after the first 24k commits, hiding
 *     the most recent commits — usually the ones the agent cares about.
 *   - git_diff: a long diff gets cut mid-file, leaving the agent without
 *     the header for the LAST file changed.
 *   - grep_code / shell grep: a head-cut over-represents the first matched
 *     file and under-represents diversity across files.
 *   - run_command (tests/builds): errors and stack traces almost always
 *     live at the END of the output, which is the part a head-cut elides.
 *
 * Reducers below are applied BEFORE the generic cap when the content would
 * otherwise be truncated. They MUST be deterministic — same input must
 * always produce the same output, so server-side prompt caches stay stable
 * across turns.
 */

export interface ReducerInput {
  content: string;
  cap: number;
}

export interface ReducerOutput {
  /** Reduced content. Caller still applies the generic cap as a fail-safe. */
  content: string;
  /** True when the reducer actually shrank the content. */
  applied: boolean;
}

const ELIDED = (label: string, original: number, kept: number): string =>
  `\n[smart-reducer: ${label} — kept ${kept}/${original} chars]\n`;

/**
 * git_log reducer: keep the FIRST few commits (newest, since git log is
 * reverse-chronological) and the LAST few (oldest in the window) so the
 * agent sees both ends. Commits are split on the blank line between them.
 *
 * Heuristic budget: ~40% head, ~40% tail, ~20% safety margin. We never
 * grow content; if input <= cap we return as-is.
 */
export function reduceGitLog({ content, cap }: ReducerInput): ReducerOutput {
  if (content.length <= cap) return { content, applied: false };
  const commits = content.split(/\n(?=commit [0-9a-f]{7,40})/);
  if (commits.length <= 4) return { content, applied: false };

  const headBudget = Math.floor(cap * 0.4);
  const tailBudget = Math.floor(cap * 0.4);

  const head: string[] = [];
  let used = 0;
  for (const c of commits) {
    if (used + c.length + 1 > headBudget) break;
    head.push(c);
    used += c.length + 1;
  }
  const remaining = commits.slice(head.length);
  const tail: string[] = [];
  let usedTail = 0;
  for (let i = remaining.length - 1; i >= 0; i--) {
    const c = remaining[i];
    if (usedTail + c.length + 1 > tailBudget) break;
    tail.unshift(c);
    usedTail += c.length + 1;
  }
  if (head.length + tail.length >= commits.length) {
    return { content, applied: false };
  }
  const elidedCount = commits.length - head.length - tail.length;
  const reduced =
    head.join('\n') +
    `\n\n[smart-reducer: git_log — elided ${elidedCount} middle commit(s) of ${commits.length} total]\n\n` +
    tail.join('\n');
  return { content: reduced, applied: true };
}

/**
 * git_diff reducer: keep the FILE HEADERS for every changed file and the
 * first few hunks of each. This preserves the answer to "what files were
 * touched and what kind of change in each" even when the full diff is
 * massive. Within each file we keep the headers + the first 2 hunks.
 */
export function reduceGitDiff({ content, cap }: ReducerInput): ReducerOutput {
  if (content.length <= cap) return { content, applied: false };
  // Split per-file ("diff --git" markers).
  const files = content.split(/\n(?=diff --git )/);
  if (files.length === 0) return { content, applied: false };

  const reducedFiles: string[] = [];
  let total = 0;
  let elidedFiles = 0;
  let elidedHunks = 0;
  for (const f of files) {
    if (total > cap * 0.85) {
      elidedFiles++;
      continue;
    }
    // Per-file: keep headers + first 2 hunks.
    const hunks = f.split(/\n(?=@@ )/);
    if (hunks.length <= 3) {
      reducedFiles.push(f);
      total += f.length + 1;
      continue;
    }
    const kept = [hunks[0], ...hunks.slice(1, 3)].join('\n');
    const elided = hunks.length - 3;
    elidedHunks += elided;
    const piece = kept + `\n[smart-reducer: git_diff — ${elided} hunk(s) elided in this file]\n`;
    reducedFiles.push(piece);
    total += piece.length + 1;
  }
  if (elidedFiles === 0 && elidedHunks === 0) {
    // Reducer found nothing to elide (every file already small).
    return { content, applied: false };
  }
  let out = reducedFiles.join('\n');
  if (elidedFiles > 0) {
    out += `\n\n[smart-reducer: git_diff — ${elidedFiles} file(s) entirely elided due to budget]\n`;
  }
  return { content: out, applied: true };
}

/**
 * grep_code reducer: cap matches per FILE so a single long file doesn't
 * crowd out matches in other files. Lines without a path prefix
 * (e.g. plain ripgrep output without --no-heading) pass through.
 *
 * We expect lines shaped like `path/to/file.ts:42: matched line`.
 */
const GREP_PATH_RE = /^([^\s:]+(?:\.[a-zA-Z0-9]+)?):(\d+):/;
const PER_FILE_CAP = Number(process.env.CODER_GREP_PER_FILE_CAP ?? 8);

export function reduceGrep({ content, cap }: ReducerInput): ReducerOutput {
  if (content.length <= cap) return { content, applied: false };
  const lines = content.split('\n');
  const perFile = new Map<string, number>();
  const out: string[] = [];
  let totalElided = 0;
  for (const line of lines) {
    const m = GREP_PATH_RE.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const file = m[1];
    const count = (perFile.get(file) ?? 0) + 1;
    perFile.set(file, count);
    if (count <= PER_FILE_CAP) {
      out.push(line);
    } else {
      totalElided++;
    }
  }
  if (totalElided === 0) return { content, applied: false };
  const reduced =
    out.join('\n') +
    `\n[smart-reducer: grep — kept top ${PER_FILE_CAP} match(es) per file; elided ${totalElided} additional match(es)]\n`;
  return { content: reduced, applied: true };
}

/**
 * run_command reducer: keep the HEAD and TAIL of long outputs. Errors and
 * stack traces almost always live at the end (e.g. test failures, build
 * errors), so a head-only cut is the worst possible elision.
 */
export function reduceRunCommand({ content, cap }: ReducerInput): ReducerOutput {
  if (content.length <= cap) return { content, applied: false };
  // Split budget: 40% head, 50% tail, 10% margin for the marker.
  const headBudget = Math.floor(cap * 0.4);
  const tailBudget = Math.floor(cap * 0.5);
  const head = content.slice(0, headBudget);
  const tail = content.slice(content.length - tailBudget);
  const elided = content.length - headBudget - tailBudget;
  const reduced =
    head +
    `\n${ELIDED('run_command head/tail', content.length, headBudget + tailBudget).trim()} — ${elided} chars elided from middle\n` +
    tail;
  return { content: reduced, applied: true };
}

/**
 * Tool-name → reducer mapping. The runner consults this BEFORE applying the
 * blind push-time cap. A tool with no entry falls through to the original
 * head-cut behaviour. Add reducers conservatively — every entry is part of
 * the bit-stable contract.
 */
export const SMART_REDUCERS: Record<string, (input: ReducerInput) => ReducerOutput> = {
  git_log: reduceGitLog,
  git_diff: reduceGitDiff,
  grep_code: reduceGrep,
  mcp__grep_code: reduceGrep,
  run_command: reduceRunCommand,
};

/**
 * Apply the reducer registered for `toolName` (if any). Returns the
 * possibly-reduced content. Always idempotent: applying twice yields the
 * same result as applying once because every reducer short-circuits when
 * `content.length <= cap`.
 */
export function applySmartReducer(
  toolName: string,
  content: string,
  cap: number,
): string {
  const fn = SMART_REDUCERS[toolName];
  if (!fn) return content;
  const out = fn({ content, cap });
  return out.applied ? out.content : content;
}
