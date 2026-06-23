/**
 * Row renderers for the Drive file tree. Split from DriveFileTree.tsx to
 * keep each file small: this holds the recursive folder/file rows; the
 * sibling owns expansion state and builds the shared `DriveTreeCtx`.
 */
import React, { useCallback, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, FileText, Folder, FolderOpen, Trash2 } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { formatBytes, type DriveTreeNode } from './driveTree.js';

/** Shared callbacks + labels threaded through every row. */
export interface DriveTreeCtx {
  expanded: Set<string>;
  forceOpen: boolean;
  selectedPath: string | null;
  toggle: (path: string) => void;
  onOpen: (path: string) => void;
  onDelete: (path: string) => void;
  onDeleteFolder: (node: Extract<DriveTreeNode, { type: 'dir' }>) => void;
  deleteLabel: string;
  deleteFolderLabel: string;
  copyLabel: string;
}

export function TreeRows({ nodes, depth, ctx }: { nodes: DriveTreeNode[]; depth: number; ctx: DriveTreeCtx }) {
  return (
    <>
      {nodes.map((node) =>
        node.type === 'dir' ? (
          <DirRow key={node.path} node={node} depth={depth} ctx={ctx} />
        ) : (
          <FileRow key={node.path} node={node} depth={depth} ctx={ctx} />
        ),
      )}
    </>
  );
}

function DirRow({ node, depth, ctx }: { node: Extract<DriveTreeNode, { type: 'dir' }>; depth: number; ctx: DriveTreeCtx }) {
  const open = ctx.forceOpen || ctx.expanded.has(node.path);
  return (
    <div>
      {/* Row is a flex container (not a single <button>) so the folder delete
          action can sit alongside the toggle without nesting buttons. */}
      <div
        className="group flex items-center pr-1 text-xs hover:bg-accent"
        style={{ paddingLeft: depth * 12 + 8 }}
      >
        <button
          type="button"
          onClick={() => ctx.toggle(node.path)}
          className="flex flex-1 min-w-0 items-center gap-1.5 py-1.5 text-left"
        >
          {open ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          )}
          {open ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate font-medium">{node.name}</span>
          <span className="pl-2 text-[10px] text-muted-foreground tabular-nums">{node.fileCount}</span>
        </button>
        <Button
          size="sm"
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation();
            ctx.onDeleteFolder(node);
          }}
          className="h-6 w-6 shrink-0 p-0 opacity-0 group-hover:opacity-100"
          title={ctx.deleteFolderLabel}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      {open ? <TreeRows nodes={node.children} depth={depth + 1} ctx={ctx} /> : null}
    </div>
  );
}

function FileRow({ node, depth, ctx }: { node: Extract<DriveTreeNode, { type: 'file' }>; depth: number; ctx: DriveTreeCtx }) {
  const f = node.file;
  const selected = ctx.selectedPath === f.path;
  const [copied, setCopied] = useState(false);

  const copyPath = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      void navigator.clipboard.writeText(f.path).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      });
    },
    [f.path],
  );

  return (
    <div
      className={
        'group flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-accent cursor-pointer ' +
        (selected ? 'bg-accent' : '')
      }
      style={{ paddingLeft: depth * 12 + 8 }}
      onClick={() => ctx.onOpen(f.path)}
    >
      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="flex-1 min-w-0">
        <div className="font-mono truncate" title={f.path}>{node.name}</div>
        <div className="text-[10px] text-muted-foreground flex items-center gap-2">
          <span>{formatBytes(f.sizeBytes)}</span>
          {f.ownerRole ? (
            <span>
              by <span className="font-mono">{f.ownerRole}</span>
            </span>
          ) : null}
          <span title={f.updatedAt}>{f.updatedAt.replace('T', ' ').replace(/\..*/, '')}</span>
        </div>
      </div>
      <Button
        size="sm"
        variant="ghost"
        onClick={copyPath}
        className={'h-6 w-6 shrink-0 p-0 ' + (copied ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}
        title={ctx.copyLabel}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={(e) => {
          e.stopPropagation();
          ctx.onDelete(f.path);
        }}
        className="h-6 w-6 shrink-0 p-0 opacity-0 group-hover:opacity-100"
        title={ctx.deleteLabel}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
