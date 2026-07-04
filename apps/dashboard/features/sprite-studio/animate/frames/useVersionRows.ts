/**
 * Flatten grouped versions into a virtualizer row list (collapse-aware): one
 * header row per group, then — only when expanded — one thumb row per `cols`
 * versions. Pure so the browser can memo it and feed @tanstack/react-virtual a
 * variable-height `estimateSize`.
 */
import type { AssetVersion } from '../../types.js';
import type { FrameGroupView } from '../version-groups.js';

export type FrameRow =
  | { kind: 'header'; group: FrameGroupView }
  | { kind: 'thumbs'; group: FrameGroupView; versions: AssetVersion[] };

export function buildFrameRows(
  groups: FrameGroupView[],
  collapsed: Set<string>,
  cols: number,
): FrameRow[] {
  const rows: FrameRow[] = [];
  const perRow = Math.max(1, cols);
  for (const group of groups) {
    rows.push({ kind: 'header', group });
    if (collapsed.has(group.key)) continue;
    for (let i = 0; i < group.versions.length; i += perRow) {
      rows.push({ kind: 'thumbs', group, versions: group.versions.slice(i, i + perRow) });
    }
  }
  return rows;
}

/** The full display-ordered versionId list — the axis for shift-range select. */
export const orderedVersionIds = (groups: FrameGroupView[]): number[] =>
  groups.flatMap((g) => g.versions.map((v) => v.id));
