/**
 * Right-click menu wiring for a pane — tracks the context target, builds the
 * item list from the current selection (+ pane side), and returns the handlers
 * to open it on a row or empty space. Factored out of FilePane to keep it lean.
 */
import { useCallback, useState, type MouseEvent } from 'react';
import { useContextMenu } from '../../../components/ui/context-menu.js';
import { buildPaneMenu } from './pane-menu.js';
import { isArchive } from './zip-actions.js';
import type { FsAdapter, FsItem } from './fs-adapter.js';
import type { PaneSelectionStore } from './pane-selection.js';
import type { PaneActions } from './use-pane-actions.js';

type TFn = (key: string, opts?: Record<string, unknown>) => string;

interface Args {
  adapter: FsAdapter;
  useSel: PaneSelectionStore;
  /** Resolve the items a menu action targets (selection, or the fallback row). */
  selectedItems: (fallback?: FsItem) => FsItem[];
  actions: PaneActions;
  onOpenFile?: (item: FsItem) => void;
  refresh: () => void;
  t: TFn;
}

export function usePaneMenu(a: Args) {
  const { adapter, useSel, selectedItems, actions, onOpenFile, refresh, t } = a;
  const [ctxItem, setCtxItem] = useState<FsItem | null>(null);
  const menuSel = selectedItems(ctxItem ?? undefined);
  const single = menuSel.length === 1 ? menuSel[0] : null;

  const { triggerProps, Menu } = useContextMenu(
    buildPaneMenu({
      kind: adapter.kind,
      selCount: menuSel.length,
      onEmpty: ctxItem === null,
      singleArchive: !!single && single.type === 'file' && isArchive(single.name),
      canOpen: adapter.kind === 'remote' && !!single && single.type === 'file',
      t,
      actions: {
        transfer: () => actions.doTransfer(menuSel),
        zip: () => void actions.doZip(menuSel),
        extract: () => single && void actions.doExtract(single),
        newFolder: () => void actions.doMkdir(),
        rename: () => single && void actions.doRename(single),
        remove: () => void actions.doRemove(menuSel),
        open: () => single && onOpenFile?.(single),
        refresh,
      },
    }),
  );

  const onRowContext = useCallback(
    (e: MouseEvent, item: FsItem) => {
      e.stopPropagation();
      if (!useSel.getState().selected.has(item.path)) useSel.getState().setSingle(item.path);
      setCtxItem(item);
      triggerProps.onContextMenu(e);
    },
    [useSel, triggerProps],
  );

  const onEmptyContext = useCallback(
    (e: MouseEvent) => {
      setCtxItem(null);
      useSel.getState().clear();
      triggerProps.onContextMenu(e);
    },
    [useSel, triggerProps],
  );

  return { Menu, onRowContext, onEmptyContext };
}
