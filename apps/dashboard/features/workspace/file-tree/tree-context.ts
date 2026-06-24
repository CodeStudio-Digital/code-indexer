/**
 * Context-menu actions + path helpers for the file tree. Mutations rely on
 * the fs-events stream to update the tree; `onMutated` stays as a fallback
 * nudge (refresh) for hosts without a live watcher.
 */
import {
  ClipboardCopy,
  Copy,
  Edit3,
  FilePlus2,
  FolderPlus,
  FolderSymlink,
  GitBranch,
  History,
  Link2,
  Play,
  Trash2,
} from 'lucide-react';
import { apiCall } from '../../../lib/api-client.js';
import type { ContextMenuItem } from '../../../components/ui/context-menu.js';
import { confirm, prompt, toast } from '../../../components/ui/prompt-dialog.js';
import type { TreeEntry } from '../../../state/file-tree.js';
import { useLocalHistory } from '../../../state/local-history-store.js';
import { openDetached } from '../../popout/openDetached.js';
import { fileRunCommand, runnableForFile, type FileRuntime } from '../../../lib/run-target.js';
import { launchRun } from '../../../state/run-launch.js';
import {
  githubUrlFor,
  repoRelativePosix,
  toNativeAbsolute,
  toRepoRelative,
} from '../../../lib/path-ref.js';
import { buildFileGitActions } from './file-git-actions.js';
import { deleteSelection } from './delete-selection.js';

/** Display name for the "Run with <runtime>" menu label. */
const RUNTIME_LABEL: Record<FileRuntime, string> = { node: 'Node', php: 'PHP', python: 'Python' };

/** Seleção viva (count para o rótulo; getPaths lido no clique). */
export interface MenuSelection {
  count: number;
  getPaths: () => string[];
}

/**
 * Contexto do projeto para "Copy reference" + "Git" (vem do FileTreeView):
 * `projectRoot` (root_path nativo) habilita "Absolute path"; `repoRoot`
 * (posix, do git) + `isRepo` habilitam o caminho repo-relative e o submenu Git.
 */
export interface MenuContext {
  projectRoot?: string | null;
  repoRoot?: string | null;
  isRepo?: boolean;
}

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
  selection?: MenuSelection,
  ctx?: MenuContext,
): ContextMenuItem[] {
  const isDir = entry.type === 'dir';
  const parentPath = isDir ? entry.path : posixDirname(entry.path);
  const multi = (selection?.count ?? 0) > 1;

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

  // Múltiplos selecionados: o menu age sobre o conjunto inteiro.
  if (multi && selection) {
    const doCopyPaths = () => {
      void navigator.clipboard
        .writeText(selection.getPaths().join('\n'))
        .then(() => toast.info(`${selection.count} paths copied`))
        .catch(() => toast.error('Could not access clipboard'));
    };
    return [
      { id: 'copy-paths', label: `Copy paths (${selection.count})`, icon: ClipboardCopy, onSelect: doCopyPaths },
      {
        id: 'delete-selected',
        label: `Delete selected (${selection.count})`,
        icon: Trash2,
        destructive: true,
        separatorBefore: true,
        onSelect: () => void deleteSelection(projectId, selection.getPaths(), onMutated),
      },
    ];
  }

  // "Run with <runtime>" — only for files whose extension we can run.
  const run = isDir ? null : runnableForFile(entry.path);
  const runItem: ContextMenuItem[] = run
    ? [{
        id: 'run-with',
        label: `Run with ${RUNTIME_LABEL[run.runtime]}`,
        icon: Play,
        onSelect: () =>
          void launchRun({
            projectId,
            command: fileRunCommand(entry.path, run.runtime),
            label: `Run ${posixBasename(entry.path)}`,
            manager: run.manager,
          }),
      }]
    : [];

  // "Copy reference ▸" — variações de cópia (mantém o "Copy path" acima intocado).
  const projectRoot = ctx?.projectRoot ?? null;
  const repoRoot = ctx?.repoRoot ?? null;
  const copyTo = (text: string, okMsg: string) =>
    void navigator.clipboard
      .writeText(text)
      .then(() => toast.info(okMsg, { description: text }))
      .catch(() => toast.error('Could not access clipboard'));

  const copyRefChildren: ContextMenuItem[] = [
    { id: 'copy-name', label: 'File name', icon: ClipboardCopy, onSelect: () => copyTo(entry.name, 'Name copied') },
  ];
  if (projectRoot) {
    copyRefChildren.push({
      id: 'copy-abs',
      label: 'Absolute path',
      icon: ClipboardCopy,
      onSelect: () => copyTo(toNativeAbsolute(projectRoot, entry.path), 'Absolute path copied'),
    });
    const repoRel = toRepoRelative(repoRoot, projectRoot, entry.path);
    if (repoRel) {
      copyRefChildren.push({
        id: 'copy-repo-rel',
        label: 'Path from repository root',
        icon: ClipboardCopy,
        onSelect: () => copyTo(repoRel, 'Repo path copied'),
      });
    }
  }
  // GitHub URL — só arquivos; resolve o `origin` ao CLICAR (evita um git spawn por abertura).
  if (!isDir && ctx?.isRepo) {
    copyRefChildren.push({
      id: 'copy-github',
      label: 'Copy GitHub URL',
      icon: Link2,
      separatorBefore: true,
      onSelect: () =>
        void (async () => {
          try {
            const { gitRemote, defaultBranch } = await apiCall<{
              gitRemote: string | null;
              defaultBranch: string | null;
            }>('projectGit.detectRemote', { projectId });
            const relPosix = projectRoot
              ? repoRelativePosix(repoRoot, projectRoot, entry.path) ?? entry.path
              : entry.path;
            const url = gitRemote ? githubUrlFor(gitRemote, defaultBranch, relPosix) : null;
            if (!url) {
              toast.message('No GitHub remote', { description: 'origin is not a GitHub repository.' });
              return;
            }
            copyTo(url, 'GitHub URL copied');
          } catch (err) {
            toast.error('Could not resolve remote', { description: err instanceof Error ? err.message : String(err) });
          }
        })(),
    });
  }
  const copyRefItem: ContextMenuItem[] = copyRefChildren.length
    ? [{ id: 'copy-ref', label: 'Copy reference', icon: Copy, submenu: copyRefChildren }]
    : [];

  // "Git ▸" — ações por-arquivo quando o projeto é repo (arquivos e pastas).
  const gitItem: ContextMenuItem[] = ctx?.isRepo
    ? [{ id: 'git', label: 'Git', icon: GitBranch, submenu: buildFileGitActions(entry, projectId, onMutated) }]
    : [];

  // Local History só para arquivos (pastas não têm versões). Desktop: popout
  // dedicado (redimensionável); browser/dev: fallback na modal antiga via store.
  const historyItem: ContextMenuItem[] = !isDir
    ? [{
        id: 'history',
        label: 'Local History',
        icon: History,
        onSelect: () => openDetached(
          'local-history',
          { projectId: String(projectId), path: entry.path },
          () => useLocalHistory.getState().open(projectId, entry.path),
        ),
      }]
    : [];

  // "Reveal in Explorer" — abre a pasta no gerenciador do SO (Electron-only;
  // precisa do caminho absoluto, logo do projectRoot). Pasta → abre a própria;
  // arquivo → revela selecionado no pai (fallback: abre a pasta-pai).
  const electronAPI = typeof window !== 'undefined' ? window.electronAPI : undefined;
  const revealItem: ContextMenuItem[] =
    electronAPI?.openPath && projectRoot
      ? [{
          id: 'reveal',
          label: 'Reveal in Explorer',
          icon: FolderSymlink,
          onSelect: () => {
            const abs = toNativeAbsolute(projectRoot, entry.path);
            if (isDir) electronAPI.openPath!(abs);
            else if (electronAPI.showItemInFolder) electronAPI.showItemInFolder(abs);
            else electronAPI.openPath!(toNativeAbsolute(projectRoot, posixDirname(entry.path)));
          },
        }]
      : [];

  // Grupo de ações (Reveal / Local History / Run / Git) — um único separador no líder presente.
  const actionGroup: ContextMenuItem[] = [...revealItem, ...historyItem, ...runItem, ...gitItem];
  if (actionGroup.length) actionGroup[0] = { ...actionGroup[0], separatorBefore: true };

  return [
    { id: 'new-file', label: 'New file', icon: FilePlus2, onSelect: () => void promptCreate('file') },
    { id: 'new-folder', label: 'New folder', icon: FolderPlus, onSelect: () => void promptCreate('folder') },
    { id: 'rename', label: 'Rename', icon: Edit3, shortcut: 'F2', separatorBefore: true, onSelect: onStartRename },
    { id: 'copy-path', label: 'Copy path', icon: ClipboardCopy, onSelect: doCopyPath },
    ...copyRefItem,
    ...actionGroup,
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
