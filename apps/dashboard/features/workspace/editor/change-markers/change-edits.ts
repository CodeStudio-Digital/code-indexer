/**
 * Model edits behind the change toolbar's actions — rollback (revert a block to
 * its HEAD baseline) and copy-original. Rollback uses `pushEditOperations` so a
 * single Ctrl+Z undoes it, and computes the range with the same "swallow the
 * next line so an empty replace doesn't leave a blank line" trick as
 * `conflict-markers.applyToModel`.
 */

import type * as MonacoNs from 'monaco-editor';
import type { Change } from './diff-to-changes.js';

interface ModelEdit {
  range: MonacoNs.Range;
  text: string;
}

function rollbackEdit(
  monaco: typeof MonacoNs,
  model: MonacoNs.editor.ITextModel,
  change: Change,
): ModelEdit {
  const lineCount = model.getLineCount();
  const text = change.baselineText;
  const hasCurrent = change.otherEnd > change.otherStart;

  if (!hasCurrent) {
    // Pure deletion: re-insert the baseline lines at the gap. Normally that's
    // the start of the line now sitting below the removed text; at EOF there's
    // no such line, so append after the last line.
    const insertLine = change.otherStart + 1;
    if (insertLine <= lineCount) {
      return { range: new monaco.Range(insertLine, 1, insertLine, 1), text: text + '\n' };
    }
    const last = lineCount;
    const col = model.getLineMaxColumn(last);
    return { range: new monaco.Range(last, col, last, col), text: '\n' + text };
  }

  // Added / modified: replace the current lines with the baseline text (empty
  // for a pure addition → the block is removed).
  const start = change.otherStart + 1;
  const endLine = change.otherEnd;
  const hasBase = change.baseEnd > change.baseStart;
  if (endLine < lineCount) {
    return { range: new monaco.Range(start, 1, endLine + 1, 1), text: hasBase ? text + '\n' : '' };
  }
  // Block reaches the last line. A pure addition (no baseline) deletes through
  // EOF, so also swallow the newline that joins it to the previous line — else
  // a blank last line is left behind. Otherwise replace the lines in place.
  if (!hasBase && start > 1) {
    const prev = start - 1;
    return {
      range: new monaco.Range(prev, model.getLineMaxColumn(prev), endLine, model.getLineMaxColumn(endLine)),
      text: '',
    };
  }
  return { range: new monaco.Range(start, 1, endLine, model.getLineMaxColumn(endLine)), text };
}

/** Revert one change block to its HEAD baseline as a single undoable edit. */
export function rollbackChange(
  monaco: typeof MonacoNs,
  model: MonacoNs.editor.ITextModel,
  change: Change,
): void {
  const { range, text } = rollbackEdit(monaco, model, change);
  model.pushEditOperations([], [{ range, text }], () => null);
}

/** Copy the block's original (HEAD) text to the clipboard. */
export function copyOriginal(change: Change): void {
  void navigator.clipboard?.writeText(change.baselineText);
}
