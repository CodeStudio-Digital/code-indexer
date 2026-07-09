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
 *  - Honesty rule (see buildRichRefusal): only claim "in your context" when
 *    the covering tool_results are verifiably still visible — the caller
 *    must check each covering segment's useId against the live messages.
 *  - Mutations clear a path's coverage: a re-read after an edit fetches new
 *    state (the mutation-aware diff path in the runner handles that flow).
 *  - Top-level only: nested code_exec reads deliver into script space, not
 *    history — counting them would gaslight the model about its context.
 *
 * Kill switch: CODER_READ_COVERAGE_DISABLE=1.
 */

export function readCoverageEnabled(): boolean {
  return process.env.CODER_READ_COVERAGE_DISABLE !== '1';
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
   */
  coveringSegments(
    path: string,
    start: number,
    end: number,
    opts?: { requireMtimeMs?: number },
  ): ServedSegment[] | null {
    if (start < 1 || end < start) return null;
    let segs = this.byPath.get(path);
    if (!segs || segs.length === 0) return null;
    if (opts?.requireMtimeMs !== undefined) {
      segs = segs.filter((s) => s.mtimeMs === opts.requireMtimeMs);
      if (segs.length === 0) return null;
    }
    const sorted = [...segs].sort((a, b) => a.start - b.start || a.end - b.end);
    const contributors: ServedSegment[] = [];
    let need = start;
    for (const s of sorted) {
      if (need > end) break;
      if (s.end < need) continue; // entirely before the uncovered point
      if (s.start > need) return null; // gap
      contributors.push(s);
      need = s.end + 1;
    }
    return need > end ? contributors : null;
  }
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
  const fl = head.match(/\|\s*(\d+)\s+lines\b/);
  if (!fl) return null;
  const win = head.match(/\[lines\s+(\d+)\s*-\s*(\d+)\]/);
  if (!win) return null;
  const start = parseInt(win[1], 10);
  const end = parseInt(win[2], 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { fileLines: parseInt(fl[1], 10), start, end };
}

/**
 * Deterministic pointer returned INSTEAD of re-fetched content (auto-
 * downgrade style, non-error). Budget-conscious: 2-3 lines — the refusal
 * must never cost more tokens than the content it prevents (see the
 * buildRichRefusal design note).
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
    `re-reading. Pass \`force_reread: true\` only if you believe your copy is stale.`
  );
}
