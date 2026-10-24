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
import i18n from '../../../i18n/index.js';
import { apiCall } from '../../../lib/api-client.js';
import type { ContextMenuItem } from '../../../components/ui/context-menu.js';
import { confirm, prompt, toast } from '../../../components/ui/prompt-dialog.js';
import type { TreeEntry } from '../../../state/file-tree.js';
import { useLocalHistory } from '../../../state/local-history-store.js';
import { openDetached } from '../../popout/openDetached.js';
import { runnableForFile, type FileRuntime } from '../../../lib/run-target.js';
import { launchFileRun } from '../../../state/run-launch.js';
import {
  githubUrlFor,
  repoRelativePosix,
  toNativeAbsolute,
  toRepoRelative,
} from '../../../lib/path-ref.js';
import { buildFileGitActions } from './file-git-actions.js';
import { deleteSelection } from './delete-selection.js';

/** Display name for the "Run with <runtime>" menu label. */
const RUNTIME_LABEL: Record<FileRuntime, string> = {
  node: 'Node',
  php: 'PHP',
  python: 'Python',
  java: 'Java',
  dotnet: '.NET',
};

/** Seleção viva (count para o rótulo; getPaths lido no clique). */
interface MenuSelection {
  count: number;
  getPaths: () => string[];
}

/**
 * Contexto do projeto para "Copy reference" + "Git" (vem do FileTreeView):
 * `projectRoot` (root_path nativo) habilita "Absolute path"; `repoRoot`
 * (posix, do git) + `isRepo` habilitam o caminho repo-relative e o submenu Git.
 */
interface MenuContext {
  projectRoot?: string | null;
  repoRoot?: string | null;
  isRepo?: boolean;
}

function posixBasename(p: string): string {
  const ix = p.lastIndexOf('/');
  return ix < 0 ? p : p.slice(ix + 1);
}
function posixDirname(p: string): string {
  const ix = p.lastIndexOf('/');
  return ix <= 0 ? '' : p.slice(0, ix);
}
function posixJoin(a: string, b: string): string {
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
    toast.error(i18n.t('workspace:fileTree.renameFailed'), { description: err instanceof Error ? err.message : String(err) });
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
      title: kind === 'file' ? i18n.t('workspace:fileTree.newFile') : i18n.t('workspace:fileTree.newFolder'),
      description: parentPath
        ? i18n.t('workspace:fileTree.insideDir', { dir: parentPath })
        : i18n.t('workspace:fileTree.atRoot'),
      placeholder: kind === 'file' ? i18n.t('workspace:fileTree.filePlaceholder') : i18n.t('workspace:fileTree.folderPlaceholder'),
      confirmLabel: i18n.t('workspace:fileTree.create'),
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
      toast.success(
        kind === 'file' ? i18n.t('workspace:fileTree.fileCreated') : i18n.t('workspace:fileTree.folderCreated'),
        { description: target },
      );
    } catch (err) {
      toast.error(i18n.t('workspace:fileTree.createFailed'), { description: err instanceof Error ? err.message : String(err) });
    }
  };

  const doDelete = async () => {
    const ok = await confirm({
      title: isDir
        ? i18n.t('workspace:fileTree.deleteFolderTitle')
        : i18n.t('workspace:fileTree.deleteFileTitle'),
      description: isDir
        ? i18n.t('workspace:fileTree.deleteFolderBody', { path: entry.path })
        : i18n.t('workspace:fileTree.deleteFileBody', { path: entry.path }),
      confirmLabel: i18n.t('workspace:fileTree.delete'),
      tone: 'destructive',
    });
    if (!ok) return;
    try {
      await apiCall<{ ok: true }>('files.delete', { projectId, path: entry.path, recursive: isDir });
      onMutated();
      toast.success(i18n.t('workspace:fileTree.deleted'), { description: entry.path });
    } catch (err) {
      toast.error(i18n.t('workspace:fileTree.deleteFailed'), { description: err instanceof Error ? err.message : String(err) });
    }
  };

  const doCopyPath = () => {
    void navigator.clipboard
      .writeText(entry.path)
      .then(() => toast.info(i18n.t('workspace:fileTree.pathCopied'), { description: entry.path }))
      .catch(() => toast.error(i18n.t('workspace:fileTree.clipboardError')));
  };

  // Múltiplos selecionados: o menu age sobre o conjunto inteiro.
  if (multi && selection) {
    const doCopyPaths = () => {
      void navigator.clipboard
        .writeText(selection.getPaths().join('\n'))
        .then(() => toast.info(i18n.t('workspace:fileTree.pathsCopied', { count: selection.count })))
        .catch(() => toast.error(i18n.t('workspace:fileTree.clipboardError')));
    };
    return [
      { id: 'copy-paths', label: i18n.t('workspace:fileTree.copyPaths', { count: selection.count }), icon: ClipboardCopy, onSelect: doCopyPaths },
      {
        id: 'delete-selected',
        label: i18n.t('workspace:fileTree.deleteSelected', { count: selection.count }),
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
        label: i18n.t('workspace:fileTree.runWith', { runtime: RUNTIME_LABEL[run.runtime] }),
        icon: Play,
        onSelect: () =>
          void launchFileRun({
            projectId,
            file: entry.path,
            label: i18n.t('workspace:fileTree.runLabel', { file: posixBasename(entry.path) }),
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
      .catch(() => toast.error(i18n.t('workspace:fileTree.clipboardError')));

  const copyRefChildren: ContextMenuItem[] = [
    {
      id: 'copy-name',
      label: i18n.t('workspace:fileTree.copyFileName'),
      icon: ClipboardCopy,
      onSelect: () => copyTo(entry.name, i18n.t('workspace:fileTree.nameCopied')),
    },
  ];
  if (projectRoot) {
    copyRefChildren.push({
      id: 'copy-abs',
      label: i18n.t('workspace:fileTree.copyAbsPath'),
      icon: ClipboardCopy,
      onSelect: () => copyTo(toNativeAbsolute(projectRoot, entry.path), i18n.t('workspace:fileTree.absPathCopied')),
    });
    const repoRel = toRepoRelative(repoRoot, projectRoot, entry.path);
    if (repoRel) {
      copyRefChildren.push({
        id: 'copy-repo-rel',
        label: i18n.t('workspace:fileTree.copyRepoPath'),
        icon: ClipboardCopy,
        onSelect: () => copyTo(repoRel, i18n.t('workspace:fileTree.repoPathCopied')),
      });
    }
  }
  // GitHub URL — só arquivos; resolve o `origin` ao CLICAR (evita um git spawn por abertura).
  if (!isDir && ctx?.isRepo) {
    copyRefChildren.push({
      id: 'copy-github',
      label: i18n.t('workspace:fileTree.copyGithubUrl'),
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
              toast.info(i18n.t('workspace:fileTree.noGithubRemote'), {
                description: i18n.t('workspace:fileTree.noGithubRemoteBody'),
              });
              return;
            }
            copyTo(url, i18n.t('workspace:fileTree.githubUrlCopied'));
          } catch (err) {
            toast.error(i18n.t('workspace:fileTree.resolveRemoteFailed'), { description: err instanceof Error ? err.message : String(err) });
          }
        })(),
    });
  }
  const copyRefItem: ContextMenuItem[] = copyRefChildren.length
    ? [{ id: 'copy-ref', label: i18n.t('workspace:fileTree.copyReference'), icon: Copy, submenu: copyRefChildren }]
    : [];

  // "Git ▸" — ações por-arquivo quando o projeto é repo (arquivos e pastas).
  const gitItem: ContextMenuItem[] = ctx?.isRepo
    ? [{ id: 'git', label: i18n.t('workspace:fileTree.git'), icon: GitBranch, submenu: buildFileGitActions(entry, projectId, onMutated) }]
    : [];

  // Local History só para arquivos (pastas não têm versões). Desktop: popout
  // dedicado (redimensionável); browser/dev: fallback na modal antiga via store.
  const historyItem: ContextMenuItem[] = !isDir
    ? [{
        id: 'history',
        label: i18n.t('workspace:fileTree.localHistory'),
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
          label: i18n.t('workspace:fileTree.revealInExplorer'),
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
    { id: 'new-file', label: i18n.t('workspace:fileTree.newFile'), icon: FilePlus2, onSelect: () => void promptCreate('file') },
    { id: 'new-folder', label: i18n.t('workspace:fileTree.newFolder'), icon: FolderPlus, onSelect: () => void promptCreate('folder') },
    { id: 'rename', label: i18n.t('workspace:fileTree.rename'), icon: Edit3, shortcut: 'F2', separatorBefore: true, onSelect: onStartRename },
    { id: 'copy-path', label: i18n.t('workspace:fileTree.copyPath'), icon: ClipboardCopy, onSelect: doCopyPath },
    ...copyRefItem,
    ...actionGroup,
    { id: 'delete', label: i18n.t('workspace:fileTree.delete'), icon: Trash2, destructive: true, separatorBefore: true, onSelect: () => void doDelete() },
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
