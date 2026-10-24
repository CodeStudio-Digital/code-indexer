/**
 * One pinned chip — icon + label, active tint, unpin (× on hover / middle
 * click), and native drag-to-reorder with a `bg-primary` insertion line on the
 * hovered edge (mirrors the editor tab chip). Styling matches the compact
 * header density (h-7, text-[11px], bg-card/40).
 */
import { useState } from 'react';
import { X } from 'lucide-react';
import type { Pin } from '../../state/pinned-tabs-types.js';
import { cn } from '../../lib/utils.js';
import { iconFor } from './icons.js';
import { hasPinPayload, readPinPayload, setPinPayload } from './pin-dnd.js';

interface PinnedTabProps {
  pin: Pin;
  active: boolean;
  onActivate: () => void;
  onUnpin: () => void;
  /** Reorder request: move `fromId` to the given edge of this chip. */
  onReorder: (fromId: string, targetId: string, edge: 'left' | 'right') => void;
  closeLabel: string;
}

export function PinnedTab({ pin, active, onActivate, onUnpin, onReorder, closeLabel }: PinnedTabProps) {
  const Icon = iconFor(pin.icon);
  const [edge, setEdge] = useState<'left' | 'right' | null>(null);

  return (
    <div
      className="relative shrink-0"
      onDragOver={(e) => {
        if (!hasPinPayload(e)) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        setEdge(e.clientX < r.left + r.width / 2 ? 'left' : 'right');
      }}
      onDragLeave={() => setEdge(null)}
      onDrop={(e) => {
        if (!hasPinPayload(e)) return;
        e.preventDefault();
        const payload = readPinPayload(e);
        const dropEdge = edge;
        setEdge(null);
        if (!payload || payload.id === pin.id || !dropEdge) return;
        onReorder(payload.id, pin.id, dropEdge);
      }}
    >
      {edge && (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-y-1 w-0.5 rounded bg-primary',
            edge === 'left' ? '-left-0.5' : '-right-0.5',
          )}
        />
      )}
      <button
        type="button"
        role="tab"
        aria-selected={active}
        draggable
        onDragStart={(e) => setPinPayload(e, { id: pin.id })}
        onClick={onActivate}
        onMouseDown={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            onUnpin();
          }
        }}
        title={pin.label}
        className={cn(
          'group flex items-center gap-1.5 h-7 pl-2 pr-1 rounded border border-transparent text-[11px] transition-colors max-w-[200px]',
          active
            ? 'bg-accent text-accent-foreground'
            : 'bg-card/40 text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate max-w-[150px]">{pin.label}</span>
        <span
          role="button"
          aria-label={closeLabel}
          onClick={(e) => {
            e.stopPropagation();
            onUnpin();
          }}
          className="ml-0.5 grid h-4 w-4 shrink-0 place-items-center rounded opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/10 dark:hover:bg-white/10"
        >
          <X className="h-3 w-3" />
        </span>
      </button>
    </div>
  );
}
