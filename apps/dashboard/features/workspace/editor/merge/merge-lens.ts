/**
 * Result-pane CodeLens for unresolved conflicts: Accept Ours / Theirs / Both /
 * Reject. Backed by ONE app-wide command (registered once via
 * monaco.editor.registerCommand — never per-editor, so no command leak) plus a
 * single '*' CodeLens provider that dispatches by the Result model's URI. Each
 * open merge tab registers its actions under its Result URI.
 */

import type * as MonacoNs from 'monaco-editor';
import type { Choice } from './merge-decorations.js';

export type LensAction = 'ours' | 'theirs' | 'both' | 'reject';

export interface MergeLensActions {
  /** Unresolved-aware list of conflict lenses to render (live ranges). */
  conflicts(): { id: string; line: number; choice: Choice }[];
  labels: { ours: string; theirs: string; both: string; reject: string };
  run(id: string, action: LensAction): void;
}

const byUri = new Map<string, MergeLensActions>();
let registered = false;
let fire: (() => void) | null = null;

function ensure(monaco: typeof MonacoNs): void {
  if (registered) return;
  registered = true;
  const emitter = new monaco.Emitter<void>();
  fire = () => emitter.fire();
  const cmdId = 'mcp.merge.lensAction';
  monaco.editor.registerCommand(cmdId, (_acc, uri: string, id: string, action: LensAction) => {
    byUri.get(uri)?.run(id, action);
  });
  monaco.languages.registerCodeLensProvider('*', {
    onDidChange: emitter.event,
    provideCodeLenses: (model) => {
      const actions = byUri.get(model.uri.toString());
      if (!actions) return { lenses: [], dispose() { /* */ } };
      const lenses = actions.conflicts().flatMap((c) => {
        const range = new monaco.Range(c.line, 1, c.line, 1);
        const lens = (title: string, action: LensAction) => ({
          range,
          command: { id: cmdId, title, arguments: [model.uri.toString(), c.id, action] },
        });
        return [
          lens(actions.labels.ours, 'ours'),
          lens(actions.labels.theirs, 'theirs'),
          lens(actions.labels.both, 'both'),
          lens(actions.labels.reject, 'reject'),
        ];
      });
      return { lenses, dispose() { /* */ } };
    },
  });
}

export function attachMergeLens(
  monaco: typeof MonacoNs,
  resultUri: string,
  actions: MergeLensActions,
): { refresh(): void; dispose(): void } {
  ensure(monaco);
  byUri.set(resultUri, actions);
  fire?.();
  return {
    refresh: () => fire?.(),
    dispose() {
      byUri.delete(resultUri);
      fire?.();
    },
  };
}
