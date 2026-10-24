/**
 * Drag-and-drop payload helpers for cross-pane transfers. Mirrors the editor's
 * `tab-dnd` custom-MIME pattern so unrelated drags never look like a pane drag.
 * The payload carries the FULL selected items (not just paths) so the drop
 * target can plan the transfer without re-listing the source pane.
 *
 * Gotcha (same as tab-dnd): `getData()` returns "" during `dragover` in
 * Chromium — only `types` is readable — so gate hover affordances on
 * `hasPanePayload` and only `readPanePayload` inside `onDrop`.
 */
import type { DragEvent } from 'react';
import type { FsItem } from './fs-adapter.js';

const FS_MIME = 'application/x-mcp-fs';

interface PaneDragPayload {
  fromKind: 'local' | 'remote';
  items: FsItem[];
}

export function setPanePayload(e: DragEvent, payload: PaneDragPayload): void {
  e.dataTransfer.setData(FS_MIME, JSON.stringify(payload));
  e.dataTransfer.setData('text/plain', payload.items.map((i) => i.name).join('\n'));
  e.dataTransfer.effectAllowed = 'copyMove';
}

export function hasPanePayload(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes(FS_MIME);
}

export function readPanePayload(e: DragEvent): PaneDragPayload | null {
  try {
    const raw = e.dataTransfer.getData(FS_MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PaneDragPayload;
    if ((parsed?.fromKind === 'local' || parsed?.fromKind === 'remote') && Array.isArray(parsed.items)) return parsed;
    return null;
  } catch {
    return null;
  }
}
