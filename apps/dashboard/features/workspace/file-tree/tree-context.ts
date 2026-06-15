/**
 * Context-menu actions + path helpers for the file tree. Mutations rely on
 * the fs-events stream to update the tree; `onMutated` stays as a fallback
 * nudge (refresh) for hosts without a live watcher.
 */
import {
  ClipboardCopy,
  Edit3,
  FilePlus2,
  FolderPlus,
  Trash2,
} from 'lucide-react';
import { apiCall } from '../../../lib/api-client.js';
import type { ContextMenuItem } from '../../../components/ui/context-menu.js';
import { confirm, prompt, toast } from '../../../components/ui/prompt-dialog.js';
import type { TreeEntry } from '../../../state/file-tree.js';

export function posixBasename(p: string): string {
  const ix = p.lastIndexOf('/');
  return ix < 0 ? p : p.slice(ix + 1);
}
export function posixDirname(p: string): string {
  const ix = p.lastIndexOf('/');
  return ix <= 0 ? '' : p.slice(0, ix);
}
export function posixJoin(a: string, b: string): string {
  if (!a) return b;
  return a.endsWith('/') ? a + b : `${a}/${b}`;
}

export async function commitRename(
  projectId: number,
  fromPath: string,
  newName: string,
): Promise<boolean> {
  const trimmed = newName.trim();
  if (!trimmed || trimmed === posixBasename(fromPath)) return false;
  const toPath = posixJoin(posixDirname(fromPath), trimmed);
  try {
    await apiCall<{ ok: true }>('files.rename', { projectId, from: fromPath, to: toPath });
    return true;
  } catch (err) {
    toast.error('Rename failed', { description: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

export function buildContextItems(
  entry: TreeEntry,
  projectId: number,
  onMutated: () => void,
  onStartRename: () => void,
): ContextMenuItem[] {
  const isDir = entry.type === 'dir';
  const parentPath = isDir ? entry.path : posixDirname(entry.path);

  const promptCreate = async (kind: 'file' | 'folder') => {
    const name = await prompt({
      title: `New ${kind}`,
      description: parentPath ? `Inside ${parentPath}/` : 'At project root',
      placeholder: kind === 'file' ? 'name.ts' : 'folder-name',
      confirmLabel: 'Create',
    });
    if (!name) return;
    const target = posixJoin(parentPath, name);
    try {
      if (kind === 'file') {
        await apiCall<{ ok: true }>('files.write', { projectId, path: target, content: '' });
      } else {
        await apiCall<{ ok: true }>('files.mkdir', { projectId, path: target });
      }
      onMutated();
      toast.success(`${kind === 'file' ? 'File' : 'Folder'} created`, { description: target });
    } catch (err) {
      toast.error('Create failed', { description: err instanceof Error ? err.message : String(err) });
    }
  };

  const doDelete = async () => {
    const ok = await confirm({
      title: `Delete ${isDir ? 'folder' : 'file'}?`,
      description: `"${entry.path}" will be removed${isDir ? ' (and everything inside)' : ''}. This cannot be undone.`,
      confirmLabel: 'Delete',
      tone: 'destructive',
    });
    if (!ok) return;
    try {
      await apiCall<{ ok: true }>('files.delete', { projectId, path: entry.path, recursive: isDir });
      onMutated();
      toast.success('Deleted', { description: entry.path });
    } catch (err) {
      toast.error('Delete failed', { description: err instanceof Error ? err.message : String(err) });
    }
  };

  const doCopyPath = () => {
    void navigator.clipboard
      .writeText(entry.path)
      .then(() => toast.info('Path copied', { description: entry.path }))
      .catch(() => toast.error('Could not access clipboard'));
  };

  return [
    { id: 'new-file', label: 'New file', icon: FilePlus2, onSelect: () => void promptCreate('file') },
    { id: 'new-folder', label: 'New folder', icon: FolderPlus, onSelect: () => void promptCreate('folder') },
    { id: 'rename', label: 'Rename', icon: Edit3, shortcut: 'F2', separatorBefore: true, onSelect: onStartRename },
    { id: 'copy-path', label: 'Copy path', icon: ClipboardCopy, onSelect: doCopyPath },
    { id: 'delete', label: 'Delete', icon: Trash2, destructive: true, separatorBefore: true, onSelect: () => void doDelete() },
  ];
}

// ─── Git status coloring ────────────────────────────────────────────

export type GitFileStatus =
  | 'modified' | 'added' | 'deleted' | 'renamed'
  | 'copied' | 'untracked' | 'ignored' | 'unmerged';

const SEVERITY: Record<GitFileStatus, number> = {
  unmerged: 6, deleted: 5, renamed: 4, modified: 3,
  added: 2, untracked: 2, copied: 1, ignored: 0,
};

export function colorForStatus(status: GitFileStatus | undefined): { text: string; extra?: string } {
  switch (status) {
    case 'modified': return { text: 'text-amber-400' };
    case 'added':
    case 'untracked': return { text: 'text-emerald-400' };
    case 'deleted': return { text: 'text-destructive', extra: 'line-through' };
    case 'renamed':
    case 'copied': return { text: 'text-cyan-400' };
    case 'unmerged': return { text: 'text-red-500' };
    default: return { text: '' };
  }
}

/**
 * Per-dir "most severe descendant" map, built ONCE per status snapshot
 * (the lazy tree can't walk unloaded children — prefixes can).
 */
export function buildDirSeverity(statusMap: Map<string, GitFileStatus>): Map<string, GitFileStatus> {
  const dirs = new Map<string, GitFileStatus>();
  for (const [path, status] of statusMap) {
    let dir = posixDirname(path);
    while (dir) {
      const prev = dirs.get(dir);
      if (!prev || SEVERITY[status] > SEVERITY[prev]) dirs.set(dir, status);
      dir = posixDirname(dir);
    }
  }
  return dirs;
}
