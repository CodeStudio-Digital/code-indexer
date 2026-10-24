/**
 * Row alignment across the three merge panes (the WebStorm/IntelliJ look).
 * Per change region, pad the shorter panes with a view-zone AFTER the region
 * so every region block occupies the same number of rows in all three panes —
 * which makes every subsequent region start on the same visual row (and lets
 * the raw-scrollTop sync stay aligned). Recomputed on each resolve, since the
 * Result region heights change as the user accepts sides.
 */

import * as monaco from 'monaco-editor';
import type { MergeRegion } from './model/types.js';
import type { ThreePaneHandles } from './three-pane-models.js';

interface MergeAlign {
  update(): void;
  dispose(): void;
}

const spacer = (lines: number): monaco.editor.IViewZone => ({
  afterLineNumber: 0,
  heightInLines: lines,
  domNode: document.createElement('div'),
});

export function createMergeAlign(
  handles: ThreePaneHandles,
  regions: MergeRegion[],
  liveResultRange: (id: string) => monaco.Range | null,
): MergeAlign {
  const zones = { ours: [] as string[], result: [] as string[], theirs: [] as string[] };

  const padPane = (
    pane: 'ours' | 'theirs' | 'result',
    pads: { after: number; lines: number }[],
  ) => {
    const editor = handles[pane].editor;
    editor.changeViewZones((acc) => {
      for (const id of zones[pane]) acc.removeZone(id);
      zones[pane] = [];
      for (const p of pads) {
        if (p.lines <= 0) continue;
        zones[pane].push(acc.addZone({ ...spacer(p.lines), afterLineNumber: p.after }));
      }
    });
  };

  const update = () => {
    const oursPads: { after: number; lines: number }[] = [];
    const theirsPads: { after: number; lines: number }[] = [];
    const resultPads: { after: number; lines: number }[] = [];
    for (const r of regions) {
      if (r.kind === 'unchanged') continue; // identical line counts → already aligned
      const live = liveResultRange(r.id);
      // An empty Result region collapses to a zero-width anchor {L,1}-{L,1}; it
      // occupies 0 rows and must pad BEFORE line L (a real ≥1-line region always
      // has endColumn > 1). Counting it as 1 row desyncs every later region.
      const resultEmpty = !live || (live.startLineNumber === live.endLineNumber && live.startColumn === 1 && live.endColumn === 1);
      const oursN = lineCount(r.ours.startLine, r.ours.endLine);
      const theirsN = lineCount(r.theirs.startLine, r.theirs.endLine);
      const resultN = live && !resultEmpty ? lineCount(live.startLineNumber, live.endLineNumber) : 0;
      const maxN = Math.max(oursN, theirsN, resultN);
      oursPads.push({ after: Math.max(0, r.ours.endLine), lines: maxN - oursN });
      theirsPads.push({ after: Math.max(0, r.theirs.endLine), lines: maxN - theirsN });
      const resultAfter = live ? (resultEmpty ? Math.max(0, live.startLineNumber - 1) : Math.max(0, live.endLineNumber)) : 0;
      resultPads.push({ after: resultAfter, lines: maxN - resultN });
    }
    padPane('ours', oursPads);
    padPane('theirs', theirsPads);
    padPane('result', resultPads);
  };

  return {
    update,
    dispose() {
      for (const pane of ['ours', 'theirs', 'result'] as const) {
        handles[pane].editor.changeViewZones((acc) => {
          for (const id of zones[pane]) acc.removeZone(id);
          zones[pane] = [];
        });
      }
    },
  };
}

/** Lines in a 1-based inclusive span; 0 when the span is empty (endLine < startLine). */
function lineCount(startLine: number, endLine: number): number {
  return endLine < startLine ? 0 : endLine - startLine + 1;
}
