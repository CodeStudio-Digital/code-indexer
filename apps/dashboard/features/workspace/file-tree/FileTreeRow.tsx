/**
 * One virtualized tree row (22px) — dir or file, with indent guides,
 * git-status coloring and inline rename. Pure presentational; the store
 * owns expansion/loading.
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { fileIconFor } from '../../../lib/file-icon.js';
import { useContextMenu } from '../../../components/ui/context-menu.js';
import type { TreeEntry } from '../../../state/file-tree.js';
import { buildContextItems, colorForStatus, type GitFileStatus } from './tree-context.js';

function IndentGuides({ depth }: { depth: number }) {
  if (depth <= 0) return null;
  return (
    <span className="flex shrink-0" aria-hidden="true">
      {Array.from({ length: depth }, (_, i) => (
        <span key={i} className="flex w-3 shrink-0 justify-center">
          <span className="w-px bg-border/70" />
        </span>
      ))}
    </span>
  );
}

export interface FileTreeRowProps {
  entry: TreeEntry;
  depth: number;
  projectId: number;
  active: boolean;
  expanded: boolean;
  status?: GitFileStatus;
  renaming: boolean;
  onOpen: (path: string) => void;
  onToggle: (path: string) => void;
  onStartRename: (path: string) => void;
  onCommitRename: (fromPath: string, newName: string) => void;
  onCancelRename: () => void;
  onMutated: () => void;
}

export function FileTreeRow(props: FileTreeRowProps) {
  const { entry, depth, projectId, active, expanded, status, renaming } = props;
  const items = buildContextItems(entry, projectId, props.onMutated, () => props.onStartRename(entry.path));
  const { triggerProps, Menu } = useContextMenu(items);
  const color = colorForStatus(status);
  const isDir = entry.type === 'dir';
  const { Icon: TypeIcon, colorClass } = fileIconFor(isDir ? '' : entry.path);

  if (renaming) {
    return (
      <InlineRenameInput
        initialName={entry.name}
        depth={depth}
        Icon={isDir ? (expanded ? FolderOpen : Folder) : TypeIcon}
        iconColor={isDir ? 'text-amber-500/80' : colorClass}
        onSubmit={(name) => props.onCommitRename(entry.path, name)}
        onCancel={props.onCancelRename}
      />
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => (isDir ? props.onToggle(entry.path) : props.onOpen(entry.path))}
        {...triggerProps}
        className={cn(
          'group w-full text-left flex items-stretch pl-1 pr-1.5 rounded-sm text-[11.5px] leading-tight transition-colors h-[22px]',
          active
            ? 'bg-primary/10 text-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
        title={status ? `${entry.path}\n(${status})` : entry.path}
      >
        <IndentGuides depth={depth} />
        <span className="flex items-center gap-1.5 min-w-0 flex-1">
          {isDir ? (
            entry.hasChildren === false ? (
              <span className="w-3 shrink-0" aria-hidden="true" />
            ) : expanded ? (
              <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/70" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/70" />
            )
          ) : (
            <span className="w-3 shrink-0" aria-hidden="true" />
          )}
          {isDir ? (
            expanded ? (
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-500/80" />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500/80" />
            )
          ) : (
            <TypeIcon className={cn('h-3.5 w-3.5 shrink-0', colorClass, !active && 'opacity-90')} />
          )}
          <span className={cn('truncate', color.text, color.extra)}>{entry.name}</span>
        </span>
      </button>
      {Menu}
    </>
  );
}

interface InlineRenameInputProps {
  initialName: string;
  depth: number;
  iconColor: string;
  Icon: React.ComponentType<{ className?: string }>;
  onSubmit: (newName: string) => void;
  onCancel: () => void;
}

export function InlineRenameInput({ initialName, depth, iconColor, Icon, onSubmit, onCancel }: InlineRenameInputProps) {
  const [value, setValue] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // Select the basename without extension so "foo.ts" → "bar.ts" is one type.
    const dot = initialName.lastIndexOf('.');
    if (dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }, [initialName]);

  return (
    <div className="w-full flex items-stretch pl-1 pr-1.5 text-[11.5px] leading-tight bg-card/80 h-[22px]">
      <IndentGuides depth={depth} />
      <span className="flex items-center gap-1.5 min-w-0 flex-1">
        <span className="w-3 shrink-0" aria-hidden="true" />
        <Icon className={cn('h-3.5 w-3.5 shrink-0', iconColor)} />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => onSubmit(value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); onSubmit(value); }
            else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
            e.stopPropagation();
          }}
          className="flex-1 min-w-0 bg-background border border-primary/60 rounded-sm px-1 py-[1px] text-[11.5px] outline-none focus:border-primary"
        />
      </span>
    </div>
  );
}
