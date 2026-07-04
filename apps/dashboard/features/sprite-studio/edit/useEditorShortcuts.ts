/**
 * Editor keymap, attached to the EditModeView container (not window — so it
 * only fires while the editor surface has focus and never fights the rest of
 * the app). Tool letters mirror the industry standard; undo/redo drive the
 * engine directly; [ and ] step the brush size (store + engine in sync).
 *
 *   V pointer (pan) · B brush · E eraser · G fill · M move · R select-rect
 *   W wand · I eyedropper
 *   Ctrl/Cmd+Z undo · Ctrl/Cmd+Shift+Z or Ctrl+Y redo · [ / ] brush size
 *   Ctrl/Cmd+0 fit to view · Ctrl/Cmd+1 zoom 100% (mirror the toolbar buttons)
 *   Ctrl/Cmd+A select all · Esc / Ctrl/Cmd+D deselect · Delete/Backspace clear
 *   the selected pixels (undoable) · X swap fg/bg colors
 */
import { useEffect } from 'react';
import type { RefObject } from 'react';
import type { EditorEngine } from '../engine/EditorEngine.js';
import { spriteEditorActions } from '../store/editor-store.js';
import type { ToolId } from '../tools/tool-types.js';

const TOOL_KEYS: Record<string, ToolId> = {
  v: 'pointer', b: 'brush', e: 'eraser', g: 'fill', m: 'move', r: 'select-rect', w: 'select-wand', i: 'eyedropper',
};

/** True when focus is in a text field — shortcuts must yield to typing. */
function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable;
}

/**
 * Clear the selected pixels of the ACTIVE layer to transparent, committed as
 * one undoable whole-doc snapshot command. No-op (returns false) without a
 * layer or a non-empty selection. Exported for tests — pure engine surface,
 * no DOM.
 */
export function deleteSelection(engine: EditorEngine): boolean {
  const layer = engine.doc.activeLayer;
  const mask = engine.selection.data;
  if (!layer || !mask || engine.selection.isEmpty()) return false;
  const data = layer.imageData.data;
  if (mask.length * 4 !== data.length) return false; // stale mask — never scribble
  const before = engine.doc.snapshot();
  for (let p = 0; p < mask.length; p++) if (mask[p]) data[p * 4 + 3] = 0;
  engine.doc.markAllDirty(layer.id);
  engine.history.pushSnapshot(before, engine.doc.snapshot(), 'Delete selection');
  engine.invalidate();
  engine.emitSummary();
  return true;
}

export function useEditorShortcuts(
  containerRef: RefObject<HTMLElement | null>,
  engine: EditorEngine | null,
): void {
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !engine) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const store = spriteEditorActions();
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) engine.redo(); else engine.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        engine.redo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault(); // browser select-all must never win inside the editor
        engine.selection.setRect({ x: 0, y: 0, w: engine.doc.width, h: engine.doc.height }, 'replace');
        return;
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        engine.selection.clear();
        engine.invalidate();
        return;
      }
      if (mod && e.key === '0') {
        e.preventDefault();
        engine.fitToView();
        return;
      }
      if (mod && e.key === '1') {
        e.preventDefault();
        engine.zoomTo100();
        return;
      }
      if (mod) return; // leave other Ctrl/Cmd combos to the app

      if (e.key === 'Escape') {
        engine.selection.clear();
        engine.invalidate();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault(); // Backspace must never trigger browser back-nav
        deleteSelection(engine);
        return;
      }
      if (e.key === '[' || e.key === ']') {
        e.preventDefault();
        const delta = e.key === ']' ? 1 : -1;
        const size = Math.max(1, Math.min(32, store.toolOptions.size + delta));
        store.setToolOptions({ size });
        engine.setToolOptions({ size });
        return;
      }
      if (e.key.toLowerCase() === 'x') {
        e.preventDefault();
        store.swapColors(); // the EditModeView bridge pushes the swap to the engine
        return;
      }

      const tool = TOOL_KEYS[e.key.toLowerCase()];
      if (tool) {
        e.preventDefault();
        store.setActiveTool(tool);
      }
    };

    el.addEventListener('keydown', onKeyDown);
    return () => el.removeEventListener('keydown', onKeyDown);
  }, [containerRef, engine]);
}
