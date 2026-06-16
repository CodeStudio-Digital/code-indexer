/**
 * Conflict-marker tooling for Monaco — pure (no React), shared by the
 * inline resolver (a normal file editor whose working-tree text still
 * carries git's markers) and the 3-pane merge editor's Result pane.
 *
 *   - `parseConflictRegions` turns `<<<<<<< / |||||||? / ======= / >>>>>>>`
 *     blocks into 1-based line ranges + the two sides' text.
 *   - `attachConflictUI` paints the regions and registers per-region
 *     CodeLens actions (Accept Current / Incoming / Both) that rewrite the
 *     block with one undoable edit. Returns a disposable — the caller MUST
 *     dispose on unmount / when the file leaves conflict.
 */

import type * as MonacoNs from 'monaco-editor';

export interface ConflictRegion {
  /** 1-based line of the `<<<<<<<` marker. */
  startLine: number;
  /** 1-based line of the `=======` separator. */
  sepLine: number;
  /** 1-based line of the `>>>>>>>` marker. */
  endLine: number;
  /** 1-based line of the diff3 `|||||||` base marker, when present. */
  baseLine?: number;
  /** "Current"/ours text (between `<<<<<<<` and the base/sep marker). */
  currentText: string;
  /** "Incoming"/theirs text (between `=======` and `>>>>>>>`). */
  incomingText: string;
}

const RE_START = /^<{7}(?:\s|$)/;
const RE_BASE = /^\|{7}(?:\s|$)/;
const RE_SEP = /^={7}\s*$/;
const RE_END = /^>{7}(?:\s|$)/;

/** Cheap check used to gate decorations on a file that may have been resolved out-of-band. */
export function hasConflictMarkers(text: string): boolean {
  return RE_START.test(text) || text.includes('\n<<<<<<<');
}

export function parseConflictRegions(text: string): ConflictRegion[] {
  const lines = text.split('\n');
  const regions: ConflictRegion[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!RE_START.test(lines[i])) { i++; continue; }
    const s = i;
    let base = -1;
    let sep = -1;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (base === -1 && RE_BASE.test(lines[j])) base = j;
      else if (sep === -1 && RE_SEP.test(lines[j])) sep = j;
      else if (RE_END.test(lines[j])) { end = j; break; }
    }
    if (sep !== -1 && end !== -1) {
      const curEnd = base !== -1 ? base : sep; // exclusive (array index of marker)
      regions.push({
        startLine: s + 1,
        sepLine: sep + 1,
        endLine: end + 1,
        baseLine: base !== -1 ? base + 1 : undefined,
        currentText: lines.slice(s + 1, curEnd).join('\n'),
        incomingText: lines.slice(sep + 1, end).join('\n'),
      });
      i = end + 1;
    } else {
      i++;
    }
  }
  return regions;
}

export type ConflictSide = 'current' | 'incoming' | 'both';

export interface ConflictLabels {
  current: string;
  incoming: string;
  both: string;
}

/**
 * Replace a region (by its current `<<<<<<<` line) with the chosen side.
 * Re-parses live so the edit is correct even if earlier accepts shifted
 * lines. Exported so the 3-pane "Accept all" buttons can reuse it.
 */
export function applyResolution(
  editor: MonacoNs.editor.ICodeEditor,
  startLine: number,
  side: ConflictSide,
): void {
  const model = editor.getModel();
  if (!model) return;
  const region = parseConflictRegions(model.getValue()).find((r) => r.startLine === startLine);
  if (!region) return;
  const text =
    side === 'current' ? region.currentText
    : side === 'incoming' ? region.incomingText
    : `${region.currentText}\n${region.incomingText}`;
  const range = {
    startLineNumber: region.startLine,
    startColumn: 1,
    endLineNumber: region.endLine,
    endColumn: model.getLineMaxColumn(region.endLine),
  };
  model.pushEditOperations([], [{ range, text }], () => null);
}

export function attachConflictUI(
  editor: MonacoNs.editor.IStandaloneCodeEditor,
  monaco: typeof MonacoNs,
  labels: ConflictLabels,
): { dispose(): void } {
  const model = editor.getModel();
  if (!model) return { dispose() { /* */ } };
  const uri = model.uri.toString();
  const collection = editor.createDecorationsCollection([]);

  const refresh = () => {
    const decos: MonacoNs.editor.IModelDeltaDecoration[] = [];
    for (const r of parseConflictRegions(model.getValue())) {
      const curEnd = (r.baseLine ?? r.sepLine) - 1;
      if (curEnd >= r.startLine + 1) {
        decos.push({
          range: new monaco.Range(r.startLine + 1, 1, curEnd, 1),
          options: { isWholeLine: true, className: 'conflict-current', linesDecorationsClassName: 'conflict-current-gutter' },
        });
      }
      if (r.endLine - 1 >= r.sepLine + 1) {
        decos.push({
          range: new monaco.Range(r.sepLine + 1, 1, r.endLine - 1, 1),
          options: { isWholeLine: true, className: 'conflict-incoming', linesDecorationsClassName: 'conflict-incoming-gutter' },
        });
      }
    }
    collection.set(decos);
  };
  refresh();

  const cmdId = editor.addCommand(0, (_ctx, startLine: number, side: ConflictSide) => {
    applyResolution(editor, startLine, side);
  }) as string;

  const emitter = new monaco.Emitter<void>();
  const provider = monaco.languages.registerCodeLensProvider('*', {
    onDidChange: emitter.event,
    provideCodeLenses: (m) => {
      if (m.uri.toString() !== uri) return { lenses: [], dispose() { /* */ } };
      const lenses = parseConflictRegions(m.getValue()).flatMap((r) => {
        const range = new monaco.Range(r.startLine, 1, r.startLine, 1);
        return [
          { range, command: { id: cmdId, title: labels.current, arguments: [r.startLine, 'current'] } },
          { range, command: { id: cmdId, title: labels.incoming, arguments: [r.startLine, 'incoming'] } },
          { range, command: { id: cmdId, title: labels.both, arguments: [r.startLine, 'both'] } },
        ];
      });
      return { lenses, dispose() { /* */ } };
    },
  });

  const sub = model.onDidChangeContent(() => { refresh(); emitter.fire(); });

  return {
    dispose() {
      collection.clear();
      provider.dispose();
      sub.dispose();
      emitter.dispose();
    },
  };
}
