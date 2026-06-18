/**
 * Wire the side-pane gutter accept-arrows: a click on a region's glyph in the
 * Local/Incoming gutter pushes that side into the Result. Hit-tested via
 * MouseTargetType.GUTTER_GLYPH_MARGIN against the region's first line.
 */

import * as monaco from 'monaco-editor';
import { sideLineToRegion, type Side } from './merge-decorations.js';
import type { MergeRegion } from './model/types.js';
import type { ThreePaneHandles } from './three-pane-models.js';

export function wireGutter(
  handles: ThreePaneHandles,
  regions: MergeRegion[],
  accept: (id: string, side: Side) => void,
): { dispose(): void } {
  const maps: Record<Side, Map<number, string>> = {
    ours: sideLineToRegion(regions, 'ours'),
    theirs: sideLineToRegion(regions, 'theirs'),
  };
  const sub = (pane: Side) =>
    handles[pane].editor.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const id = e.target.position && maps[pane].get(e.target.position.lineNumber);
      if (id) accept(id, pane);
    });
  const subs: monaco.IDisposable[] = [sub('ours'), sub('theirs')];
  return {
    dispose() {
      for (const s of subs) s.dispose();
    },
  };
}
