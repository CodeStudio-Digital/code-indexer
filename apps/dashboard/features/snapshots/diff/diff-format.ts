/**
 * Pure formatting helpers shared by the snapshot diff renderer. Kept free of
 * React so they can be unit-tested and reused by the row-flattening hook.
 */
import type { SnapshotHunk, SnapshotHunkLine } from '../types.js';

/** Render a small unified-diff excerpt for a hunk (or a single focused line),
 *  used as the `diffExcerpt` payload when a reviewer comments on a hunk/line. */
export function hunkExcerpt(hunk: SnapshotHunk, focus?: SnapshotHunkLine): string {
  const lines = focus ? [focus] : hunk.lines.slice(0, 80);
  return [
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...lines.map((line) => {
      const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
      return `${prefix}${line.content}`;
    }),
  ].join('\n');
}

/** Gutter label: `old/new` for context, or whichever side the line belongs to. */
export function lineLabel(line: SnapshotHunkLine): string {
  if (line.oldLine != null && line.newLine != null) return `${line.oldLine}/${line.newLine}`;
  if (line.oldLine != null) return String(line.oldLine);
  if (line.newLine != null) return String(line.newLine);
  return '';
}
