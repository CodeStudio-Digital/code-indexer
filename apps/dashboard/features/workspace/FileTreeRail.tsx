/**
 * Left rail of the Workspace — recursive file tree backed by
 * `files.tree({projectId})`. Click opens; right-click opens a context
 * menu with the standard IDE actions; F2 (or "Rename" from the menu)
 * enters inline rename mode on the active node.
 *
 * Folder expansion state is local. After any file mutation we bump the
 * reload key so the tree refreshes — that also drops any inline-rename
 * input that was open since the node identity changes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Edit3,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { Input } from '../../components/ui/input.js';
import { apiCall } from '../../lib/api-client.js';
import { Button } from '../../components/ui/button.js';
import { useContextMenu, type ContextMenuItem } from '../../components/ui/context-menu.js';
import { confirm, prompt, toast } from '../../components/ui/prompt-dialog.js';
import { cn } from '../../lib/utils.js';
import { fileIconFor } from '../../lib/file-icon.js';

interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileTreeNode[];
}

type GitFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'ignored'
  | 'unmerged';

/**
 * Paint the file label according to its git status. Folders inherit the
 * most "interesting" color from their children (handled by the recursive
 * walk below). Untracked + added share green; modified is amber; deleted
 * is red strikethrough; conflicts are bright red.
 */
function colorForStatus(status: GitFileStatus | undefined): { text: string; extra?: string } {
  switch (status) {
    case 'modified': return { text: 'text-amber-400' };
    case 'added': return { text: 'text-emerald-400' };
    case 'untracked': return { text: 'text-emerald-400' };
    case 'deleted': return { text: 'text-destructive', extra: 'line-through' };
    case 'renamed': return { text: 'text-cyan-400' };
    case 'copied': return { text: 'text-cyan-400' };
    case 'unmerged': return { text: 'text-red-500' };
    default: return { text: '' };
  }
}

/**
 * For folders, surface the most severe status of any descendant so the
 * user spots "something here changed" at the top level without expanding
 * every directory.
 */
function folderStatus(node: FileTreeNode, statusMap: Map<string, GitFileStatus>): GitFileStatus | undefined {
  if (node.type === 'file') return statusMap.get(node.path);
  let best: GitFileStatus | undefined;
  const severity: Record<GitFileStatus, number> = {
    unmerged: 6,
    deleted: 5,
    renamed: 4,
    modified: 3,
    added: 2,
    untracked: 2,
    copied: 1,
    ignored: 0,
  };
  for (const child of node.children ?? []) {
    const s = folderStatus(child, statusMap);
    if (s && (!best || severity[s] > severity[best])) best = s;
  }
  return best;
}

interface FileTreeRailProps {
  projectId: number;
  activePath: string | null;
  onOpen: (path: string) => void;
}

export function FileTreeRail({ projectId, activePath, onOpen }: FileTreeRailProps) {
  const [tree, setTree] = useState<FileTreeNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [gitStatus, setGitStatus] = useState<Map<string, GitFileStatus>>(() => new Map());
  const [search, setSearch] = useState('');

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const startRename = useCallback((path: string) => setRenamingPath(path), []);
  const cancelRename = useCallback(() => setRenamingPath(null), []);

  const commitRename = useCallback(
    async (fromPath: string, newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed || trimmed === posixBasename(fromPath)) {
        setRenamingPath(null);
        return;
      }
      const toPath = posixJoin(posixDirname(fromPath), trimmed);
      try {
        await apiCall<{ ok: true }>('files.rename', { projectId, from: fromPath, to: toPath });
      } catch (err) {
        toast.error('Rename failed', {
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setRenamingPath(null);
        reload();
      }
    },
    [projectId, reload],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiCall<FileTreeNode>('files.tree', { projectId, root: '.', maxDepth: 6 })
      .then((root) => {
        if (cancelled) return;
        setTree(root);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, reloadKey]);

  // Poll git status every 7s so file rows wear the modified/added/deleted
  // color without forcing the user to open the Git tool window. Best-
  // effort — if the project isn't a repo we just paint nothing.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const status = await apiCall<{
          files: Array<{ path: string; state: GitFileStatus; staged: boolean }>;
          notARepo: boolean;
        }>('projectGit.status', { projectId });
        if (cancelled) return;
        if (status.notARepo) {
          setGitStatus(new Map());
        } else {
          // Prefer the working-tree (unstaged) state when both exist —
          // the user cares more about "I changed this file" than "I
          // already added it". Folders bubble up to the most severe
          // child color so the project tree is scannable.
          const map = new Map<string, GitFileStatus>();
          for (const f of status.files) {
            const existing = map.get(f.path);
            if (!existing || (existing === 'unmerged' ? false : true)) {
              if (!f.staged || !existing) map.set(f.path, f.state);
            }
          }
          setGitStatus(map);
        }
      } catch {
        if (cancelled) return;
        setGitStatus(new Map());
      }
      if (!cancelled) timer = setTimeout(tick, 7_000);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [projectId, reloadKey]);

  // F2 = rename the currently-active file. JetBrains / VS Code convention.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F2') return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      if (!activePath) return;
      e.preventDefault();
      setRenamingPath(activePath);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activePath]);

  // Pre-compute the set of folder paths that contain a search match so
  // the recursive renderer knows which folders to keep expanded. Pure
  // function of (tree, search) — cheap to memoize once per change.
  const filterMatches = useMemo(() => {
    if (!tree || !search.trim()) return null;
    const q = search.trim().toLowerCase();
    const visibleFolders = new Set<string>();
    const visibleFiles = new Set<string>();
    const visit = (n: FileTreeNode): boolean => {
      if (n.type === 'file') {
        if (n.name.toLowerCase().includes(q)) {
          visibleFiles.add(n.path);
          return true;
        }
        return false;
      }
      let anyHit = false;
      for (const child of n.children ?? []) {
        if (visit(child)) anyHit = true;
      }
      if (anyHit) visibleFolders.add(n.path);
      return anyHit;
    };
    visit(tree);
    return { visibleFolders, visibleFiles };
  }, [tree, search]);

  return (
    <div className="h-full flex flex-col bg-card/30 min-h-0">
      <div className="h-8 shrink-0 border-b flex items-center justify-between px-2.5 gap-1">
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.08em]">
          Explorer
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 text-muted-foreground hover:text-foreground"
          onClick={reload}
          aria-label="Reload file tree"
        >
          <RefreshCw className="h-3 w-3" />
        </Button>
      </div>
      <div className="shrink-0 border-b px-1.5 py-1">
        <div className="relative">
          <Search className="h-3 w-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/70 pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter files…"
            className="h-6 text-[11px] pl-7 pr-6"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 h-4 w-4 grid place-items-center text-muted-foreground/70 hover:text-foreground"
              aria-label="Clear filter"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto py-1 px-0.5">
        {loading && <div className="text-[11px] text-muted-foreground px-3 py-2">Loading…</div>}
        {error && <div className="text-[11px] text-destructive px-3 py-2">{error}</div>}
        {tree && filterMatches && filterMatches.visibleFiles.size === 0 && (
          <div className="text-[11px] text-muted-foreground px-3 py-2">
            No files match &quot;{search}&quot;.
          </div>
        )}
        {tree && (
          <NodeView
            node={tree}
            depth={0}
            projectId={projectId}
            activePath={activePath}
            onOpen={onOpen}
            onMutated={reload}
            renamingPath={renamingPath}
            onStartRename={startRename}
            onCommitRename={commitRename}
            onCancelRename={cancelRename}
            gitStatus={gitStatus}
            filterMatches={filterMatches}
            renderSelf={false}
          />
        )}
      </div>
    </div>
  );
}

interface FilterMatches {
  visibleFolders: Set<string>;
  visibleFiles: Set<string>;
}

interface NodeViewProps {
  node: FileTreeNode;
  depth: number;
  projectId: number;
  activePath: string | null;
  onOpen: (path: string) => void;
  onMutated: () => void;
  renamingPath: string | null;
  onStartRename: (path: string) => void;
  onCommitRename: (fromPath: string, newName: string) => void;
  onCancelRename: () => void;
  gitStatus: Map<string, GitFileStatus>;
  filterMatches: FilterMatches | null;
  /** When false, only renders this node's children (used for the root). */
  renderSelf?: boolean;
}

function NodeView({
  node,
  depth,
  projectId,
  activePath,
  onOpen,
  onMutated,
  renamingPath,
  onStartRename,
  onCommitRename,
  onCancelRename,
  gitStatus,
  filterMatches,
  renderSelf = true,
}: NodeViewProps) {
  // When a filter is active, force the folder open so the user sees the
  // path to every match. Otherwise honor the user's manual expansion.
  const filterActive = filterMatches !== null;
  const folderShouldShow =
    !filterActive ||
    (node.type === 'dir' && filterMatches.visibleFolders.has(node.path)) ||
    depth === 0;
  const fileShouldShow =
    !filterActive || (node.type === 'file' && filterMatches.visibleFiles.has(node.path));
  const [expanded, setExpanded] = useState(depth === 0);
  // While filtering, all surviving folders are expanded.
  const isExpanded = filterActive ? true : expanded;
  const items = buildContextItems(node, projectId, onMutated, () => onStartRename(node.path));
  const { triggerProps, Menu } = useContextMenu(items);
  const isRenaming = renamingPath === node.path;

  // Filter pre-render shortcut: bail out before doing any work on a node
  // that's hidden by the current filter.
  if (node.type === 'file' && !fileShouldShow) return null;
  if (node.type === 'dir' && !folderShouldShow && renderSelf) return null;

  // For files: highlight + on-click opens. For dirs: toggle expand.
  if (node.type === 'file' && renderSelf) {
    const active = node.path === activePath;
    const status = gitStatus.get(node.path);
    const color = colorForStatus(status);
    // Type-aware icon (TS=blue, JS=yellow, MD=light blue, …). Git
    // status still colors the LABEL — the icon stays its type color
    // so the user can spot file kinds at a glance even when 80% of
    // the tree is the same modified-amber.
    const { Icon: TypeIcon, colorClass } = fileIconFor(node.path);
    return (
      <>
        {isRenaming ? (
          <InlineRenameInput
            initialName={node.name}
            depth={depth}
            iconColor={active ? 'text-primary' : colorClass}
            Icon={TypeIcon}
            onSubmit={(name) => onCommitRename(node.path, name)}
            onCancel={onCancelRename}
          />
        ) : (
          <button
            type="button"
            onClick={() => onOpen(node.path)}
            {...triggerProps}
            className={cn(
              'group w-full text-left flex items-center gap-1.5 px-1.5 py-[3px] rounded-sm text-[11.5px] leading-tight',
              'transition-colors',
              active
                ? 'bg-primary/10 text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
            style={{ paddingLeft: `${depth * 12 + 6}px` }}
            title={status ? `${node.path}\n(${status})` : node.path}
          >
            <TypeIcon
              className={cn(
                'h-3.5 w-3.5 shrink-0',
                colorClass,
                !active && 'opacity-90',
              )}
            />
            <span className={cn('truncate', color.text, color.extra)}>{node.name}</span>
          </button>
        )}
        {Menu}
      </>
    );
  }

  const children = useMemo(() => node.children ?? [], [node.children]);

  return (
    <div>
      {renderSelf && (
        <>
          {isRenaming ? (
            <InlineRenameInput
              initialName={node.name}
              depth={depth}
              iconColor="text-amber-500/80"
              Icon={isExpanded ? FolderOpen : Folder}
              onSubmit={(name) => onCommitRename(node.path, name)}
              onCancel={onCancelRename}
              extraLeading={<span className="w-3" />}
            />
          ) : (
            (() => {
              const dirStatus = folderStatus(node, gitStatus);
              const dirColor = colorForStatus(dirStatus);
              return (
                <button
                  type="button"
                  onClick={() => {
                    if (filterActive) return; // filter forces folders open; click is a no-op
                    setExpanded((v) => !v);
                  }}
                  {...triggerProps}
                  className="w-full text-left flex items-center gap-1 px-1.5 py-[3px] rounded-sm text-[11.5px] leading-tight text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                  style={{ paddingLeft: `${depth * 12 + 2}px` }}
                  title={dirStatus ? `${node.path}\n(contains ${dirStatus} files)` : node.path}
                >
                  {isExpanded ? (
                    <ChevronDown className="h-3 w-3 shrink-0" />
                  ) : (
                    <ChevronRight className="h-3 w-3 shrink-0" />
                  )}
                  {isExpanded ? (
                    <FolderOpen className="h-3 w-3 shrink-0 text-amber-500/80" />
                  ) : (
                    <Folder className="h-3 w-3 shrink-0 text-amber-500/80" />
                  )}
                  <span className={cn('truncate', dirColor.text)}>{node.name}</span>
                </button>
              );
            })()
          )}
          {Menu}
        </>
      )}
      {isExpanded &&
        children.map((child) => (
          <NodeView
            key={child.path}
            node={child}
            depth={renderSelf ? depth + 1 : depth}
            projectId={projectId}
            activePath={activePath}
            onOpen={onOpen}
            onMutated={onMutated}
            renamingPath={renamingPath}
            onStartRename={onStartRename}
            onCommitRename={onCommitRename}
            onCancelRename={onCancelRename}
            gitStatus={gitStatus}
            filterMatches={filterMatches}
          />
        ))}
    </div>
  );
}

interface InlineRenameInputProps {
  initialName: string;
  depth: number;
  iconColor: string;
  Icon: React.ComponentType<{ className?: string }>;
  onSubmit: (newName: string) => void;
  onCancel: () => void;
  extraLeading?: React.ReactNode;
}

function InlineRenameInput({
  initialName,
  depth,
  iconColor,
  Icon,
  onSubmit,
  onCancel,
  extraLeading,
}: InlineRenameInputProps) {
  const [value, setValue] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // Select the basename without extension so the user can rename "foo"
    // to "bar" without manually trimming ".ts".
    const dot = initialName.lastIndexOf('.');
    if (dot > 0) {
      el.setSelectionRange(0, dot);
    } else {
      el.select();
    }
  }, [initialName]);

  return (
    <div
      className="w-full flex items-center gap-1.5 px-1.5 py-[2px] text-[11.5px] leading-tight bg-card/80"
      style={{ paddingLeft: `${depth * 12 + 6}px` }}
    >
      {extraLeading}
      <Icon className={cn('h-3 w-3 shrink-0', iconColor)} />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => onSubmit(value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onSubmit(value);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
          e.stopPropagation();
        }}
        className="flex-1 min-w-0 bg-background border border-primary/60 rounded-sm px-1 py-[1px] text-[11.5px] outline-none focus:border-primary"
      />
    </div>
  );
}

/**
 * Compose the right-click menu for a file-tree node. Same chrome on
 * files and folders. Rename goes via inline input (provided by the
 * parent's `onStartRename`); create / delete go through the global
 * prompt/confirm dialog hosts since Electron blocks window.* dialogs.
 */
function buildContextItems(
  node: FileTreeNode,
  projectId: number,
  onMutated: () => void,
  onStartRename: () => void,
): ContextMenuItem[] {
  const isDir = node.type === 'dir';
  const parentPath = isDir ? node.path : posixDirname(node.path);

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
      toast.error('Create failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const doDelete = async () => {
    const ok = await confirm({
      title: `Delete ${isDir ? 'folder' : 'file'}?`,
      description: `"${node.path}" will be removed${isDir ? ' (and everything inside)' : ''}. This cannot be undone.`,
      confirmLabel: 'Delete',
      tone: 'destructive',
    });
    if (!ok) return;
    try {
      await apiCall<{ ok: true }>('files.delete', {
        projectId,
        path: node.path,
        recursive: isDir,
      });
      onMutated();
      toast.success('Deleted', { description: node.path });
    } catch (err) {
      toast.error('Delete failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const doCopyPath = () => {
    void navigator.clipboard
      .writeText(node.path)
      .then(() => toast.info('Path copied', { description: node.path }))
      .catch(() => toast.error('Could not access clipboard'));
  };

  return [
    {
      id: 'new-file',
      label: 'New file',
      icon: FilePlus2,
      onSelect: () => void promptCreate('file'),
    },
    {
      id: 'new-folder',
      label: 'New folder',
      icon: FolderPlus,
      onSelect: () => void promptCreate('folder'),
    },
    {
      id: 'rename',
      label: 'Rename',
      icon: Edit3,
      shortcut: 'F2',
      separatorBefore: true,
      onSelect: onStartRename,
    },
    {
      id: 'copy-path',
      label: 'Copy path',
      icon: ClipboardCopy,
      onSelect: doCopyPath,
    },
    {
      id: 'delete',
      label: 'Delete',
      icon: Trash2,
      destructive: true,
      separatorBefore: true,
      onSelect: () => void doDelete(),
    },
  ];
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
  if (a.endsWith('/')) return a + b;
  return `${a}/${b}`;
}
