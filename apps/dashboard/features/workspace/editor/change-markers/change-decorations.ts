/**
 * Map `Change[]` to Monaco gutter decorations. Added / modified blocks paint a
 * thin whole-line bar in the lines-decorations lane (IntelliJ's green / blue);
 * a deletion has no current lines, so it gets a single-line marker (styled as
 * a triangle pointing at the gap) on the line below the removed text.
 *
 * Colours live in index.css (`.mcp-change-*`), keyed off the design tokens —
 * same convention as `.conflict-*-gutter`.
 */

import type * as MonacoNs from 'monaco-editor';
import { anchorLine, type Change } from './diff-to-changes.js';

const GUTTER_CLASS: Record<Change['kind'], string> = {
  added: 'mcp-change-added',
  modified: 'mcp-change-modified',
  deleted: 'mcp-change-deleted',
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

export function buildChangeDecorations(
  monaco: typeof MonacoNs,
  changes: Change[],
  lineCount: number,
): MonacoNs.editor.IModelDeltaDecoration[] {
  const safeCount = Math.max(1, lineCount);
  return changes.map((c) => {
    if (c.kind === 'deleted') {
      const line = anchorLine(c, safeCount);
      return {
        range: new monaco.Range(line, 1, line, 1),
        options: { linesDecorationsClassName: GUTTER_CLASS.deleted },
      };
    }
    const start = clamp(c.otherStart + 1, 1, safeCount);
    const end = clamp(c.otherEnd, start, safeCount);
    return {
      range: new monaco.Range(start, 1, end, 1),
      options: { isWholeLine: true, linesDecorationsClassName: GUTTER_CLASS[c.kind] },
    };
  });
}
