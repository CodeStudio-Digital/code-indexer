/**
 * Per-pane selection store (IntelliJ model): plain click selects, Ctrl/Cmd
 * toggles, Shift ranges over the VISIBLE row order. A FACTORY — each pane gets
 * its own independent store, so selecting in the local pane never touches the
 * remote pane (and neither touches the editor's global file-tree selection,
 * which is a separate singleton in `state/file-tree-selection.ts`).
 *
 * Each row subscribes to just its own bit (`selected.has(path)`) so only the
 * rows entering/leaving the selection re-render.
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand';

export interface PaneSelectionState {
  selected: Set<string>;
  /** Shift-range origin (anchored on the last plain click / toggle). */
  anchor: string | null;
  /** Cursor — range end / keyboard lead row. */
  lead: string | null;
  /** Bumped on every mutation (for consumers that react to any change). */
  version: number;

  /** Plain click: selection becomes {path}. */
  setSingle: (path: string) => void;
  /** Ctrl/Cmd+click: toggle `path`. */
  toggle: (path: string) => void;
  /** Shift+click: contiguous `anchor`..`path` over `order`. */
  selectRange: (path: string, order: string[]) => void;
  /** Ctrl/Cmd+A: everything in the visible order. */
  selectAll: (order: string[]) => void;
  /** Move the cursor WITHOUT changing the selection (Ctrl+Arrow). */
  setLead: (path: string) => void;
  clear: () => void;
  /** Drop `removed` + descendants (`path/…`) from the selection (after delete/refresh). */
  prune: (removed: string[]) => void;
}

export type PaneSelectionStore = UseBoundStore<StoreApi<PaneSelectionState>>;

export function createPaneSelection(): PaneSelectionStore {
  return create<PaneSelectionState>((set) => ({
    selected: new Set(),
    anchor: null,
    lead: null,
    version: 0,

    setSingle: (path) =>
      set((s) => ({ selected: new Set([path]), anchor: path, lead: path, version: s.version + 1 })),

    toggle: (path) =>
      set((s) => {
        const next = new Set(s.selected);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return { selected: next, anchor: path, lead: path, version: s.version + 1 };
      }),

    selectRange: (path, order) =>
      set((s) => {
        const a = s.anchor ?? s.lead ?? path;
        const i = order.indexOf(a);
        const j = order.indexOf(path);
        // Anchor fell out of the current order (navigated/filtered) → plain select.
        if (i < 0 || j < 0) return { selected: new Set([path]), anchor: path, lead: path, version: s.version + 1 };
        const [lo, hi] = i <= j ? [i, j] : [j, i];
        return { selected: new Set(order.slice(lo, hi + 1)), lead: path, version: s.version + 1 };
      }),

    selectAll: (order) =>
      set((s) => ({ selected: new Set(order), lead: order[order.length - 1] ?? null, version: s.version + 1 })),

    // Anchor moves with the lead so a following Shift+Arrow ranges from where
    // the cursor actually is, not from the last click.
    setLead: (path) => set((s) => ({ lead: path, anchor: path, version: s.version + 1 })),

    clear: () =>
      set((s) =>
        s.selected.size === 0 && !s.anchor && !s.lead
          ? {}
          : { selected: new Set(), anchor: null, lead: null, version: s.version + 1 },
      ),

    prune: (removed) =>
      set((s) => {
        if (s.selected.size === 0) return {};
        const next = new Set(s.selected);
        let changed = false;
        for (const r of removed) {
          for (const p of [...next]) {
            if (p === r || p.startsWith(`${r}/`)) {
              next.delete(p);
              changed = true;
            }
          }
        }
        if (!changed) return {};
        const anchor = s.anchor && next.has(s.anchor) ? s.anchor : null;
        const lead = s.lead && next.has(s.lead) ? s.lead : null;
        return { selected: next, anchor, lead, version: s.version + 1 };
      }),
  }));
}
