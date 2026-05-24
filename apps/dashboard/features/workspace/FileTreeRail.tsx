/**
 * Left rail of the Workspace — recursive file tree backed by
 * `files.tree({projectId})`. Click on a file calls `onOpen(path)`;
 * the parent maps that to opening the file in the editor.
 *
 * Folders expand inline (state is local to the component — refreshes
 * don't preserve which folders were open, which matches VS Code's
 * default behavior for a fresh window).
 *
 * No virtualization yet — that lands when we have a project with a
 * 10k-file tree to validate against. For typical project sizes
 * (~1k visible nodes after blocklist), DOM render is fine.
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import { apiCall } from '../../lib/api-client.js';
import { Button } from '../../components/ui/button.js';
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
    <div className="h-full flex flex-col bg-card/30 border-r min-h-0">
      <div className="h-8 shrink-0 border-b/50 border-b flex items-center justify-between px-2.5 gap-1">
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.08em]">
          Explorer
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 text-muted-foreground hover:text-foreground"
          onClick={() => setReloadKey((k) => k + 1)}
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
            activePath={activePath}
            onOpen={onOpen}
            // The root node never gets a chevron; its children render directly.
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
  activePath: string | null;
  onOpen: (path: string) => void;
  /** When false, only renders this node's children (used for the root). */
  renderSelf?: boolean;
}

function NodeView({ node, depth, activePath, onOpen, renderSelf = true }: NodeViewProps) {
  const [expanded, setExpanded] = useState(depth === 0);

  // For files: highlight + on-click opens. For dirs: toggle expand.
  if (node.type === 'file' && renderSelf) {
    const active = node.path === activePath;
    return (
      <button
        type="button"
        onClick={() => onOpen(node.path)}
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
    );
  }

  const children = useMemo(() => node.children ?? [], [node.children]);

  return (
    <div>
      {renderSelf && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
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
      {expanded &&
        children.map((child) => (
          <NodeView
            key={child.path}
            node={child}
            depth={renderSelf ? depth + 1 : depth}
            activePath={activePath}
            onOpen={onOpen}
          />
        ))}
    </div>
  );
}
