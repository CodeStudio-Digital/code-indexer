/**
 * 3-way merge model: overlay the change blocks of base↔ours and base↔theirs
 * and chunk the file into ordered regions. Two edits become ONE region only
 * when their base ranges genuinely OVERLAP — adjacent-but-disjoint edits stay
 * separate (oursOnly + theirsOnly) so independent changes are auto-merged
 * rather than collapsed into a false conflict (which would drop a side's work).
 */

import { splitLines, diffLines, spansOf, changeBlocks, otherAt, type ChangeBlock } from './line-diff.js';
import type { MergeModel, MergeRegion, RegionKind, RegionSide, ResolutionChoice, MergeMode } from './types.js';

type Tagged = ChangeBlock & { side: 'ours' | 'theirs' };

/** Base ranges overlap. Zero-width inserts only "overlap" another insert at the same point, or a block they sit strictly inside. */
function overlaps(a: { baseStart: number; baseEnd: number }, b: { baseStart: number; baseEnd: number }): boolean {
  const aIns = a.baseStart === a.baseEnd;
  const bIns = b.baseStart === b.baseEnd;
  if (aIns && bIns) return a.baseStart === b.baseStart;
  if (aIns) return a.baseStart > b.baseStart && a.baseStart < b.baseEnd;
  if (bIns) return b.baseStart > a.baseStart && b.baseStart < a.baseEnd;
  return a.baseStart < b.baseEnd && b.baseStart < a.baseEnd;
}

function side(lo: number, hi: number, lines: string[]): RegionSide {
  return { startLine: lo + 1, endLine: hi, text: lines.slice(lo, hi).join('\n') };
}

/** Other-range for a region's base range, widened to include member blocks (covers pure inserts). */
function otherRange(bLo: number, bHi: number, segsOtherAt: (b: number) => number, members: ChangeBlock[]): [number, number] {
  let lo = segsOtherAt(bLo);
  let hi = segsOtherAt(bHi);
  for (const m of members) {
    lo = Math.min(lo, m.otherStart);
    hi = Math.max(hi, m.otherEnd);
  }
  return [lo, hi];
}

export function computeMergeRegions(base: string | null, ours: string | null, theirs: string | null): MergeModel {
  let mode: MergeMode = 'three-way';
  if (base === null && ours !== null && theirs !== null) mode = 'addAdd';
  else if (base !== null && (ours === null) !== (theirs === null)) mode = 'modifyDelete';

  const baseLines = splitLines(base ?? '');
  const oursLines = splitLines(ours ?? '');
  const theirsLines = splitLines(theirs ?? '');
  const ourSpans = spansOf(diffLines(base ?? '', ours ?? ''));
  const theirSpans = spansOf(diffLines(base ?? '', theirs ?? ''));
  const ourAt = (b: number) => otherAt(b, ourSpans);
  const theirAt = (b: number) => otherAt(b, theirSpans);

  const blocks: Tagged[] = [
    ...changeBlocks(ourSpans).map((b) => ({ ...b, side: 'ours' as const })),
    ...changeBlocks(theirSpans).map((b) => ({ ...b, side: 'theirs' as const })),
  ].sort((a, b) => a.baseStart - b.baseStart || a.baseEnd - b.baseEnd);

  const raw: Omit<MergeRegion, 'id'>[] = [];
  // Running OTHER cursors (ours/theirs). A change region may absorb a pure
  // insert that sits at base position gHi; otherAt(gHi) still counts it, so the
  // NEXT region would re-claim those lines (double-count). Clamping every
  // region's other-start up to the running cursor makes each source's side
  // ranges a clean, non-overlapping partition.
  let oCursor = 0;
  let tCursor = 0;
  const pushUnchanged = (bLo: number, bHi: number) => {
    if (bHi <= bLo) return;
    const oLo = Math.max(oCursor, ourAt(bLo));
    const tLo = Math.max(tCursor, theirAt(bLo));
    const oHi = ourAt(bHi);
    const tHi = theirAt(bHi);
    raw.push({
      kind: 'unchanged',
      base: side(bLo, bHi, baseLines),
      ours: side(oLo, oHi, oursLines),
      theirs: side(tLo, tHi, theirsLines),
      resolution: 'base',
      unresolved: false,
    });
    oCursor = oHi;
    tCursor = tHi;
  };

  let cursor = 0;
  let i = 0;
  while (i < blocks.length) {
    let gLo = blocks[i].baseStart;
    let gHi = blocks[i].baseEnd;
    const members: Tagged[] = [blocks[i]];
    let j = i + 1;
    while (j < blocks.length && overlaps(blocks[j], { baseStart: gLo, baseEnd: gHi })) {
      gHi = Math.max(gHi, blocks[j].baseEnd);
      members.push(blocks[j]);
      j++;
    }
    pushUnchanged(cursor, gLo);
    const [oLo0, oHi] = otherRange(gLo, gHi, ourAt, members.filter((m) => m.side === 'ours'));
    const [tLo0, tHi] = otherRange(gLo, gHi, theirAt, members.filter((m) => m.side === 'theirs'));
    const oLo = Math.max(oLo0, oCursor);
    const tLo = Math.max(tLo0, tCursor);
    raw.push(classify(side(gLo, gHi, baseLines), side(oLo, oHi, oursLines), side(tLo, tHi, theirsLines)));
    oCursor = oHi;
    tCursor = tHi;
    cursor = gHi;
    i = j;
  }
  pushUnchanged(cursor, baseLines.length);

  const regions = raw.map((r, k) => ({ id: `r${k}`, ...r }));
  return {
    regions,
    changeCount: regions.filter((r) => r.kind !== 'unchanged').length,
    conflictCount: regions.filter((r) => r.kind === 'conflict').length,
    mode,
  };
}

// Line count from the span — text alone can't tell a 0-line (empty) region
// from a single blank line (both serialize to '').
const lineCount = (s: RegionSide) => (s.endLine >= s.startLine ? s.endLine - s.startLine + 1 : 0);
const sameSide = (a: RegionSide, b: RegionSide) => a.text === b.text && lineCount(a) === lineCount(b);

function classify(base: RegionSide, ours: RegionSide, theirs: RegionSide): Omit<MergeRegion, 'id'> {
  const oursChanged = !sameSide(ours, base);
  const theirsChanged = !sameSide(theirs, base);
  let kind: RegionKind;
  if (!oursChanged && !theirsChanged) kind = 'unchanged';
  else if (oursChanged && !theirsChanged) kind = 'oursOnly';
  else if (!oursChanged && theirsChanged) kind = 'theirsOnly';
  else if (sameSide(ours, theirs)) kind = 'bothSame';
  else kind = 'conflict';
  const resolution: ResolutionChoice =
    kind === 'oursOnly' ? 'ours'
    : kind === 'theirsOnly' ? 'theirs'
    : kind === 'bothSame' ? 'ours'
    : kind === 'conflict' ? 'unresolved'
    : 'base';
  return { kind, base, ours, theirs, resolution, unresolved: kind === 'conflict' };
}
