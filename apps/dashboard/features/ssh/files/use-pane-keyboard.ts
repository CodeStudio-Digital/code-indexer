/**
 * Wires the pure keyboard rules in `pane-keys.ts` to a pane's selection store,
 * its actions, and the virtualizer (so the cursor is always scrolled into view
 * — with virtualization an off-screen row does not exist in the DOM, so
 * `scrollIntoView` on the element is not an option).
 */
import { useCallback, useRef, type KeyboardEvent } from 'react';
import {
  isTypeaheadKey,
  paneKeyIntent,
  typeaheadMatch,
  type TypeaheadState,
} from './pane-keys.js';
import type { FsItem } from './fs-adapter.js';
import type { PaneSelectionStore } from './pane-selection.js';

interface Args {
  useSel: PaneSelectionStore;
  /** Entries in the CURRENT sorted order — index space for every intent. */
  entries: FsItem[];
  /** Paths in the same order (the range/selectAll vocabulary). */
  order: string[];
  pageSize: () => number;
  scrollToIndex: (index: number) => void;
  onOpen: (item: FsItem) => void;
  onParent: () => void;
  onRemove: (items: FsItem[]) => void;
  onRename: (item: FsItem) => void;
  onRefresh: () => void;
  /** Resolve the items an action targets (selection, else the cursor row). */
  selectedItems: (fallback?: FsItem) => FsItem[];
}

export function usePaneKeyboard(a: Args) {
  const { useSel, entries, order, pageSize, scrollToIndex, onOpen, onParent, onRemove, onRename, onRefresh, selectedItems } = a;
  const typeahead = useRef<TypeaheadState>({ buffer: '', lastKeyAtMs: 0 });

  return useCallback(
    (e: KeyboardEvent) => {
      const s = useSel.getState();
      const leadIndex = s.lead ? order.indexOf(s.lead) : -1;
      const cursor = leadIndex >= 0 ? entries[leadIndex] : undefined;

      const intent = paneKeyIntent(e, { count: entries.length, leadIndex, pageSize: pageSize() });

      // Type-ahead only when no navigation key claimed the event, so a literal
      // 'a' still types while Ctrl+A still selects all.
      if (intent.kind === 'none') {
        if (!isTypeaheadKey(e)) return;
        const { state, index } = typeaheadMatch(
          entries.map((x) => x.name),
          typeahead.current,
          e.key,
          Date.now(),
          leadIndex,
        );
        typeahead.current = state;
        if (index >= 0) {
          e.preventDefault();
          s.setSingle(order[index]);
          scrollToIndex(index);
        }
        return;
      }

      e.preventDefault();
      // Any deliberate navigation ends the current type-ahead run.
      typeahead.current = { buffer: '', lastKeyAtMs: 0 };

      switch (intent.kind) {
        case 'move': {
          const path = order[intent.index];
          if (path == null) return;
          if (intent.mode === 'range') s.selectRange(path, order);
          else if (intent.mode === 'lead') s.setLead(path);
          else s.setSingle(path);
          scrollToIndex(intent.index);
          return;
        }
        case 'selectAll':
          s.selectAll(order);
          return;
        case 'clear':
          s.clear();
          return;
        case 'open':
          if (cursor) onOpen(cursor);
          return;
        case 'parent':
          onParent();
          return;
        case 'remove': {
          const items = selectedItems(cursor);
          if (items.length > 0) onRemove(items);
          return;
        }
        case 'rename': {
          // Rename is single-target by definition; use the cursor row.
          const items = selectedItems(cursor);
          if (items.length === 1) onRename(items[0]);
          return;
        }
        case 'refresh':
          onRefresh();
          return;
        default:
          return;
      }
    },
    [useSel, entries, order, pageSize, scrollToIndex, onOpen, onParent, onRemove, onRename, onRefresh, selectedItems],
  );
}
