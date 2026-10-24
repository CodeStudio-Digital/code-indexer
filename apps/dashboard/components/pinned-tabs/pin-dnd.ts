/**
 * Native HTML5 drag payload for pinned tabs — mirrors the editor's
 * `features/workspace/editor/tab-dnd.ts`. A custom MIME keeps unrelated drags
 * (files, editor tabs) from looking like pin drags. Gotcha: `getData()` is ""
 * during `dragover` in Chromium, so gate hover affordances on `hasPinPayload`
 * (types check) and only `readPinPayload` inside `onDrop`.
 */
import type { DragEvent } from 'react';

const PIN_MIME = 'application/x-mcp-pin';

interface PinDragPayload {
  id: string;
}

export function setPinPayload(e: DragEvent, payload: PinDragPayload): void {
  e.dataTransfer.setData(PIN_MIME, JSON.stringify(payload));
  e.dataTransfer.setData('text/plain', payload.id);
  e.dataTransfer.effectAllowed = 'move';
}

export function hasPinPayload(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes(PIN_MIME);
}

export function readPinPayload(e: DragEvent): PinDragPayload | null {
  try {
    const raw = e.dataTransfer.getData(PIN_MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PinDragPayload;
    return typeof parsed?.id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}
