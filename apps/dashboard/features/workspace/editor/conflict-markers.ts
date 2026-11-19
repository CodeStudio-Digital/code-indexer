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
  let start = -1;
  let base = -1;
  let sep = -1;
  for (let line = 0; line < lines.length; line++) {
    const text = lines[line];
    if (start === -1) {
      if (RE_START.test(text)) start = line;
      continue;
    }
    if (base === -1 && RE_BASE.test(text)) base = line;
    else if (sep === -1 && RE_SEP.test(text)) sep = line;
    else if (RE_END.test(text)) {
      if (sep !== -1) {
        const curEnd = base !== -1 ? base : sep; // exclusive (array index of marker)
        regions.push({
          startLine: start + 1,
          sepLine: sep + 1,
          endLine: line + 1,
          baseLine: base !== -1 ? base + 1 : undefined,
          currentText: lines.slice(start + 1, curEnd).join('\n'),
          incomingText: lines.slice(sep + 1, line).join('\n'),
        });
      }
      start = base = sep = -1;
    }
  }
  return regions;
}

type ConflictSide = 'current' | 'incoming' | 'both';
const REFRESH_DELAY_MS = 100;

interface ConflictSnapshot {
  id: number;
  version: number;
  regions: ConflictRegion[];
}

const snapshots = new WeakMap<MonacoNs.editor.ITextModel, ConflictSnapshot>();
let nextSnapshotId = 0;

function snapshotOf(model: MonacoNs.editor.ITextModel): ConflictSnapshot {
  const version = model.getVersionId();
  const cached = snapshots.get(model);
  if (cached?.version === version) return cached;
  const snapshot = { id: ++nextSnapshotId, version, regions: parseConflictRegions(model.getValue()) };
  snapshots.set(model, snapshot);
  return snapshot;
}

interface ConflictLabels {
  current: string;
  incoming: string;
  both: string;
}

/**
 * The replacement text for resolving a region to a side. The 'both' case
 * joins only the NON-empty sides so an empty side never injects a blank
 * line (and both-empty yields '' rather than a lone '\n').
 */
export function computeResolutionText(region: ConflictRegion, side: ConflictSide): string {
  if (side === 'current') return region.currentText;
  if (side === 'incoming') return region.incomingText;
  return [region.currentText, region.incomingText].filter((s) => s.length > 0).join('\n');
}

/**
 * Apply a resolution to a model in one undoable edit, rejecting stale lenses
 * if earlier edits shifted lines. When the chosen
 * side is empty, the range extends through the START of the next line so the
 * whole block is removed instead of collapsing into a stray blank line
 * (unless the block is the last line in the file, where there's nothing to
 * swallow into).
 */
function applyToModel(
  model: MonacoNs.editor.ITextModel,
  region: ConflictRegion,
  side: ConflictSide,
): void {
  const text = computeResolutionText(region, side);
  const range =
    text === '' && region.endLine < model.getLineCount()
      ? { startLineNumber: region.startLine, startColumn: 1, endLineNumber: region.endLine + 1, endColumn: 1 }
      : {
          startLineNumber: region.startLine,
          startColumn: 1,
          endLineNumber: region.endLine,
          endColumn: model.getLineMaxColumn(region.endLine),
        };
  model.pushEditOperations([], [{ range, text }], () => null);
}

// A SINGLE app-wide command backs every CodeLens (registered once, never
// per-editor). `editor.addCommand` discards its disposable and registers
// into the process-wide CommandsRegistry that the editor's dispose() does
// NOT clean up — so a fresh editor per merge tab would leak a command (and
// pin the disposed editor via the handler closure). A module-level command
// that resolves the target model by URI from its arguments avoids that.
let applyCommandId: string | null = null;
function ensureApplyCommand(monaco: typeof MonacoNs): string {
  if (applyCommandId) return applyCommandId;
  const id = 'mcp.conflict.applyResolution';
  monaco.editor.registerCommand(id, (_accessor, uriStr: string, snapshotId: number, startLine: number, side: ConflictSide) => {
    const model = monaco.editor.getModel(monaco.Uri.parse(uriStr));
    if (!model || model.isDisposed()) return;
    const snapshot = snapshots.get(model);
    if (snapshot?.id !== snapshotId || snapshot.version !== model.getVersionId()) return;
    const region = snapshot.regions.find((r) => r.startLine === startLine);
    if (region) applyToModel(model, region, side);
  });
  applyCommandId = id;
  return id;
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

  const renderRegions = (regions: ConflictRegion[]) => {
    const decos: MonacoNs.editor.IModelDeltaDecoration[] = [];
    for (const r of regions) {
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
  const cmdId = ensureApplyCommand(monaco);

  const emitter = new monaco.Emitter<MonacoNs.languages.CodeLensProvider>();
  const lensProvider: MonacoNs.languages.CodeLensProvider = {
    onDidChange: emitter.event,
    provideCodeLenses: (m) => {
      const snapshot = m === model ? snapshots.get(model) : undefined;
      if (!snapshot || snapshot.version !== m.getVersionId()) return { lenses: [], dispose() { /* */ } };
      const lenses = snapshot.regions.flatMap((r) => {
        const range = new monaco.Range(r.startLine, 1, r.startLine, 1);
        const args = [uri, snapshot.id, r.startLine];
        return [
          { range, command: { id: cmdId, title: labels.current, arguments: [...args, 'current'] } },
          { range, command: { id: cmdId, title: labels.incoming, arguments: [...args, 'incoming'] } },
          { range, command: { id: cmdId, title: labels.both, arguments: [...args, 'both'] } },
        ];
      });
      return { lenses, dispose() { /* */ } };
    },
  };
  const provider = monaco.languages.registerCodeLensProvider('*', lensProvider);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = (): void => {
    timer = undefined;
    if (model.isDisposed() || editor.getModel() !== model) return;
    renderRegions(snapshotOf(model).regions);
    emitter.fire(lensProvider);
  };
  const schedule = (): void => {
    clearTimeout(timer);
    timer = setTimeout(refresh, REFRESH_DELAY_MS);
  };
  schedule();
  const sub = model.onDidChangeContent(schedule);

  return {
    dispose() {
      clearTimeout(timer);
      collection.clear();
      provider.dispose();
      sub.dispose();
      emitter.dispose();
    },
  };
}
