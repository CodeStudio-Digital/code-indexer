/**
 * One virtualized tree row (22px) — dir or file, with indent guides,
 * git-status coloring and inline rename. Pure presentational; the store
 * owns expansion/loading.
 */
import { memo, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { fileIconFor } from '../../../lib/file-icon.js';
import { useContextMenu } from '../../../components/ui/context-menu.js';
import { FileIcon, FolderIcon } from '../../../components/FileIcon.js';
import type { TreeEntry } from '../../../state/file-tree.js';
import { useSelectionStore } from '../../../state/file-tree-selection.js';
import { buildContextItems, colorForStatus, type GitFileStatus } from './tree-context.js';

/** Modificadores do clique para o modelo de seleção. */
export interface ClickMods {
  additive: boolean;
  range: boolean;
}

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
  /** Clique simples (seleção). Duplo-clique/seta usam onOpen/onToggle. */
  onRowClick: (path: string, isDir: boolean, mods: ClickMods) => void;
  onStartRename: (path: string) => void;
  onCommitRename: (fromPath: string, newName: string) => void;
  onCancelRename: () => void;
  onMutated: () => void;
}

function FileTreeRowImpl(props: FileTreeRowProps) {
  const { entry, depth, projectId, active, expanded, status, renaming } = props;
  // Assinatura ESTREITA: só esta linha re-renderiza quando o próprio bit muda.
  // `selCount` devolve o tamanho da seleção só quando a linha está selecionada
  // (1 caso contrário) → linhas fora da seleção não re-renderizam ao crescer.
  const selected = useSelectionStore((s) => s.selected.has(entry.path));
  const selCount = useSelectionStore((s) => (s.selected.has(entry.path) ? s.selected.size : 1));
  const isDir = entry.type === 'dir';
  const items = buildContextItems(entry, projectId, props.onMutated, () => props.onStartRename(entry.path), {
    count: selCount,
    getPaths: () => [...useSelectionStore.getState().selected],
  });
  const { triggerProps, Menu } = useContextMenu(items);
  const color = colorForStatus(status);
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
      <div
        role="treeitem"
        aria-selected={selected}
        tabIndex={-1}
        onClick={(e) =>
          props.onRowClick(entry.path, isDir, { additive: e.ctrlKey || e.metaKey, range: e.shiftKey })
        }
        onDoubleClick={() => (isDir ? props.onToggle(entry.path) : props.onOpen(entry.path))}
        onContextMenu={(e) => {
          // Right-click numa linha fora da seleção seleciona-a primeiro (padrão).
          if (!selected) props.onRowClick(entry.path, isDir, { additive: false, range: false });
          triggerProps.onContextMenu(e);
        }}
        className={cn(
          'group w-full text-left flex items-stretch pl-1 pr-1.5 rounded-sm text-[length:var(--ide-tree-font,11.5px)] leading-tight transition-colors h-full cursor-pointer select-none',
          selected
            ? 'bg-accent text-foreground'
            : active
              ? 'bg-primary/10 text-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          active && selected && 'ring-1 ring-primary/30 ring-inset',
        )}
        title={status ? `${entry.path}\n(${status})` : entry.path}
      >
        <IndentGuides depth={depth} />
        <span className="flex items-center gap-1.5 min-w-0 flex-1">
          {isDir && entry.hasChildren !== false ? (
            // Seta = atalho rápido de expandir/colapsar (não dispara seleção).
            <span
              role="button"
              aria-label={expanded ? 'Collapse' : 'Expand'}
              onClick={(e) => {
                e.stopPropagation();
                props.onToggle(entry.path);
              }}
              className="w-3 shrink-0 grid place-items-center text-muted-foreground/70 hover:text-foreground"
            >
              {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </span>
          ) : (
            <span className="w-3 shrink-0" aria-hidden="true" />
          )}
          {isDir ? (
            <FolderIcon name={entry.name} expanded={expanded} className="h-3.5 w-3.5" />
          ) : (
            <FileIcon path={entry.path} className={cn('h-3.5 w-3.5', !active && !selected && 'opacity-90')} />
          )}
          <span className={cn('truncate', color.text, color.extra)}>{entry.name}</span>
        </span>
      </div>
      {Menu}
    </>
  );
}

/**
 * Memoizado (shallow): com `entry` ref-estável (o store reusa TreeEntry imutáveis) e
 * callbacks estáveis (FileTreeView usa useCallback / store fns), um load fundo na árvore
 * NÃO re-renderiza as outras linhas — a vitória load-bearing para árvores grandes.
 */
export const FileTreeRow = memo(FileTreeRowImpl);

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
    <div className="w-full flex items-stretch pl-1 pr-1.5 text-[length:var(--ide-tree-font,11.5px)] leading-tight bg-card/80 h-full">
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
          className="flex-1 min-w-0 bg-background border border-primary/60 rounded-sm px-1 py-[1px] text-[length:var(--ide-tree-font,11.5px)] outline-none focus:border-primary"
        />
      </span>
    </div>
  );
}
