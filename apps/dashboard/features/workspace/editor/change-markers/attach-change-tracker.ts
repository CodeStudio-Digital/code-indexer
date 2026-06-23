/**
 * Wires the live change-marker decorations + click toolbar onto one
 * editor/model. Diffs the baseline (HEAD) against the live buffer, debounced
 * on every edit, keeps the gutter in sync, and opens the toolbar when a marker
 * is clicked. `setBaseline` swaps the HEAD content after a commit / checkout
 * (the React hook re-fetches and pushes it in).
 *
 * Rollback / copy / navigate are handled here (model + clipboard ops);
 * stage / commit are delegated to the caller via `deps` (they need a backend
 * round-trip + a disk flush). Returns a disposable the caller MUST invoke on
 * unmount / model swap — mirrors `conflict-markers.attachConflictUI`.
 */

import type * as MonacoNs from 'monaco-editor';
import { computeChanges, anchorLine, changeCoversLine, type Change } from './diff-to-changes.js';
import { buildChangeDecorations } from './change-decorations.js';
import { rollbackChange, copyOriginal } from './change-edits.js';
import { createChangeWidget, type ChangeWidget } from './change-widget.js';
import type { ChangeToolbarLabels } from './change-toolbar-dom.js';

const RECOMPUTE_DEBOUNCE_MS = 150;

/** 1-based line range on the working-tree (new) side, for partial staging. */
export interface StageRange {
  newStart: number;
  newEnd: number;
}

export interface ChangeTrackerDeps {
  labels: ChangeToolbarLabels;
  onStage(range: StageRange): void;
  onCommit(range: StageRange, message: string): void;
}

export interface ChangeTracker {
  setBaseline(content: string): void;
  dispose(): void;
}

/** Working-tree line span the diff that backs staging will key on. */
function stageRange(change: Change): StageRange {
  if (change.otherEnd > change.otherStart) {
    return { newStart: change.otherStart + 1, newEnd: change.otherEnd };
  }
  // Pure deletion: git's hunk is `+c,0` at the surviving line count before it.
  return { newStart: change.otherStart, newEnd: change.otherStart };
}

export function attachChangeTracker(
  editor: MonacoNs.editor.IStandaloneCodeEditor,
  monaco: typeof MonacoNs,
  initialBaseline: string,
  deps: ChangeTrackerDeps,
): ChangeTracker {
  const model = editor.getModel();
  if (!model) return { setBaseline() {}, dispose() {} };

  let baseline = initialBaseline;
  let changes: Change[] = [];
  let activeIdx = -1;
  const collection = editor.createDecorationsCollection([]);

  const recompute = (): void => {
    if (model.isDisposed()) return;
    changes = computeChanges(baseline, model.getValue());
    collection.set(buildChangeDecorations(monaco, changes, model.getLineCount()));
  };

  const openAt = (idx: number): void => {
    if (idx < 0 || idx >= changes.length) return;
    activeIdx = idx;
    const change = changes[idx];
    const line = anchorLine(change, model.getLineCount());
    editor.revealLineInCenterIfOutsideViewport(line);
    widget.show(line, change.baselineText);
  };

  const active = (): Change | undefined => changes[activeIdx];

  const widget: ChangeWidget = createChangeWidget(editor, monaco, deps.labels, {
    onPrev: () => openAt(activeIdx > 0 ? activeIdx - 1 : changes.length - 1),
    onNext: () => openAt(activeIdx < changes.length - 1 ? activeIdx + 1 : 0),
    onRollback: () => {
      const c = active();
      if (c) rollbackChange(monaco, model, c);
      widget.hide();
    },
    onCopy: () => {
      const c = active();
      if (c) copyOriginal(c);
    },
    onStage: () => {
      const c = active();
      if (c) deps.onStage(stageRange(c));
      widget.hide();
    },
    onCommit: (message) => {
      const c = active();
      if (c) deps.onCommit(stageRange(c), message);
      widget.hide();
    },
    onClose: () => widget.hide(),
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (): void => {
    if (widget.isOpen()) widget.hide(); // an edit shifts the blocks
    if (timer) clearTimeout(timer);
    timer = setTimeout(recompute, RECOMPUTE_DEBOUNCE_MS);
  };

  recompute();
  const subContent = model.onDidChangeContent(schedule);
  const subMouse = editor.onMouseDown((e) => {
    const line = e.target.position?.lineNumber;
    if (e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS && line) {
      const idx = changes.findIndex((c) => changeCoversLine(c, line, model.getLineCount()));
      if (idx >= 0) {
        openAt(idx);
        return;
      }
    }
    widget.hide(); // any other click dismisses
  });

  return {
    setBaseline(content: string) {
      baseline = content;
      recompute();
    },
    dispose() {
      if (timer) clearTimeout(timer);
      subContent.dispose();
      subMouse.dispose();
      widget.dispose();
      collection.clear();
    },
  };
}
