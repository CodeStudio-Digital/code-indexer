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
 *
 * Tools with no name-specific reducer fall through to `jsonCrush`, a
 * CONTENT-TYPE reducer for generic JSON-array / NDJSON outputs (MCP servers,
 * code_exec). See ./reducers/json-crush.ts.
 */

import { jsonCrush } from './reducers/json-crush.js';
import { stripUnpairedSurrogates } from './text-boundaries.js';
import type { ToolSourceTruncation } from './tool.js';

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

export type ReductionKind = 'none' | 'source_cap' | 'semantic' | 'json_crush' | 'hard_cap';

export interface ReductionStage {
  stage: 'source_cap' | 'semantic' | 'structured' | 'spill' | 'recovery_marker' | 'hard_cap';
  technique: string;
  inputChars: number;
  outputChars: number;
  recoverable: boolean;
  /** Original producer dimension (bytes/rows/etc.), when this is source_cap. */
  source?: ToolSourceTruncation;
}

/** Structured accounting for one push-time shaping decision. */
export interface ReductionReport {
  kind: ReductionKind;
  technique: string;
  rawChars: number;
  shapedChars: number;
  cap: number;
  preserved: string[];
  /** Ordered shaping history; unlike `kind`, later stages never overwrite it. */
  stages?: ReductionStage[];
  /** Resolved per-tool contract included in reduction_meta_json telemetry. */
  policyMode?: string;
  recovery?: string;
  /** Filled by the finalizer when the raw payload was spilled. */
  outputId?: string;
}

export interface DetailedReduction {
  content: string;
  report: ReductionReport;
}

export interface SmartReducerOptions {
  /** Latest user-turn text, used only for deterministic row relevance. */
  query?: string;
  /** Original call arguments, when the dispatch path can provide them. */
  args?: Record<string, unknown>;
  /** Whether the tool result represents a failure. */
  isError?: boolean;
  /** Producer-declared content type/format, such as application/json. */
  contentFormat?: string;
}

const ELIDED = (label: string, original: number, kept: number): string =>
  `\n[smart-reducer: ${label} — kept ${kept}/${original} chars]\n`;

function validCap(cap: number): number {
  return Number.isFinite(cap) && cap > 0 ? Math.max(1, Math.floor(cap)) : 1;
}

/** Final invariant for semantic reducers: deterministic head/tail, never > cap. */
function fitReducedContent(content: string, cap: number, technique: string): string {
  const safeCap = validCap(cap);
  if (content.length <= safeCap) return stripUnpairedSurrogates(content);
  const markerBase = `\n[smart-reducer: ${technique} — reduced output still exceeded cap; middle elided]\n`;
  if (markerBase.length >= safeCap) return markerBase.slice(0, safeCap);
  const room = safeCap - markerBase.length;
  const head = Math.ceil(room * 0.55);
  const tail = Math.max(0, room - head);
  return stripUnpairedSurrogates(
    content.slice(0, head) + markerBase + (tail > 0 ? content.slice(-tail) : ''),
  );
}

function compactMiddle(value: string, cap: number): string {
  if (value.length <= cap) return value;
  if (cap <= 1) return value.slice(0, Math.max(0, cap));
  if (cap === 2) return value[0] + value.at(-1);
  const room = cap - 1;
  const head = Math.ceil(room / 2);
  return value.slice(0, head) + '…' + value.slice(-(room - head));
}

function compactGitFileIndex(ids: string[], cap: number): string {
  const header = `changed files (${ids.length}):\n`;
  const footer = '\n[smart-reducer: git_diff file index — every changed file represented]';
  if (header.length + footer.length >= cap) {
    return fitReducedContent(`${header}${ids.join(', ')}`, cap, 'git_diff file index');
  }
  const separators = Math.max(0, ids.length - 1);
  const available = cap - header.length - footer.length - separators;
  const quota = ids.length > 0 ? Math.floor(available / ids.length) : 0;
  if (quota <= 0) return fitReducedContent(`${header}${ids.join(', ')}`, cap, 'git_diff file index');
  const lines = ids.map((id) => compactMiddle(id, quota));
  return (header + lines.join('\n') + footer).slice(0, cap);
}

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
  return { content: fitReducedContent(reduced, cap, 'git_log'), applied: true };
}

/**
 * git_diff reducer: keep the FILE HEADERS for every changed file and the
 * first few hunks of each. This preserves the answer to "what files were
 * touched and what kind of change in each" even when the full diff is
 * massive. Within each file we keep the headers + the first 2 hunks.
 */
export function reduceGitDiff({ content, cap }: ReducerInput): ReducerOutput {
  if (content.length <= cap) return { content, applied: false };
  const safeCap = validCap(cap);
  const files = content.split(/\n(?=diff --git )/).filter(Boolean);
  if (files.length === 0) return { content, applied: false };

  const parsed = files.map((file) => {
    const hunks = file.split(/\n(?=@@ )/);
    const header = hunks[0] ?? '';
    const id = /^diff --git\s+a\/(.+?)\s+b\/(.+)$/m.exec(header)?.[2]
      ?? /^\+\+\+\s+b\/(.+)$/m.exec(header)?.[1]
      ?? `(unknown file ${files.indexOf(file) + 1})`;
    return { id, header, hunks: hunks.slice(1) };
  });
  const marker = `\n[smart-reducer: git_diff — ${parsed.length} file(s); hunks distributed across files]\n`;
  const joinCost = Math.max(0, parsed.length - 1) * 2;
  const headersCost = parsed.reduce((n, file) => n + file.header.length, 0) + joinCost + marker.length;

  // Full headers do not fit: retain a compact representation of the complete
  // file set (count + both ends) rather than silently dropping later files.
  if (headersCost > safeCap) {
    return { content: compactGitFileIndex(parsed.map((file) => file.id), safeCap), applied: true };
  }

  const remaining = Math.max(0, safeCap - headersCost);
  const perFileBudget = parsed.length > 0 ? Math.floor(remaining / parsed.length) : 0;
  let elidedHunks = 0;
  const pieces = parsed.map((file) => {
    let used = 0;
    const kept: string[] = [];
    for (const hunk of file.hunks) {
      const cost = hunk.length + 1;
      if (used + cost > perFileBudget) {
        elidedHunks++;
        continue;
      }
      kept.push(hunk);
      used += cost;
    }
    return [file.header, ...kept].join('\n');
  });
  const out = pieces.join('\n\n') +
    `\n[smart-reducer: git_diff — ${elidedHunks} hunk(s) elided; all ${parsed.length} file header(s) kept]\n`;
  return { content: fitReducedContent(out, safeCap, 'git_diff'), applied: true };
}

/**
 * grep_code reducer: cap matches per FILE so a single long file doesn't
 * crowd out matches in other files. Lines without a path prefix
 * (e.g. plain ripgrep output without --no-heading) pass through.
 *
 * We expect lines shaped like `path/to/file.ts:42: matched line`.
 */
const GREP_PATH_RE = /^(.+?):(\d+):/;

function grepPerFileCap(): number {
  return 10;
}

export function reduceGrep({ content, cap }: ReducerInput): ReducerOutput {
  if (content.length <= cap) return { content, applied: false };
  const lines = content.split('\n');
  const perFileCap = grepPerFileCap();
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
    if (count <= perFileCap) {
      out.push(line);
    } else {
      totalElided++;
    }
  }
  if (totalElided === 0) return { content, applied: false };
  const reduced =
    out.join('\n') +
    `\n[smart-reducer: grep — kept top ${perFileCap} match(es) per file; elided ${totalElided} additional match(es)]\n`;
  return { content: fitReducedContent(reduced, cap, 'grep'), applied: true };
}

/**
 * run_command reducer: parse the envelope emitted by tools/shell.ts
 * (`$ <command>` + `exit code: N` + optional `--- stdout ---` /
 * `--- stderr ---` blocks) and dispatch to a per-command sub-reducer when
 * we recognize the head (git status, npm install, pytest, docker logs, …).
 *
 * Sub-reducers are deterministic and idempotent, like the generic ones.
 * If parsing fails or no sub-reducer applies, we fall through to the
 * head/tail elision below — that path stays bit-stable with the v1
 * behavior so prefix caches remain hot for unrecognized commands.
 */

interface ParsedRunCommand {
  command: string;
  head: string;
  sub: string | null;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

const RUN_COMMAND_SUB_HEADS = new Set([
  'git', 'docker', 'kubectl', 'npm', 'pnpm', 'yarn', 'cargo', 'pip', 'aws', 'gh', 'go',
]);

function parseRunCommand(content: string): ParsedRunCommand | null {
  const lines = content.split('\n');
  if (lines.length < 2) return null;
  if (!lines[0].startsWith('$ ')) return null;
  const exitMatch = /^exit code: (-?\d+|killed)( \(timed out\))?$/.exec(lines[1]);
  if (!exitMatch) return null;

  const command = lines[0].slice(2);
  const exitCode = exitMatch[1] === 'killed' ? null : Number(exitMatch[1]);
  const timedOut = !!exitMatch[2];

  let stdout = '';
  let stderr = '';
  for (let i = 2; i < lines.length; i++) {
    if (lines[i] === '--- stdout ---') {
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] === '--- stderr ---') { end = j; break; }
      }
      stdout = lines.slice(i + 1, end).join('\n');
      i = end - 1;
    } else if (lines[i] === '--- stderr ---') {
      stderr = lines.slice(i + 1).join('\n');
      break;
    }
  }

  const parts = command.trim().split(/\s+/);
  const head = parts[0] ?? '';
  let sub: string | null = null;
  if (RUN_COMMAND_SUB_HEADS.has(head)) {
    sub = parts.slice(1).find((p) => !p.startsWith('-')) ?? null;
  }

  return { command, head, sub, exitCode, timedOut, stdout, stderr };
}

function rebuildRunCommand(parsed: ParsedRunCommand, newStdout: string, newStderr: string, marker: string): string {
  const out: string[] = [`$ ${parsed.command}`];
  out.push(`exit code: ${parsed.exitCode ?? 'killed'}${parsed.timedOut ? ' (timed out)' : ''}`);
  if (newStdout.trim()) {
    out.push('--- stdout ---');
    out.push(newStdout);
  }
  if (newStderr.trim()) {
    out.push('--- stderr ---');
    out.push(newStderr);
  }
  if (marker) out.push(marker);
  return out.join('\n');
}

/**
 * git status: drop the `(use "git ...")` help lines and cap files per
 * section. Works for both long form (starts with "On branch") and
 * porcelain (`-s`/`--porcelain`).
 */
export function reduceGitStatusBody(stdout: string): string {
  const lines = stdout.split('\n');
  if (lines.length === 0) return stdout;
  const isLong = /^(On branch |HEAD detached )/.test(lines[0]);
  if (!isLong) {
    const groups = new Map<string, string[]>();
    for (const line of lines) {
      if (!line.trim()) continue;
      const prefix = line.slice(0, 2);
      const arr = groups.get(prefix) ?? [];
      arr.push(line);
      groups.set(prefix, arr);
    }
    const out: string[] = [];
    for (const [prefix, arr] of groups) {
      if (arr.length <= 5) out.push(...arr);
      else {
        out.push(...arr.slice(0, 5));
        out.push(`... ${arr.length - 5} more line(s) with prefix '${prefix}'`);
      }
    }
    return out.join('\n');
  }
  const out: string[] = [];
  let pending: string[] = [];
  const flush = (): void => {
    if (pending.length <= 5) out.push(...pending);
    else {
      out.push(...pending.slice(0, 5));
      // No leading tab on the summary line: that's deliberate so the
      // second pass of this reducer doesn't mistake the summary for a
      // file entry and re-process it (would otherwise stack markers).
      out.push(`... ${pending.length - 5} more file(s)`);
    }
    pending = [];
  };
  for (const line of lines) {
    if (/^\s+\(use /.test(line)) continue;
    if (line.startsWith('\t')) {
      pending.push(line);
    } else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out.join('\n');
}

/**
 * git push / pull / fetch — success path distills to the ref-update lines
 * (To <url> + range  branch -> branch); failure path keeps everything so
 * the agent can read the real error.
 */
export function reduceGitPushPullBody(parsed: ParsedRunCommand): { stdout: string; stderr: string; marker: string } | null {
  if (parsed.exitCode !== 0) return null;
  // git push/pull/fetch write status to stderr by design.
  const scan = [parsed.stderr, parsed.stdout].join('\n').split('\n');
  const keep: string[] = [];
  for (const line of scan) {
    if (/^To /.test(line)) keep.push(line);
    else if (/^\s+[0-9a-f]+\.\.[0-9a-f]+\s+\S+\s+->\s+\S+/.test(line)) keep.push(line);
    else if (/^Already up to date\.?$/.test(line)) keep.push(line);
    else if (/^Updating [0-9a-f]+\.\.[0-9a-f]+/.test(line)) keep.push(line);
    else if (/^Fast-forward/.test(line)) keep.push(line);
    else if (/^\s+\d+ files? changed/.test(line)) keep.push(line);
  }
  const summary = keep.length > 0 ? keep.join('\n') : `${parsed.head} ${parsed.sub ?? ''}: ok`.trim();
  return {
    stdout: '',
    stderr: summary,
    marker: `[smart-reducer: ${parsed.head}_${parsed.sub} — success distilled to ref-update lines]`,
  };
}

/**
 * npm / pnpm / yarn install — keep warnings, errors, and the final
 * "added N packages" summary. Drop progress spinners / "Progress: resolved …".
 */
export function reduceNpmInstallBody(stdout: string, stderr: string): { stdout: string; stderr: string } | null {
  const keep = (src: string): string[] => {
    const out: string[] = [];
    for (const line of src.split('\n')) {
      if (!line.trim()) continue;
      // Braille progress spinners (used by pnpm/yarn) — start with U+2800 range
      if (/^[⠀-⣿]/.test(line)) continue;
      // "Progress: resolved 123, reused 45, downloaded 6, added 0" — noisy
      if (/^Progress: resolved\s/.test(line)) continue;
      // Generic percentage progress
      if (/^\s*\[[#=\-> ]+\]\s+\d+\/\d+/.test(line)) continue;
      // npm/pnpm/yarn warnings/errors
      if (/^(npm |yarn |pnpm )?(warn|err|error|notice|info)\b/i.test(line)) { out.push(line); continue; }
      // pnpm package totals: "Packages: +123 -45"
      if (/^Packages:\s+[+-]\d+/.test(line)) { out.push(line); continue; }
      // Final summary lines from any of the three
      if (/^(added|removed|changed|audited)\s+\d+\s+package/i.test(line)) { out.push(line); continue; }
      if (/^up to date(,|\.| in )/i.test(line)) { out.push(line); continue; }
      if (/^Done in /.test(line)) { out.push(line); continue; }
      if (/found \d+ vulnerabilit/i.test(line)) { out.push(line); continue; }
    }
    return out;
  };
  const newStdout = keep(stdout).join('\n');
  const newStderr = keep(stderr).join('\n');
  const newLen = newStdout.length + newStderr.length;
  const oldLen = stdout.length + stderr.length;
  if (newLen >= oldLen) return null;
  return { stdout: newStdout, stderr: newStderr };
}

/**
 * pytest / vitest / jest — failure mode keeps the FAILURES block to the
 * end; success mode keeps just the last few lines (summary).
 */
export function reduceTestRunnerBody(
  parsed: ParsedRunCommand,
  kind: 'pytest' | 'vitest' | 'jest',
): { stdout: string; stderr: string; marker: string } | null {
  const combined = [parsed.stdout, parsed.stderr].filter(Boolean).join('\n');
  const lines = combined.split('\n');
  if (lines.length < 20) return null;

  if (parsed.exitCode === 0) {
    const final = lines.slice(-10).join('\n');
    return {
      stdout: final,
      stderr: '',
      marker: `[smart-reducer: ${kind} success — kept final summary only]`,
    };
  }

  let anchorIdx = -1;
  if (kind === 'pytest') {
    anchorIdx = lines.findIndex((l) => /^=+\s*(FAILURES?|ERRORS?)\s*=+$/.test(l));
  } else {
    // vitest/jest: "FAIL " lines or "Failed Tests" separators
    anchorIdx = lines.findIndex((l) =>
      /^(FAIL |⎯+\s*Failed Tests\s*\d+)/.test(l) || /^\s+FAIL\s/.test(l)
    );
  }
  if (anchorIdx === -1) {
    return {
      stdout: lines.slice(-15).join('\n'),
      stderr: '',
      marker: `[smart-reducer: ${kind} failure — no FAILURES anchor; kept last 15 lines]`,
    };
  }
  return {
    stdout: lines.slice(anchorIdx).join('\n'),
    stderr: '',
    marker: `[smart-reducer: ${kind} failure — kept FAILURES section onward]`,
  };
}

/**
 * docker/kubectl logs — collapse runs of consecutive identical lines
 * (ignoring timestamp prefix) into `[same as previous × N times]`.
 */
export function reduceLogsDedupeBody(stdout: string): string | null {
  const lines = stdout.split('\n');
  if (lines.length < 20) return null;

  const normalize = (line: string): string =>
    line
      .replace(/^\S*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?\s*/, '')
      .replace(/^\d{2}:\d{2}:\d{2}(\.\d+)?\s*/, '');

  const out: string[] = [];
  let lastNorm: string | null = null;
  let lastLine = '';
  let runCount = 0;

  const flushRun = (): void => {
    if (runCount > 1) out.push(`[same as previous × ${runCount - 1} more time(s), last: ${lastLine}]`);
  };

  for (const line of lines) {
    const n = normalize(line);
    if (n === lastNorm) {
      runCount++;
      lastLine = line;
    } else {
      flushRun();
      out.push(line);
      lastNorm = n;
      lastLine = line;
      runCount = 1;
    }
  }
  flushRun();

  if (out.length >= lines.length) return null;
  return out.join('\n');
}

/**
 * ls / find / dir — when output is many entries, keep the first 20 and
 * follow with an extension breakdown.
 */
export function reduceLsFindBody(stdout: string): string | null {
  const lines = stdout.split('\n').filter((l) => l.trim());
  if (lines.length < 30) return null;
  const byExt = new Map<string, number>();
  let noExt = 0;
  for (const line of lines) {
    const m = /\.([a-zA-Z0-9]+)\s*$/.exec(line);
    if (m) byExt.set(m[1], (byExt.get(m[1]) ?? 0) + 1);
    else noExt++;
  }
  const sorted = [...byExt.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const out: string[] = [];
  out.push(...lines.slice(0, 20));
  out.push('');
  out.push(`[smart-reducer: ${lines.length} total entries; top extensions:`);
  for (const [ext, count] of sorted.slice(0, 10)) out.push(`  .${ext}: ${count}`);
  if (noExt > 0) out.push(`  (no extension): ${noExt}`);
  out.push(']');
  return out.join('\n');
}

function applyPerCommandReducer(parsed: ParsedRunCommand): string | null {
  const { head, sub } = parsed;

  if (head === 'git') {
    if (sub === 'status') {
      const newStdout = reduceGitStatusBody(parsed.stdout);
      if (newStdout === parsed.stdout) return null;
      return rebuildRunCommand(parsed, newStdout, parsed.stderr,
        `[smart-reducer: git_status — dropped help lines, capped files per section]`);
    }
    if (sub === 'push' || sub === 'pull' || sub === 'fetch') {
      const r = reduceGitPushPullBody(parsed);
      if (!r) return null;
      return rebuildRunCommand(parsed, r.stdout, r.stderr, r.marker);
    }
  }

  if ((head === 'npm' || head === 'pnpm' || head === 'yarn') &&
      (sub === 'install' || sub === 'i' || sub === 'add' || sub === 'ci')) {
    const r = reduceNpmInstallBody(parsed.stdout, parsed.stderr);
    if (!r) return null;
    return rebuildRunCommand(parsed, r.stdout, r.stderr,
      `[smart-reducer: ${head}_install — kept warnings/errors/summary; trimmed progress noise]`);
  }

  if (head === 'pytest') {
    const r = reduceTestRunnerBody(parsed, 'pytest');
    if (!r) return null;
    return rebuildRunCommand(parsed, r.stdout, r.stderr, r.marker);
  }
  if (head === 'vitest' || /\bvitest\b/.test(parsed.command)) {
    const r = reduceTestRunnerBody(parsed, 'vitest');
    if (!r) return null;
    return rebuildRunCommand(parsed, r.stdout, r.stderr, r.marker);
  }
  if (head === 'jest' || /\bjest\b/.test(parsed.command)) {
    const r = reduceTestRunnerBody(parsed, 'jest');
    if (!r) return null;
    return rebuildRunCommand(parsed, r.stdout, r.stderr, r.marker);
  }

  if ((head === 'docker' && sub === 'logs') || (head === 'kubectl' && sub === 'logs')) {
    const newStdout = reduceLogsDedupeBody(parsed.stdout);
    if (newStdout === null) return null;
    return rebuildRunCommand(parsed, newStdout, parsed.stderr,
      `[smart-reducer: ${head}_logs — collapsed consecutive identical lines]`);
  }

  if (head === 'ls' || head === 'find' || head === 'dir') {
    const newStdout = reduceLsFindBody(parsed.stdout);
    if (newStdout === null) return null;
    return rebuildRunCommand(parsed, newStdout, parsed.stderr,
      `[smart-reducer: ${head} — first 20 entries + extension breakdown]`);
  }

  return null;
}

function reduceRunCommandHeadTail({ content, cap }: ReducerInput): ReducerOutput {
  const headBudget = Math.floor(cap * 0.4);
  const tailBudget = Math.floor(cap * 0.5);
  const head = content.slice(0, headBudget);
  const tail = content.slice(content.length - tailBudget);
  const elided = content.length - headBudget - tailBudget;
  const reduced =
    head +
    `\n${ELIDED('run_command head/tail', content.length, headBudget + tailBudget).trim()} — ${elided} chars elided from middle\n` +
    tail;
  return { content: fitReducedContent(reduced, cap, 'run_command head/tail'), applied: true };
}

export function reduceRunCommand({ content, cap }: ReducerInput): ReducerOutput {
  if (content.length <= cap) return { content, applied: false };

  const parsed = parseRunCommand(content);
  if (parsed) {
    const reduced = applyPerCommandReducer(parsed);
    if (reduced && reduced.length < content.length) {
      // Per-command shaping may still exceed cap (lots of warnings / huge
      // stack trace). Run head/tail as a final safety net in that case.
      if (reduced.length > cap) {
        return reduceRunCommandHeadTail({ content: reduced, cap });
      }
      return { content: reduced, applied: true };
    }
  }

  return reduceRunCommandHeadTail({ content, cap });
}

/** Keep database tables syntactically intact by dropping whole rows only. */
export function reduceDbRows({ content, cap }: ReducerInput): ReducerOutput {
  if (content.length <= cap) return { content, applied: false };
  const lines = content.split('\n');
  let footerAt = -1;
  for (let index = lines.length - 1; index >= 2; index -= 1) {
    if (/^rows=\d+\s+truncated=(?:true|false)$/.test(lines[index])) {
      footerAt = index;
      break;
    }
  }
  if (footerAt < 2 || !lines[1]?.includes('---')) return { content, applied: false };

  const header = lines.slice(0, 2);
  const rows = lines.slice(2, footerAt);
  const footer = lines.slice(footerAt);
  const originalFooter = /^rows=(\d+)\s+truncated=(true|false)$/.exec(footer[0]);
  if (!originalFooter) return { content, applied: false };
  const sourceRows = Number(originalFooter[1]);
  const sourceTruncated = originalFooter[2] === 'true';
  const kept: string[] = [];
  const markerFor = (count: number): string =>
    `[smart-reducer: db rows — kept ${count}/${sourceRows} complete row(s); use the output_id recovery hint when present. Only rerun read-only queries with LIMIT/OFFSET]`;
  const footerFor = (count: number): string[] => [
    `rows=${count} truncated=${sourceTruncated || count < sourceRows}`,
    `source_rows=${sourceRows} source_truncated=${sourceTruncated}`,
    ...footer.slice(1),
  ];

  for (const row of rows) {
    const count = kept.length + 1;
    const candidate = [...header, ...kept, row, markerFor(count), ...footerFor(count)].join('\n');
    if (candidate.length > cap) break;
    kept.push(row);
  }
  const reduced = [...header, ...kept, markerFor(kept.length), ...footerFor(kept.length)].join('\n');
  if (reduced.length > cap) {
    const machineFooter = footerFor(0).join('\n');
    const suffix = `${markerFor(0)}\n${machineFooter}`;
    if (suffix.length >= cap) {
      // Tiny synthetic caps cannot carry both prose and the contract. Prefer
      // the truthful machine footer and keep it whole whenever physically
      // possible.
      const compact = `rows=0 truncated=true\nsource_rows=${sourceRows}`;
      return { content: compact.length <= cap ? compact : compact.slice(0, cap), applied: true };
    }
    const headerText = header.join('\n');
    const headerRoom = Math.max(0, cap - suffix.length - 1);
    const minimal = `${stripUnpairedSurrogates(headerText.slice(0, headerRoom))}\n${suffix}`;
    return { content: minimal, applied: true };
  }
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
  db_query: reduceDbRows,
  db_command: reduceDbRows,
};

/**
 * Apply the reducer registered for `toolName`. When there's no name-specific
 * reducer, fall back to `jsonCrush` (content-type detection for generic
 * JSON-array / NDJSON outputs). Returns the possibly-reduced content.
 *
 * Always idempotent: applying twice yields the same result as applying once
 * because every reducer short-circuits when `content.length <= cap`.
 *
 * `opts.query` (the latest user-turn text) is consumed only by the content-type
 * fallback to rank rows by relevance. It is captured once at tool-finalize and
 * the shaped result is persisted, so query-dependence never thrashes the cache.
 */
export function applySmartReducerDetailed(
  toolName: string,
  content: string,
  cap: number,
  opts?: SmartReducerOptions,
): DetailedReduction {
  const safeCap = validCap(cap);
  const fn = SMART_REDUCERS[toolName];
  if (fn) {
    const out = fn({ content, cap: safeCap });
    if (out.applied) {
      const shaped = fitReducedContent(out.content, safeCap, toolName);
      return {
        content: shaped,
        report: {
          kind: 'semantic',
          technique: toolName,
          rawChars: content.length,
          shapedChars: shaped.length,
          cap: safeCap,
          preserved: toolName === 'git_diff' ? ['file_headers', 'hunks']
            : toolName.includes('grep') ? ['file_diversity']
              : toolName === 'run_command' ? ['head', 'tail', 'errors']
                : toolName === 'db_query' || toolName === 'db_command' ? ['header', 'complete_rows', 'pagination_footer']
                : ['head', 'tail'],
          stages: [{
            stage: 'semantic',
            technique: toolName,
            inputChars: content.length,
            outputChars: shaped.length,
            recoverable: false,
          }],
        },
      };
    }
    // A registered reducer is not exclusive ownership of the payload. For
    // example, an MCP grep implementation may return a JSON results envelope
    // that the line-oriented grep reducer cannot recognize. Continue through
    // the content-type stage instead of forcing the generic hard cap.
  }
  const crushed = jsonCrush({
    content,
    cap: safeCap,
    query: opts?.query,
    args: opts?.args,
    isError: opts?.isError,
    contentFormat: opts?.contentFormat,
  });
  const shaped = crushed.applied ? fitReducedContent(crushed.content, safeCap, 'json-crush') : content;
  return {
    content: shaped,
    report: {
      kind: crushed.applied ? 'json_crush' : 'none',
      technique: crushed.applied ? 'json-crush' : 'none',
      rawChars: content.length,
      shapedChars: shaped.length,
      cap: safeCap,
      preserved: crushed.applied ? ['first_rows', 'last_rows', 'relevant_rows'] : [],
      stages: crushed.applied ? [{
        stage: 'structured',
        technique: 'json-crush',
        inputChars: content.length,
        outputChars: shaped.length,
        recoverable: false,
      }] : [],
    },
  };
}
