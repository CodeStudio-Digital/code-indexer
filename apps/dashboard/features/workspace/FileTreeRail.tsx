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
  File,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { apiCall } from '../../lib/api-client.js';
import { Button } from '../../components/ui/button.js';
import { useContextMenu, type ContextMenuItem } from '../../components/ui/context-menu.js';
import { cn } from '../../lib/utils.js';

interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileTreeNode[];
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
        window.alert(`Rename failed: ${err instanceof Error ? err.message : String(err)}`);
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
      <div className="flex-1 min-h-0 overflow-y-auto py-1 px-0.5">
        {loading && <div className="text-[11px] text-muted-foreground px-3 py-2">Loading…</div>}
        {error && <div className="text-[11px] text-destructive px-3 py-2">{error}</div>}
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
            renderSelf={false}
          />
        )}
      </div>
    </div>
  );
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
  renderSelf = true,
}: NodeViewProps) {
  const [expanded, setExpanded] = useState(depth === 0);
  const items = buildContextItems(node, projectId, onMutated, () => onStartRename(node.path));
  const { triggerProps, Menu } = useContextMenu(items);
  const isRenaming = renamingPath === node.path;

  // For files: highlight + on-click opens. For dirs: toggle expand.
  if (node.type === 'file' && renderSelf) {
    const active = node.path === activePath;
    return (
      <>
        {isRenaming ? (
          <InlineRenameInput
            initialName={node.name}
            depth={depth}
            iconColor={active ? 'text-primary' : 'text-muted-foreground/70'}
            Icon={File}
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
            title={node.path}
          >
            <File className={cn('h-3 w-3 shrink-0', active ? 'text-primary' : 'text-muted-foreground/70')} />
            <span className="truncate">{node.name}</span>
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
              Icon={expanded ? FolderOpen : Folder}
              onSubmit={(name) => onCommitRename(node.path, name)}
              onCancel={onCancelRename}
              extraLeading={<span className="w-3" />}
            />
          ) : (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              {...triggerProps}
              className="w-full text-left flex items-center gap-1 px-1.5 py-[3px] rounded-sm text-[11.5px] leading-tight text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              style={{ paddingLeft: `${depth * 12 + 2}px` }}
            >
              {expanded ? (
                <ChevronDown className="h-3 w-3 shrink-0" />
              ) : (
                <ChevronRight className="h-3 w-3 shrink-0" />
              )}
              {expanded ? (
                <FolderOpen className="h-3 w-3 shrink-0 text-amber-500/80" />
              ) : (
                <Folder className="h-3 w-3 shrink-0 text-amber-500/80" />
              )}
              <span className="truncate">{node.name}</span>
            </button>
          )}
          {Menu}
        </>
      )}
      {expanded &&
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
 * parent's `onStartRename`); create / delete / copy use window.prompt
 * + window.confirm until inline create lands too.
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
    const name = window.prompt(`New ${kind} name:`);
    if (!name) return;
    const target = posixJoin(parentPath, name);
    try {
      if (kind === 'file') {
        await apiCall<{ ok: true }>('files.write', { projectId, path: target, content: '' });
      } else {
        await apiCall<{ ok: true }>('files.mkdir', { projectId, path: target });
      }
      onMutated();
    } catch (err) {
      window.alert(`Create failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const doDelete = async () => {
    const ok = window.confirm(`Delete ${isDir ? 'folder' : 'file'} "${node.name}"?`);
    if (!ok) return;
    try {
      await apiCall<{ ok: true }>('files.delete', {
        projectId,
        path: node.path,
        recursive: isDir,
      });
      onMutated();
    } catch (err) {
      window.alert(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const doCopyPath = () => {
    void navigator.clipboard.writeText(node.path).catch(() => undefined);
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
