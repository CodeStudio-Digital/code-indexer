/**
 * Build the initial, MARKER-FREE Result text from a MergeModel: base with
 * every non-conflicting change (oursOnly / theirsOnly / bothSame) applied,
 * and each conflict seeded to OURS but flagged unresolved. Also returns the
 * 1-based line range each region occupies in the seed — the renderer anchors
 * a Monaco decoration on each so positions track live edits.
 */

import type { MergeModel, MergeRegion, RegionSide } from './types.js';

interface RegionResultRange {
  regionId: string;
  startLine: number;
  /** endLine < startLine (= startLine-1) means the region is empty in the seed. */
  endLine: number;
}

export interface EolHint {
  eol: '\n' | '\r\n';
  finalNewline: boolean;
}

interface InitialResult {
  text: string;
  regionResultRanges: RegionResultRange[];
  eol: '\n' | '\r\n';
  finalNewline: boolean;
}

/** The side whose text seeds the Result for this region. */
function chosenSide(r: MergeRegion): RegionSide {
  switch (r.kind) {
    case 'unchanged':
      return r.base;
    case 'oursOnly':
      return r.ours;
    case 'theirsOnly':
      return r.theirs;
    case 'bothSame':
      return r.ours;
    case 'conflict':
      return r.ours; // default seed; unresolved until the user picks
    default: {
      const _exhaustive: never = r.kind;
      throw new Error(`unknown region kind: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Line count from the span, NOT from text. `text === ''` is ambiguous — it is
 * BOTH a 0-line (empty) region AND a single blank line. The span disambiguates:
 * an empty region has endLine === startLine - 1.
 */
function sideLineCount(s: RegionSide): number {
  return s.endLine >= s.startLine ? s.endLine - s.startLine + 1 : 0;
}

/** Best-effort EOL + trailing-newline detection from an original source string. */
export function detectEol(s: string): EolHint {
  const crlf = (s.match(/\r\n/g) ?? []).length;
  const lf = (s.match(/\n/g) ?? []).length - crlf;
  // Monaco only models LF or CRLF (no lone-CR), but a file ending in a bare
  // '\r' still ends in a newline — detect it so the trailing newline survives.
  return { eol: crlf > lf ? '\r\n' : '\n', finalNewline: /[\r\n]$/.test(s) };
}

export function buildInitialResult(model: MergeModel, hint?: EolHint): InitialResult {
  const eol = hint?.eol ?? '\n';
  const finalNewline = hint?.finalNewline ?? true;
  const parts: string[] = [];
  const regionResultRanges: RegionResultRange[] = [];
  let cur = 1;
  for (const r of model.regions) {
    const chosen = chosenSide(r);
    const n = sideLineCount(chosen);
    regionResultRanges.push({ regionId: r.id, startLine: cur, endLine: cur + n - 1 });
    if (n > 0) parts.push(chosen.text); // push even when '' (a single blank line)
    cur += n;
  }
  let text = parts.join('\n');
  // Append the trailing newline when ANY line was emitted (parts.length), not
  // when text !== '' — a result of exactly one blank line joins to '' yet must
  // still end in '\n'. A truly empty file (no parts) stays ''.
  if (finalNewline && parts.length > 0) text += '\n';
  if (eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  return { text, regionResultRanges, eol, finalNewline };
}
