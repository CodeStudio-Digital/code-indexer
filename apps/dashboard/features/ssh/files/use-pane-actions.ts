/**
 * The mutating actions for a pane (new folder / rename / delete / transfer /
 * zip / extract), factored out of FilePane to keep it lean. Each action prompts
 * / confirms / toasts and refreshes the pane; transfer and zip/extract are
 * delegated up via callbacks so the pane stays transport-agnostic.
 */
import { useCallback, useState } from 'react';
import { confirm, prompt, toast } from '../../../components/ui/prompt-dialog.js';
import type { FsAdapter, FsItem } from './fs-adapter.js';
import type { PaneSelectionStore } from './pane-selection.js';

type TFn = (key: string, opts?: Record<string, unknown>) => string;
type Kind = 'local' | 'remote';

export interface PaneActions {
  busyPath: string | null;
  doMkdir: () => Promise<void>;
  doRename: (item: FsItem) => Promise<void>;
  doRemove: (items: FsItem[]) => Promise<void>;
  doTransfer: (items: FsItem[]) => void;
  doZip: (items: FsItem[]) => Promise<void>;
  doExtract: (item: FsItem) => Promise<void>;
}

interface Args {
  adapter: FsAdapter;
  useSel: PaneSelectionStore;
  cwd: string | null;
  refresh: (dir: string) => Promise<void>;
  otherKind: Kind;
  otherCwd: string;
  onTransfer: (from: Kind, to: Kind, destDir: string, items: FsItem[]) => void;
  onZip: (cwd: string, names: string[]) => Promise<boolean> | void;
  onExtract: (cwd: string, name: string) => Promise<boolean> | void;
  t: TFn;
}

export function usePaneActions(a: Args): PaneActions {
  const { adapter, useSel, cwd, refresh, otherKind, otherCwd, onTransfer, onZip, onExtract, t } = a;
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const err = useCallback((e: unknown) => toast.error(t('sftp.actionError', { reason: e instanceof Error ? e.message : String(e) })), [t]);

  const doMkdir = useCallback(async () => {
    if (cwd == null) return;
    const name = await prompt({ title: t('sftp.newFolder'), placeholder: t('sftp.newFolderPrompt'), confirmLabel: t('sftp.newFolder'), cancelLabel: t('dialog.cancel') });
    if (!name?.trim()) return;
    try {
      await adapter.mkdir(cwd, name.trim());
      toast.success(t('sftp.folderCreated', { name: name.trim() }));
      await refresh(cwd);
    } catch (e) {
      err(e);
    }
  }, [adapter, cwd, refresh, err, t]);

  const doRename = useCallback(async (item: FsItem) => {
    if (cwd == null) return;
    const next = await prompt({ title: t('sftp.rename'), defaultValue: item.name, placeholder: t('sftp.renamePrompt'), confirmLabel: t('sftp.rename'), cancelLabel: t('dialog.cancel') });
    if (!next?.trim() || next.trim() === item.name) return;
    setBusyPath(item.path);
    try {
      await adapter.rename(item.path, adapter.join(cwd, next.trim()));
      toast.success(t('sftp.renamed', { name: next.trim() }));
      await refresh(cwd);
    } catch (e) {
      err(e);
    } finally {
      setBusyPath(null);
    }
  }, [adapter, cwd, refresh, err, t]);

  const doRemove = useCallback(async (items: FsItem[]) => {
    if (cwd == null || items.length === 0) return;
    const label = items.length === 1 ? items[0].name : t('files.nSelected', { count: items.length });
    const ok = await confirm({ title: t('sftp.delete'), description: t('sftp.deleteConfirm', { name: label }), confirmLabel: t('sftp.delete'), cancelLabel: t('dialog.cancel'), tone: 'destructive' });
    if (!ok) return;
    for (const it of items) {
      try {
        await adapter.remove(it.path, it.type === 'dir');
      } catch (e) {
        err(e);
      }
    }
    useSel.getState().prune(items.map((i) => i.path));
    await refresh(cwd);
  }, [adapter, cwd, refresh, err, t, useSel]);

  const doTransfer = useCallback((items: FsItem[]) => {
    if (items.length) onTransfer(adapter.kind, otherKind, otherCwd, items);
  }, [adapter.kind, otherKind, otherCwd, onTransfer]);

  const doZip = useCallback(async (items: FsItem[]) => {
    if (cwd == null || items.length === 0) return;
    if (await onZip(cwd, items.map((i) => i.name))) await refresh(cwd);
  }, [cwd, onZip, refresh]);

  const doExtract = useCallback(async (item: FsItem) => {
    if (cwd == null) return;
    if (await onExtract(cwd, item.name)) await refresh(cwd);
  }, [cwd, onExtract, refresh]);

  return { busyPath, doMkdir, doRename, doRemove, doTransfer, doZip, doExtract };
}
