/**
 * Controller for the 3-way merge editor: owns resolution state, the LIVE
 * region anchors in the Result model (Monaco decorations track edits, so an
 * accept always writes at the region's current position regardless of order),
 * the per-pane decorations, gutter accept-arrow clicks, and the Result lens.
 * The editors/models themselves are owned + disposed by ThreePaneHandles.
 */

import * as monaco from 'monaco-editor';
import type { MergeModel, MergeRegion } from './model/types.js';
import { buildInitialResult, type EolHint } from './model/build-result.js';
import type { ThreePaneHandles } from './three-pane-models.js';
import { sideDecorations, resultDecorations, type Choice, type Side } from './merge-decorations.js';
import { attachMergeLens, type LensAction } from './merge-lens.js';
import { createMergeAlign } from './merge-align.js';
import { syncScroll } from './merge-sync.js';
import { wireGutter } from './merge-gutter.js';

const STICKY = monaco.editor.TrackedRangeStickiness.GrowsOnlyWhenTypingAfter;

export interface MergeLabels {
  ours: string;
  theirs: string;
  both: string;
  reject: string;
}

export interface MergeController {
  changeCount: number;
  conflictCount: number;
  unresolvedConflicts(): number;
  acceptIntoResult(id: string, side: Side): void;
  acceptBoth(id: string): void;
  revertToBase(id: string): void;
  applyNonConflicting(): void;
  acceptAll(side: Side): void;
  navigate(dir: 1 | -1): void;
  onChange(cb: () => void): () => void;
  getResult(): string;
  dispose(): void;
}

export function createMergeController(
  handles: ThreePaneHandles,
  model: MergeModel,
  eol: EolHint,
  labels: MergeLabels,
): MergeController {
  const result = handles.result;
  const rm = result.model;
  const byId = new Map(model.regions.map((r) => [r.id, r]));
  const choice = new Map<string, Choice>(model.regions.map((r) => [r.id, r.resolution as Choice]));
  const listeners = new Set<() => void>();
  let editing = false; // true while write() applies a programmatic edit

  const clamp = (l: number) => Math.min(Math.max(1, l), rm.getLineCount());
  const eolText = (lf: string) => lf.replace(/\n/g, rm.getEOL());

  // ── live anchors (one Result decoration per change region) ──
  const init = buildInitialResult(model, eol);
  const anchorId = new Map<string, string>();
  {
    const changes = init.regionResultRanges.filter((rr) => byId.get(rr.regionId)!.kind !== 'unchanged');
    const ids = rm.deltaDecorations([], changes.map((rr) => ({ range: anchorRange(rr.startLine, rr.endLine), options: { stickiness: STICKY } })));
    changes.forEach((rr, k) => anchorId.set(rr.regionId, ids[k]));
  }
  function anchorRange(startLine: number, endLine: number): monaco.IRange {
    if (endLine < startLine) {
      const l = clamp(startLine);
      return { startLineNumber: l, startColumn: 1, endLineNumber: l, endColumn: 1 };
    }
    const e = clamp(endLine);
    return { startLineNumber: clamp(startLine), startColumn: 1, endLineNumber: e, endColumn: rm.getLineMaxColumn(e) };
  }
  const liveRange = (id: string): monaco.Range | null => {
    const a = anchorId.get(id);
    return a ? rm.getDecorationRange(a) : null;
  };

  // ── decorations ──
  const oursCol = handles.ours.editor.createDecorationsCollection([]);
  const theirsCol = handles.theirs.editor.createDecorationsCollection([]);
  const resultCol = result.editor.createDecorationsCollection([]);
  const choiceOf = (id: string) => choice.get(id) ?? 'unresolved';
  const align = createMergeAlign(handles, model.regions, liveRange);
  function refresh(): void {
    oursCol.set(sideDecorations(model.regions, 'ours', choiceOf));
    theirsCol.set(sideDecorations(model.regions, 'theirs', choiceOf));
    resultCol.set(resultDecorations(model.regions, liveRange, choiceOf));
    align.update();
    lens.refresh();
    for (const cb of listeners) cb();
  }

  // ── edits (always via the live anchor; re-anchor the written region) ──
  // `targetLines` (from the chosen side's span) disambiguates 0 lines (delete)
  // from a single blank line ('' text, 1 line) — text alone can't.
  const lineCountOf = (s: { startLine: number; endLine: number }) => (s.endLine >= s.startLine ? s.endLine - s.startLine + 1 : 0);

  function write(id: string, lf: string, targetLines: number, newChoice: Choice): void {
    const a = anchorId.get(id);
    const range = a ? rm.getDecorationRange(a) : null;
    if (!a || !range) return;
    const collapsed = range.startLineNumber === range.endLineNumber && range.startColumn === 1 && range.endColumn === 1;
    // Deleting a region (0 target lines) must also consume ONE line terminator,
    // otherwise the surrounding newline survives as a phantom blank line.
    const delRange: monaco.IRange =
      targetLines === 0 && !collapsed && range.endLineNumber < rm.getLineCount()
        ? { startLineNumber: range.startLineNumber, startColumn: 1, endLineNumber: range.endLineNumber + 1, endColumn: 1 }
        : range;
    editing = true;
    rm.pushEditOperations([], [{ range: delRange, text: eolText(lf) }], () => null);
    const [newId] = rm.deltaDecorations([a], [{ range: insertedRange(range.startLineNumber, lf, targetLines), options: { stickiness: STICKY } }]);
    editing = false;
    anchorId.set(id, newId);
    choice.set(id, newChoice);
  }
  function insertedRange(startLine: number, lf: string, targetLines: number): monaco.IRange {
    if (targetLines === 0) return { startLineNumber: clamp(startLine), startColumn: 1, endLineNumber: clamp(startLine), endColumn: 1 };
    const lines = lf.split('\n');
    return { startLineNumber: startLine, startColumn: 1, endLineNumber: startLine + lines.length - 1, endColumn: lines[lines.length - 1].length + 1 };
  }
  /** Current Result text of a region (model EOL normalized to '\n' for comparison). */
  const currentRegionText = (id: string): string | null => {
    const range = liveRange(id);
    return range ? rm.getValueInRange(range).replace(/\r\n/g, '\n') : null;
  };

  const acceptIntoResult = (id: string, side: Side) => {
    const r = byId.get(id);
    if (!r) return;
    const s = side === 'ours' ? r.ours : r.theirs;
    write(id, s.text, lineCountOf(s), side);
    refresh();
  };
  const acceptBoth = (id: string) => {
    const r = byId.get(id);
    if (!r) return;
    // Include a side only when it contributes ≥1 line (so a blank-line side counts, an empty one doesn't).
    const segs: string[] = [];
    if (lineCountOf(r.ours) > 0) segs.push(r.ours.text);
    if (lineCountOf(r.theirs) > 0) segs.push(r.theirs.text);
    write(id, segs.join('\n'), lineCountOf(r.ours) + lineCountOf(r.theirs), 'both');
    refresh();
  };
  const revertToBase = (id: string) => {
    const r = byId.get(id);
    if (!r) return;
    write(id, r.base.text, lineCountOf(r.base), 'base');
    refresh();
  };

  // ── lens (Result pane) ──
  const lens = attachMergeLens(monaco, rm.uri.toString(), {
    labels,
    conflicts: () =>
      model.regions
        .filter((r) => r.kind === 'conflict')
        .map((r) => ({ id: r.id, line: liveRange(r.id)?.startLineNumber ?? 1, choice: choiceOf(r.id) })),
    run: (id, action: LensAction) => {
      if (action === 'reject') revertToBase(id);
      else if (action === 'both') acceptBoth(id);
      else acceptIntoResult(id, action);
    },
  });

  // ── gutter accept-arrow clicks ──
  const gutter = wireGutter(handles, model.regions, acceptIntoResult);
  const sync = syncScroll([handles.ours.editor, result.editor, handles.theirs.editor]);
  // Manual edits in the (editable) Result must re-paint decorations, re-align,
  // and refresh the lens; guarded so write()'s own edit doesn't double-fire.
  const contentSub = rm.onDidChangeContent(() => { if (!editing) refresh(); });

  refresh();

  const changeRegions = model.regions.filter((r) => r.kind !== 'unchanged');
  return {
    changeCount: model.changeCount,
    conflictCount: model.conflictCount,
    unresolvedConflicts: () => model.regions.filter((r) => r.kind === 'conflict' && choiceOf(r.id) === 'unresolved').length,
    acceptIntoResult,
    acceptBoth,
    revertToBase,
    applyNonConflicting() {
      // (Re)apply each non-conflicting change to its default side. Skip regions
      // whose Result text already matches the target — that keeps a fresh merge
      // a true no-op (no undo churn) and avoids clobbering an unchanged region.
      for (const r of model.regions) {
        const s = r.kind === 'oursOnly' || r.kind === 'bothSame' ? r.ours : r.kind === 'theirsOnly' ? r.theirs : null;
        if (!s) continue;
        if (currentRegionText(r.id) === s.text) continue;
        write(r.id, s.text, lineCountOf(s), r.kind === 'theirsOnly' ? 'theirs' : 'ours');
      }
      refresh();
    },
    acceptAll(side: Side) {
      for (const r of changeRegions) {
        const s = side === 'ours' ? r.ours : r.theirs;
        write(r.id, s.text, lineCountOf(s), side);
      }
      refresh();
    },
    navigate(dir) {
      const ed = result.editor;
      const cur = ed.getPosition()?.lineNumber ?? 0;
      const lines = [...new Set(changeRegions.map((r) => liveRange(r.id)?.startLineNumber).filter((n): n is number => n != null))].sort((a, b) => a - b);
      if (!lines.length) return;
      const target = dir === 1 ? lines.find((l) => l > cur) ?? lines[0] : [...lines].reverse().find((l) => l < cur) ?? lines[lines.length - 1];
      ed.revealLineInCenter(target);
      ed.setPosition({ lineNumber: target, column: 1 });
      ed.focus();
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getResult: () => rm.getValue(),
    dispose() {
      oursCol.clear();
      theirsCol.clear();
      resultCol.clear();
      align.dispose();
      sync.dispose();
      contentSub.dispose();
      lens.dispose();
      gutter.dispose();
      rm.deltaDecorations([...anchorId.values()], []);
      listeners.clear();
    },
  };
}
