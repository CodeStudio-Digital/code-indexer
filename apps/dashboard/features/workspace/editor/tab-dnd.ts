/**
 * Native HTML5 drag-and-drop payload helpers for editor tabs.
 *
 * A tab drag carries its source path + source pane id so a drop target can
 * tell same-pane reorder from cross-pane move. We use a custom MIME type so
 * unrelated drags (OS files into the composer, etc.) never look like tab drags.
 *
 * Gotcha: `dataTransfer.getData()` returns "" during `dragover` in Chromium —
 * only `dataTransfer.types` is readable then. So gate hover affordances on
 * `hasTabPayload` (types check) and only `readTabPayload` inside `onDrop`.
 */
import type { DragEvent } from 'react';

export const TAB_MIME = 'application/x-mcp-tab';

export interface TabDragPayload {
  path: string;
  fromPaneId: string;
}

export function setTabPayload(e: DragEvent, payload: TabDragPayload): void {
  e.dataTransfer.setData(TAB_MIME, JSON.stringify(payload));
  // text/plain fallback — some platforms require a string type to be set.
  e.dataTransfer.setData('text/plain', payload.path);
  e.dataTransfer.effectAllowed = 'move';
}

export function hasTabPayload(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes(TAB_MIME);
}

export function readTabPayload(e: DragEvent): TabDragPayload | null {
  try {
    const raw = e.dataTransfer.getData(TAB_MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TabDragPayload;
    if (typeof parsed?.path === 'string' && typeof parsed?.fromPaneId === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}
