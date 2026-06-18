/**
 * Decoration builders for the 3-way merge editor (pure given the regions +
 * current resolution state). Side panes highlight what each side changed
 * (blue=ours, green=theirs, amber=conflict, dim=bothSame) with a gutter
 * accept-arrow on the first line; the Result highlights unresolved conflicts
 * (amber) vs accepted ones (quiet confirm).
 */

import * as monaco from 'monaco-editor';
import type { MergeRegion } from './model/types.js';

export type Choice = 'unresolved' | 'ours' | 'theirs' | 'both' | 'base';
export type Side = 'ours' | 'theirs';

function wholeLine(startLine: number, endLine: number, className: string): monaco.editor.IModelDeltaDecoration {
  return { range: new monaco.Range(startLine, 1, endLine, 1), options: { isWholeLine: true, className } };
}

function gutter(line: number, glyphMarginClassName: string): monaco.editor.IModelDeltaDecoration {
  return { range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName } };
}

/** Decorations for one side pane (read-only). `line→region` for the gutter map is built by the caller. */
export function sideDecorations(
  regions: MergeRegion[],
  side: Side,
  choiceOf: (id: string) => Choice,
): monaco.editor.IModelDeltaDecoration[] {
  const out: monaco.editor.IModelDeltaDecoration[] = [];
  for (const r of regions) {
    if (r.kind === 'unchanged') continue;
    const span = side === 'ours' ? r.ours : r.theirs;
    if (span.endLine < span.startLine) continue; // empty on this side
    if (span.text === r.base.text) continue; // this side didn't change here
    const choice = choiceOf(r.id);
    const fadedOut = r.kind === 'conflict' && choice !== 'unresolved' && choice !== side && choice !== 'both';
    const cls = fadedOut
      ? 'merge-resolved'
      : r.kind === 'conflict'
        ? 'merge-conflict'
        : r.kind === 'bothSame'
          ? 'merge-both'
          : side === 'ours'
            ? 'merge-ours'
            : 'merge-theirs';
    out.push(wholeLine(span.startLine, span.endLine, cls));
    out.push(gutter(span.startLine, side === 'ours' ? 'merge-arrow-right' : 'merge-arrow-left'));
  }
  return out;
}

/** Decorations for the Result pane, positioned at each conflict's LIVE range. */
export function resultDecorations(
  regions: MergeRegion[],
  liveRange: (id: string) => monaco.Range | null,
  choiceOf: (id: string) => Choice,
): monaco.editor.IModelDeltaDecoration[] {
  const out: monaco.editor.IModelDeltaDecoration[] = [];
  for (const r of regions) {
    if (r.kind !== 'conflict') continue;
    const range = liveRange(r.id);
    if (!range) continue;
    // Resolved-to-empty regions collapse to a zero-width {L,1}-{L,1} anchor; a
    // whole-line highlight there would mis-color the NEXT region's line L.
    if (range.startLineNumber === range.endLineNumber && range.startColumn === 1 && range.endColumn === 1) continue;
    const cls = choiceOf(r.id) === 'unresolved' ? 'merge-conflict' : 'merge-accepted';
    out.push({ range, options: { isWholeLine: true, className: cls } });
  }
  return out;
}

/** Map each side region's first line → region id, for gutter-click hit-testing. */
export function sideLineToRegion(regions: MergeRegion[], side: Side): Map<number, string> {
  const map = new Map<number, string>();
  for (const r of regions) {
    if (r.kind === 'unchanged') continue;
    const span = side === 'ours' ? r.ours : r.theirs;
    if (span.endLine < span.startLine || span.text === r.base.text) continue;
    map.set(span.startLine, r.id);
  }
  return map;
}
