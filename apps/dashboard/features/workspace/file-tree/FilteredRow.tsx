/**
 * Linha do modo BUSCA (lista plana filtrada). Componente próprio para assinar
 * só o próprio bit de seleção (igual ao FileTreeRow) — evita re-render do
 * FileTreeView inteiro a cada clique enquanto a busca está ativa.
 */
import { memo } from 'react';
import { cn } from '../../../lib/utils.js';
import { FileIcon } from '../../../components/FileIcon.js';
import { useSelectionStore } from '../../../state/file-tree-selection.js';
import { colorForStatus, type GitFileStatus } from './tree-context.js';
import type { ClickMods } from './FileTreeRow.js';

interface FilteredRowProps {
  path: string;
  active: boolean;
  status?: GitFileStatus;
  style: React.CSSProperties;
  onRowClick: (path: string, isDir: boolean, mods: ClickMods) => void;
  onOpen: (path: string) => void;
}

function FilteredRowImpl({ path, active, status, style, onRowClick, onOpen }: FilteredRowProps) {
  const selected = useSelectionStore((s) => s.selected.has(path));
  const color = colorForStatus(status);
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      tabIndex={-1}
      style={style}
      onClick={(e) => onRowClick(path, false, { additive: e.ctrlKey || e.metaKey, range: e.shiftKey })}
      onDoubleClick={() => onOpen(path)}
      className={cn(
        'text-left flex items-center gap-1.5 px-1.5 rounded-sm text-[length:var(--ide-tree-font,11.5px)] cursor-pointer select-none',
        selected
          ? 'bg-accent text-foreground'
          : active
            ? 'bg-primary/10 text-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
      title={path}
    >
      <FileIcon path={path} className="h-3.5 w-3.5" />
      <span className={cn('truncate', color.text, color.extra)}>{path}</span>
    </div>
  );
}

export const FilteredRow = memo(FilteredRowImpl);
