/**
 * P1b — coverage-aware read ledger (TOP-LEVEL read path only).
 *
 * WHY (telemetry jul/2026): 46% of repeated reads requested a line range
 * FULLY covered by content already delivered earlier in the session.
 * Overlapping-but-not-identical ranges evade the exact-slice pre-read guard
 * (e.g. 1-130, then 15-230, then 120-335 of the same file — one session
 * re-read the same PHP gateway 73×). This ledger tracks the union of line
 * ranges actually SERVED per path and answers "is [start,end] already in
 * context, and through which tool_results?".
 *
 * Design constraints (each learned the hard way):
 *  - POINTER, not hard refusal: 38% of read refusals were followed by a
 *    varied-args retry of the same path (refusals teach range-jitter).
 *  - Never wired into rolling-reduction/elision: eliding distinct chunks
 *    was the session-609 regression (the model re-read MORE).
 *  - Honesty rule: only claim "in your context" when
 *    the covering tool_results are verifiably still visible AND still SHOW
 *    the claimed lines — the ledger records what the tool emitted, but the
 *    smart reducer / finalize cap can trim the delivered content AFTER
 *    recording. Callers pass `liveSpanOf` so every segment contributes only
 *    ledger∩live (observed 2026-07-09: a `[lines 550-1000]` read truncated
 *    at ~761 made the pointer claim lines the model never saw).
 *  - Mutations clear a path's coverage: a re-read after an edit fetches new
 *    state (the mutation-aware diff path in the runner handles that flow).
 *  - Top-level only: nested code_exec reads deliver into script space, not
 *    history — counting them would gaslight the model about its context.
 *
 * Always on; there is no kill switch.
 */

export function readCoverageEnabled(): boolean {
  return true;
}

export interface ServedSegment {
  start: number;
  end: number;
  turn: number;
  useId: string;
  /** File mtime observed when the segment was served. Segments without an
   *  mtime (stat failed) never satisfy an mtime-validated coverage query. */
  mtimeMs?: number;
}

/** Bound per-path memory; oldest segments drop first (coverage degrades
 *  conservatively — worst case we allow a read we could have pointed). */
const MAX_SEGMENTS_PER_PATH = 64;

export class ReadCoverageLedger {
  private byPath = new Map<string, ServedSegment[]>();

  noteServed(path: string, seg: ServedSegment): void {
    if (seg.start < 1 || seg.end < seg.start) return;
    const list = this.byPath.get(path) ?? [];
    list.push(seg);
    if (list.length > MAX_SEGMENTS_PER_PATH) list.splice(0, list.length - MAX_SEGMENTS_PER_PATH);
    this.byPath.set(path, list);
  }

  /** A mutation invalidates everything we served for the path. */
  noteMutation(path: string): void {
    this.byPath.delete(path);
  }

  clear(): void {
    this.byPath.clear();
  }

  /**
   * Segments whose union covers [start,end] (adjacency counts: 1-10 + 11-20
   * covers 1-20). Returns the contributing segments, or null when there is
   * a gap. Deterministic over insertion order.
   *
   * `requireMtimeMs`: only segments observed at exactly that file mtime
   * count — guards against edits made OUTSIDE the session (the IDE editor),
   * which `recentWrites` cannot see.
   *
   * `liveSpanOf`: honesty hook — resolves the line span a segment's
   * tool_result STILL shows in the live history (null → gone / elided /
   * not line content). When provided, each segment contributes only
   * ledger∩live, so reducer or cap truncation shrinks a segment instead
   * of letting it claim lines the model cannot quote.
   */
  coveringSegments(
    path: string,
    start: number,
    end: number,
    opts?: {
      requireMtimeMs?: number;
      liveSpanOf?: (seg: ServedSegment) => { start: number; end: number } | null;
    },
  ): ServedSegment[] | null {
    if (start < 1 || end < start) return null;
    let segs = this.byPath.get(path);
    if (!segs || segs.length === 0) return null;
    if (opts?.requireMtimeMs !== undefined) {
      segs = segs.filter((s) => s.mtimeMs === opts.requireMtimeMs);
      if (segs.length === 0) return null;
    }
    let ranges = segs.map((s) => ({ seg: s, start: s.start, end: s.end }));
    if (opts?.liveSpanOf) {
      const verified: typeof ranges = [];
      for (const r of ranges) {
        const live = opts.liveSpanOf(r.seg);
        if (!live) continue;
        const s = Math.max(r.start, live.start);
        const e = Math.min(r.end, live.end);
        if (e >= s) verified.push({ seg: r.seg, start: s, end: e });
      }
      if (verified.length === 0) return null;
      ranges = verified;
    }
    const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
    const contributors: ServedSegment[] = [];
    let need = start;
    for (const r of sorted) {
      if (need > end) break;
      if (r.end < need) continue; // entirely before the uncovered point
      if (r.start > need) return null; // gap
      contributors.push(r.seg);
      need = r.end + 1;
    }
    return need > end ? contributors : null;
  }
}

/**
 * The contiguous line span actually VISIBLE in a read result's live content.
 * Read bodies are line-numbered (`%5d\t` in the native fs.ts read, `%d\t` in
 * the MCP file.ts read); we walk numbered lines from the first hit and stop
 * at the first break in contiguity — reducer/finalize-cap tail truncation,
 * mid-content elision markers, footers. Returns null when no numbered body
 * line is present (diffs, pointers, skeletons — nothing quotable as lines).
 *
 * This is the honesty primitive behind `liveSpanOf`/`requiredSpan`: headers
 * state what the tool INTENDED to serve and survive truncation, so only the
 * numbered body proves what the model can actually quote.
 */
export function visibleSpanOf(content: string): { start: number; end: number } | null {
  let start = -1;
  let end = -1;
  for (const line of content.split('\n')) {
    const m = /^ *(\d+)\t/.exec(line);
    if (!m) {
      if (start !== -1) break; // numbered run ended (marker / truncation / footer)
      continue; // header lines / notes before the body
    }
    const n = parseInt(m[1], 10);
    if (start === -1) {
      start = n;
      end = n;
    } else if (n === end + 1) {
      end = n;
    } else {
      break; // gap — beyond this nothing is contiguous with the start
    }
  }
  return start === -1 ? null : { start, end };
}

/**
 * Parse the served window from a read_file-style result. Both the native
 * read (`fs.ts` richHeader) and the MCP read emit:
 *   `<path> | <N> lines | <ext>` then `[lines <A>-<B>]`.
 * BOTH markers are required — a missing `[lines]` tag (symbol bodies,
 * skeletons, unknown formats) returns null so we never claim coverage we
 * cannot prove.
 */
export function parseServedRange(
  rawContent: string,
): { fileLines: number; start: number; end: number } | null {
  const head = rawContent.slice(0, 300);
  const fl = head.match(/\|\s*(\d+)\s+lines\b/i);
  if (!fl) return null;
  const win = head.match(/\[lines\s+(\d+)\s*-\s*(\d+)\]/i);
  if (!win) return null;
  const start = parseInt(win[1], 10);
  const end = parseInt(win[2], 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { fileLines: parseInt(fl[1], 10), start, end };
}

/**
 * Deterministic pointer returned INSTEAD of re-fetched content (auto-
 * downgrade style, non-error). Budget-conscious: 2-3 lines — the refusal
 * must never cost more tokens than the content it prevents.
 */
export function buildCoveragePointer(args: {
  toolName: string;
  path: string;
  start: number;
  end: number;
  segments: ServedSegment[];
}): string {
  const segTxt = args.segments
    .map((s) => `${s.start}-${s.end} @ turn ${s.turn}`)
    .join('; ');
  return (
    `[already-read] \`${args.path}\` lines ${args.start}-${args.end} are already in your context ` +
    `(served as: ${segTxt}) and the file has not changed since. Quote what you have instead of ` +
    `re-reading. Pass \`${freshReadParam(args.toolName)}: true\` only if you believe your copy is stale.`
  );
}

/**
 * The argument that asks for fresh content past the already-read pointer and
 * the diff-after-edit reread. The native read_file keeps its slim schema (no
 * force_reread); its `force` ("the full, current content") carries that
 * intent. The MCP reads declare `force_reread`.
 */
export function freshReadParam(toolName: string): 'force' | 'force_reread' {
  return toolName === 'read_file' ? 'force' : 'force_reread';
}

/** This read carries its tool's fresh-read argument (or the historical force_reread). */
export function requestsFreshRead(toolName: string, input: unknown): boolean {
  const inp = input as Record<string, unknown> | null | undefined;
  return inp?.force_reread === true || inp?.[freshReadParam(toolName)] === true;
}

/** Header of a reread served as a diff because the file changed since the prior read. */
export function rereadAfterEditHeader(toolName: string, path: string, priorTurn: number): string {
  return `[reread-after-edit] \`${path}\` was mutated since your prior read at turn ${priorTurn}. ` +
    `Returning unified diff against that read (pass \`${freshReadParam(toolName)}: true\` to bypass diff and get full content).`;
}
