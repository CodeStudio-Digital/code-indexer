/**
 * Builds the right-click menu for a pane. Items depend on the pane's side and
 * what's selected: transfer-to-other-side, zip, extract (only for a single
 * archive), open-in-editor (remote single file), rename (single), delete, new
 * folder. Empty-area right-click collapses to new-folder + refresh.
 */
import { Download, FileArchive, FolderPlus, PackageOpen, Pencil, RefreshCw, SquarePen, Trash2, Upload } from 'lucide-react';
import type { ContextMenuItem } from '../../../components/ui/context-menu.js';

type TFn = (key: string, opts?: Record<string, unknown>) => string;

export interface PaneMenuArgs {
  kind: 'local' | 'remote';
  selCount: number;
  /** Right-clicked empty space (no target row). */
  onEmpty: boolean;
  /** Exactly one archive file is selected → offer extract. */
  singleArchive: boolean;
  /** Remote single file → offer open-in-editor. */
  canOpen: boolean;
  t: TFn;
  actions: {
    transfer: () => void;
    zip: () => void;
    extract: () => void;
    newFolder: () => void;
    rename: () => void;
    remove: () => void;
    open: () => void;
    refresh: () => void;
  };
}

export function buildPaneMenu(a: PaneMenuArgs): ContextMenuItem[] {
  const { t, actions } = a;
  if (a.onEmpty || a.selCount === 0) {
    return [
      { id: 'newFolder', label: t('sftp.newFolder'), icon: FolderPlus, onSelect: actions.newFolder },
      { id: 'refresh', label: t('sftp.refresh'), icon: RefreshCw, onSelect: actions.refresh },
    ];
  }
  const items: ContextMenuItem[] = [
    {
      id: 'transfer',
      label: a.kind === 'local' ? t('files.toRemote') : t('files.toLocal'),
      icon: a.kind === 'local' ? Upload : Download,
      onSelect: actions.transfer,
    },
  ];
  if (a.canOpen) items.push({ id: 'open', label: t('sftp.edit'), icon: SquarePen, onSelect: actions.open });
  items.push({ id: 'zip', label: t('files.zip'), icon: FileArchive, onSelect: actions.zip, separatorBefore: true });
  if (a.singleArchive) items.push({ id: 'extract', label: t('files.unzip'), icon: PackageOpen, onSelect: actions.extract });
  if (a.selCount === 1) {
    items.push({ id: 'rename', label: t('sftp.rename'), icon: Pencil, onSelect: actions.rename, separatorBefore: true });
  }
  items.push({
    id: 'delete',
    label: t('sftp.delete'),
    icon: Trash2,
    destructive: true,
    onSelect: actions.remove,
    separatorBefore: a.selCount !== 1,
  });
  items.push({ id: 'newFolder', label: t('sftp.newFolder'), icon: FolderPlus, onSelect: actions.newFolder, separatorBefore: true });
  return items;
}
