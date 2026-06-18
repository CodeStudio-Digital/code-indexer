/**
 * Guarded proportional scroll-sync across the three merge panes. Reads/writes
 * only scrollTop; a re-entrancy flag prevents the set→event→set ping-pong.
 * With view-zone alignment (merge-align) the panes are equal-height per region,
 * so raw scrollTop stays in lockstep.
 */

import type * as MonacoNs from 'monaco-editor';

export function syncScroll(editors: MonacoNs.editor.IStandaloneCodeEditor[]): { dispose(): void } {
  let syncing = false;
  const subs = editors.map((src) =>
    src.onDidScrollChange((e) => {
      if (syncing || !e.scrollTopChanged) return;
      syncing = true;
      try {
        for (const other of editors) if (other !== src) other.setScrollTop(e.scrollTop);
      } finally {
        syncing = false;
      }
    }),
  );
  return {
    dispose() {
      for (const s of subs) s.dispose();
    },
  };
}
