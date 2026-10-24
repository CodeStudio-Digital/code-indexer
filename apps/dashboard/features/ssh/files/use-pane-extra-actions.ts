/**
 * The second half of a pane's context-menu actions — the ones the original
 * seven-item menu never offered: copy name / path / absolute path, create a new
 * empty file, and reveal a local file in the OS file manager.
 *
 * Split from `use-pane-actions.ts` rather than appended to it: that file was
 * already at the size where another handful of actions would push it past the
 * repo's per-file ceiling.
 */
import { useCallback } from 'react';
import { prompt, toast } from '../../../components/ui/prompt-dialog.js';
import type { FsAdapter, FsItem } from './fs-adapter.js';

type TFn = (key: string, opts?: Record<string, unknown>) => string;

export interface PaneExtraActions {
  copyName: (items: FsItem[]) => void;
  copyPath: (items: FsItem[]) => void;
  copyAbsPath: (items: FsItem[]) => void;
  newFile: () => Promise<void>;
  revealInExplorer: (item: FsItem) => void;
}

interface Args {
  adapter: FsAdapter;
  cwd: string | null;
  refresh: (dir: string) => Promise<void>;
  /** Create an empty file — the caller owns the transport (files.write / sftpWriteFile). */
  createFile: (dir: string, name: string) => Promise<void>;
  t: TFn;
}

/** Absolute path for display/copy — remote paths already are absolute posix. */
function absPathOf(adapter: FsAdapter, item: FsItem): string {
  if (adapter.kind === 'remote') return item.path;
  try {
    return adapter.toLocalAbs(item.path);
  } catch {
    return item.path;
  }
}

export function usePaneExtraActions(a: Args): PaneExtraActions {
  const { adapter, cwd, refresh, createFile, t } = a;

  const copy = useCallback(
    (text: string) => {
      if (!text) return;
      void navigator.clipboard
        .writeText(text)
        .then(() => toast.success(t('sftp.copied')))
        .catch(() => toast.error(t('sftp.copyFailed')));
    },
    [t],
  );

  // Multi-select copies one entry per line — matches Explorer/Finder, and
  // pastes straight into a shell or an editor.
  const copyName = useCallback((items: FsItem[]) => copy(items.map((i) => i.name).join('\n')), [copy]);
  const copyPath = useCallback((items: FsItem[]) => copy(items.map((i) => i.path).join('\n')), [copy]);
  const copyAbsPath = useCallback(
    (items: FsItem[]) => copy(items.map((i) => absPathOf(adapter, i)).join('\n')),
    [copy, adapter],
  );

  const newFile = useCallback(async () => {
    if (cwd == null) return;
    const name = await prompt({
      title: t('sftp.newFile'),
      placeholder: t('sftp.newFilePrompt'),
      confirmLabel: t('sftp.newFile'),
      cancelLabel: t('dialog.cancel'),
    });
    const trimmed = name?.trim();
    if (!trimmed) return;
    try {
      await createFile(cwd, trimmed);
      toast.success(t('sftp.fileCreated', { name: trimmed }));
      await refresh(cwd);
    } catch (e) {
      toast.error(t('sftp.actionError', { reason: e instanceof Error ? e.message : String(e) }));
    }
  }, [cwd, createFile, refresh, t]);

  const revealInExplorer = useCallback(
    (item: FsItem) => {
      const api = (globalThis as { electronAPI?: { showItemInFolder?: (p: string) => void } }).electronAPI;
      api?.showItemInFolder?.(absPathOf(adapter, item));
    },
    [adapter],
  );

  return { copyName, copyPath, copyAbsPath, newFile, revealInExplorer };
}
