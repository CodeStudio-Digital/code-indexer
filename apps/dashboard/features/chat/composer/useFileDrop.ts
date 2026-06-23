import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Drag-and-drop of OS files onto a composer. Dropped `File` objects are read by
 * the existing `fileToAttachment` path (FileReader) — no Electron native-path
 * plumbing needed. Shared by the project Composer and the company MasterComposer.
 *
 * The parent element must be `position: relative` so `<DropOverlay>` can cover
 * it. Spread `dropHandlers` onto that same element.
 */

/**
 * Installed once per page: stop the browser from navigating to a file dropped
 * OUTSIDE a registered dropzone. Without this, a missed drop makes Electron
 * load the `file://` URL and blows the app away. Only file drags are cancelled,
 * so non-file DnD (e.g. the Kanban card reorder) is untouched.
 */
let globalGuardInstalled = false;
function installGlobalDropGuard(): void {
  if (globalGuardInstalled || typeof window === 'undefined') return;
  globalGuardInstalled = true;
  const prevent = (e: DragEvent) => {
    if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault();
  };
  window.addEventListener('dragover', prevent);
  window.addEventListener('drop', prevent);
}

export interface FileDropHandlers {
  onDragEnter: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}

interface UseFileDropOptions {
  onFiles: (files: FileList) => void | Promise<void>;
  disabled?: boolean;
}

function dragHasFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

export function useFileDrop({ onFiles, disabled }: UseFileDropOptions): {
  isDragging: boolean;
  dropHandlers: FileDropHandlers;
} {
  const [isDragging, setIsDragging] = useState(false);
  // dragenter/leave fire for every nested child — count depth so the overlay
  // only clears once the cursor truly leaves the dropzone.
  const depth = useRef(0);

  useEffect(() => {
    installGlobalDropGuard();
  }, []);

  // If the composer is disabled mid-drag (e.g. a run starts while a file is
  // hovering), clear the overlay so it can't get stuck visible.
  useEffect(() => {
    if (disabled) {
      depth.current = 0;
      setIsDragging(false);
    }
  }, [disabled]);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (disabled || !dragHasFiles(e)) return;
    e.preventDefault();
    depth.current += 1;
    setIsDragging(true);
  }, [disabled]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (disabled || !dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, [disabled]);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (disabled || !dragHasFiles(e)) return;
    depth.current -= 1;
    if (depth.current <= 0) {
      depth.current = 0;
      setIsDragging(false);
    }
  }, [disabled]);

  const onDrop = useCallback((e: React.DragEvent) => {
    if (disabled || !dragHasFiles(e)) return;
    e.preventDefault();
    depth.current = 0;
    setIsDragging(false);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) void onFiles(files);
  }, [disabled, onFiles]);

  return { isDragging, dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
