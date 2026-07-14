import type { ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { cn } from '../../lib/utils.js';

export function WorkBoardViewport({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden p-3', className)}>
      <div className="flex h-full min-h-0 w-max min-w-full gap-3">{children}</div>
    </div>
  );
}

export function WorkBoardColumn({
  title,
  count,
  accentClass,
  children,
  emptyLabel,
  headerBadge,
  onAdd,
  onDropItem,
  className,
}: {
  title: ReactNode;
  count: number;
  accentClass?: string;
  children: ReactNode;
  emptyLabel: string;
  headerBadge?: ReactNode;
  onAdd?: () => void;
  onDropItem?: (id: string) => void;
  className?: string;
}) {
  return (
    <section
      className={cn('flex h-full min-h-0 min-w-[280px] max-w-[340px] flex-1 flex-col rounded-lg border border-t-2 bg-muted/30', accentClass, className)}
      onDragOver={onDropItem ? (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } : undefined}
      onDrop={onDropItem ? (event) => { event.preventDefault(); const id = event.dataTransfer.getData('text/plain'); if (id) onDropItem(id); } : undefined}
    >
      <header className="flex items-center justify-between border-b border-border/50 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-sm font-semibold">{title}</h3>
          {headerBadge ?? <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{count}</span>}
        </div>
        {onAdd && <button type="button" onClick={onAdd} className="rounded p-1 transition-colors hover:bg-muted"><Plus className="h-3.5 w-3.5 text-muted-foreground" /></button>}
      </header>
      <div className="min-h-[100px] flex-1 space-y-2 overflow-y-auto p-2">
        {children}
        {count === 0 && <div className="flex h-16 items-center justify-center text-xs text-muted-foreground/60">{emptyLabel}</div>}
      </div>
    </section>
  );
}

export function WorkBoardCard({
  children,
  onClick,
  dragId,
  blocked = false,
  selected = false,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  dragId?: string | number;
  blocked?: boolean;
  selected?: boolean;
  className?: string;
}) {
  return (
    <article
      draggable={dragId !== undefined}
      onDragStart={dragId !== undefined ? (event) => { event.dataTransfer.setData('text/plain', String(dragId)); event.dataTransfer.effectAllowed = 'move'; } : undefined}
      onClick={onClick}
      className={cn(
        'group relative rounded-lg border bg-card p-3 transition-all',
        onClick && 'cursor-pointer hover:border-primary/40 hover:shadow-md',
        blocked ? 'border-red-500/40 opacity-80' : 'border-border',
        selected && 'ring-2 ring-primary/40',
        className,
      )}
    >
      {children}
    </article>
  );
}
