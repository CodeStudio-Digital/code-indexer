/**
 * Undo/redo command application — History pops commands, this applies their
 * `before` (undo) or `after` (redo) side onto the document/selection and
 * marks the touched tiles dirty for the compositor.
 */
import type { EditorDocument } from './document.js';
import type { Command } from './history.js';
import type { SelectionMask } from './selection-mask.js';
import { TILE } from './tile-diff.js';
import { applyTiles } from './tile-diff.js';

export function applyHistoryCommand(
  cmd: Command,
  side: 'before' | 'after',
  doc: EditorDocument,
  selection: SelectionMask,
): void {
  if (cmd.kind === 'tiles') {
    const layer = doc.getLayer(cmd.layerId);
    if (!layer) return;
    const tiles = side === 'before' ? cmd.before : cmd.after;
    applyTiles(layer.imageData, tiles);
    for (const t of tiles) {
      doc.markDirty({ x: t.tx * TILE, y: t.ty * TILE, w: t.w, h: t.h }, cmd.layerId);
    }
  } else if (cmd.kind === 'snapshot') {
    doc.restore(side === 'before' ? cmd.before : cmd.after);
  } else {
    selection.restore(side === 'before' ? cmd.before : cmd.after);
  }
}
