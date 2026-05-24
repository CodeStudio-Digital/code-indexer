/**
 * Left rail of the Workspace — recursive file tree backed by
 * `files.tree({projectId})`. Click opens; right-click opens a context
 * menu with the standard IDE actions (new file/folder, rename, delete,
 * copy path).
 *
 * Folder expansion state is local; refreshes don't preserve it (matches
 * VS Code default). When a file action mutates the disk we bump the
 * reload key so the tree refreshes without the user hitting reload.
 *
 * No virtualization yet — added when a project surfaces a 10k-node tree.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
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

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

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
  renderSelf = true,
}: NodeViewProps) {
  const [expanded, setExpanded] = useState(depth === 0);
  const items = buildContextItems(node, projectId, onMutated);
  const { triggerProps, Menu } = useContextMenu(items);

  // For files: highlight + on-click opens. For dirs: toggle expand.
  if (node.type === 'file' && renderSelf) {
    const active = node.path === activePath;
    return (
      <>
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
        {Menu}
      </>
    );
  }

  const children = useMemo(() => node.children ?? [], [node.children]);

  return (
    <div>
      {renderSelf && (
        <>
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
          />
        ))}
    </div>
  );
}

/**
 * Compose the right-click menu for a file-tree node. Same chrome on files
 * and folders; the file-only / folder-only items are filtered out via
 * `disabled` to keep the menu shape predictable for muscle memory.
 *
 * Mutations call apiCall and then `onMutated()` so the parent rail
 * refetches the tree.
 */
function buildContextItems(
  node: FileTreeNode,
  projectId: number,
  onMutated: () => void,
): ContextMenuItem[] {
  const isDir = node.type === 'dir';
  const parentPath = isDir ? node.path : posixDirname(node.path);

  const promptCreate = async (kind: 'file' | 'folder') => {
    // window.prompt is intentional for now — a proper inline rename UI
    // is a future polish item. Returns null on cancel.
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

  const doRename = async () => {
    const next = window.prompt(`Rename ${node.name} to:`, node.name);
    if (!next || next === node.name) return;
    const target = posixJoin(posixDirname(node.path), next);
    try {
      await apiCall<{ ok: true }>('files.rename', { projectId, from: node.path, to: target });
      onMutated();
    } catch (err) {
      window.alert(`Rename failed: ${err instanceof Error ? err.message : String(err)}`);
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
      label: 'Rename…',
      icon: Edit3,
      separatorBefore: true,
      onSelect: () => void doRename(),
    },
    {
      id: 'copy-path',
      label: 'Copy path',
      icon: ClipboardCopy,
      shortcut: 'Ctrl+Shift+C',
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

function posixDirname(p: string): string {
  const ix = p.lastIndexOf('/');
  return ix <= 0 ? '' : p.slice(0, ix);
}

function posixJoin(a: string, b: string): string {
  if (!a) return b;
  if (a.endsWith('/')) return a + b;
  return `${a}/${b}`;
}
