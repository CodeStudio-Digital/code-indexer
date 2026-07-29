/**
 * Builds the right-click menu for a pane. Items depend on the pane's side and
 * what's selected: transfer-to-other-side, zip, extract (only for a single
 * archive), open-in-editor (remote single file), rename (single), delete, new
 * folder. Empty-area right-click collapses to new-folder + refresh.
 */
import {
  Copy,
  Download,
  FileArchive,
  FilePlus,
  FolderOpen,
  FolderPlus,
  PackageOpen,
  Pencil,
  RefreshCw,
  ShieldCheck,
  SquarePen,
  Trash2,
  Upload,
} from 'lucide-react';
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
  /** Remote single entry → offer chmod/chown (SFTP-only verbs). */
  canEditPermissions: boolean;
  t: TFn;
  actions: {
    transfer: () => void;
    zip: () => void;
    extract: () => void;
    newFolder: () => void;
    newFile: () => void;
    rename: () => void;
    remove: () => void;
    open: () => void;
    refresh: () => void;
    copyName: () => void;
    copyPath: () => void;
    copyAbsPath: () => void;
    reveal: () => void;
    permissions: () => void;
  };
}

/** Items offered when nothing is selected (or empty space was right-clicked). */
function emptyAreaMenu(a: PaneMenuArgs): ContextMenuItem[] {
  const { t, actions } = a;
  return [
    { id: 'newFolder', label: t('sftp.newFolder'), icon: FolderPlus, onSelect: actions.newFolder },
    { id: 'newFile', label: t('sftp.newFile'), icon: FilePlus, onSelect: actions.newFile },
    { id: 'refresh', label: t('sftp.refresh'), icon: RefreshCw, onSelect: actions.refresh, separatorBefore: true },
  ];
}

/** Copy submenu — name / pane path / absolute path, for one or many rows. */
function copyGroup(a: PaneMenuArgs): ContextMenuItem {
  const { t, actions } = a;
  return {
    id: 'copy',
    label: t('sftp.copy'),
    icon: Copy,
    separatorBefore: true,
    submenu: [
      { id: 'copyName', label: t('sftp.copyName'), onSelect: actions.copyName },
      { id: 'copyPath', label: t('sftp.copyPath'), onSelect: actions.copyPath },
      { id: 'copyAbsPath', label: t('sftp.copyAbsPath'), onSelect: actions.copyAbsPath },
    ],
  };
}

export function buildPaneMenu(a: PaneMenuArgs): ContextMenuItem[] {
  const { t, actions } = a;
  if (a.onEmpty || a.selCount === 0) return emptyAreaMenu(a);

  const items: ContextMenuItem[] = [
    {
      id: 'transfer',
      label: a.kind === 'local' ? t('files.toRemote') : t('files.toLocal'),
      icon: a.kind === 'local' ? Upload : Download,
      onSelect: actions.transfer,
    },
  ];
  if (a.canOpen) items.push({ id: 'open', label: t('sftp.edit'), icon: SquarePen, onSelect: actions.open });

  items.push(copyGroup(a));
  // Reveal is local-only: it hands a real on-disk path to the OS file manager.
  if (a.kind === 'local' && a.selCount === 1) {
    items.push({ id: 'reveal', label: t('sftp.reveal'), icon: FolderOpen, onSelect: actions.reveal });
  }

  items.push({ id: 'zip', label: t('files.zip'), icon: FileArchive, onSelect: actions.zip, separatorBefore: true });
  if (a.singleArchive) items.push({ id: 'extract', label: t('files.unzip'), icon: PackageOpen, onSelect: actions.extract });

  if (a.selCount === 1) {
    items.push({ id: 'rename', label: t('sftp.rename'), icon: Pencil, onSelect: actions.rename, separatorBefore: true });
  }
  // chmod/chown are SFTP verbs — there is no local equivalent worth offering on
  // Windows, where the mode bits fs.stat reports are synthetic.
  if (a.canEditPermissions) {
    items.push({ id: 'permissions', label: t('sftp.permissions'), icon: ShieldCheck, onSelect: actions.permissions });
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
  items.push({ id: 'newFile', label: t('sftp.newFile'), icon: FilePlus, onSelect: actions.newFile });
  items.push({ id: 'refresh', label: t('sftp.refresh'), icon: RefreshCw, onSelect: actions.refresh });
  return items;
}
