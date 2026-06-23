/**
 * Footer branch menu pieces. The action menu is a DRILL-IN rendered INSIDE the
 * popover (not a body portal): a body-portaled context menu would trip Radix
 * Popover's outside-pointer dismissal and unmount itself before the click
 * lands. Items come from the shared `buildBranchActions` so the footer and the
 * Git tool window expose the exact same IntelliJ action set.
 */
import { useRef } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '../../../../lib/utils.js';
import type { ContextMenuItem } from '../../../../components/ui/context-menu.js';
import { BranchRow, type BranchRowData } from './branch-popover-rows.js';
import { buildBranchActions } from '../tool-windows/git/branch-menu.js';
import type { BranchActions } from '../tool-windows/git/use-branch-ops.js';

/** A branch row whose click opens that branch's action panel beside the list. */
export function BranchListRow({
  branch,
  onPick,
  selected,
}: { branch: BranchRowData; onPick: (b: BranchRowData) => void; selected?: boolean }) {
  return <BranchRow branch={branch} busy={false} chevron selected={selected} onClick={() => onPick(branch)} />;
}

/** Virtualized remote list — a repo can have hundreds of remote branches. */
export function RemoteBranchList({
  remotes,
  onPick,
  selectedName,
}: { remotes: BranchRowData[]; onPick: (b: BranchRowData) => void; selectedName?: string }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const v = useVirtualizer({
    count: remotes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 26,
    overscan: 12,
  });
  return (
    <div ref={scrollRef} className="max-h-[240px] overflow-y-auto">
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((vi) => (
          <div
            key={remotes[vi.index].name}
            data-index={vi.index}
            ref={v.measureElement}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
          >
            <BranchListRow branch={remotes[vi.index]} onPick={onPick} selected={remotes[vi.index].name === selectedName} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The IntelliJ action set for one branch, rendered inline with a back header. */
export function BranchActionPanel({ branch, ops, onBack }: { branch: BranchRowData; ops: BranchActions; onBack: () => void }) {
  const renderItem = (item: ContextMenuItem) => {
    if (item.submenu) {
      return (
        <div key={item.id}>
          <div className="px-2.5 pt-1.5 pb-0.5 text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">{item.label}</div>
          {item.submenu.map(renderItem)}
        </div>
      );
    }
    const Icon = item.icon;
    return (
      <button
        key={item.id}
        type="button"
        disabled={item.disabled}
        // Back to the list first, THEN run the op (checkout/compare also close
        // the popover via the ops' onClose; the rest just refresh the list).
        onClick={() => { onBack(); item.onSelect?.(); }}
        className={cn(
          'w-full flex items-center gap-2 px-2.5 py-1 text-left',
          item.separatorBefore && 'border-t mt-0.5 pt-1.5',
          item.disabled
            ? 'text-muted-foreground/50 cursor-not-allowed'
            : item.destructive
              ? 'text-destructive hover:bg-destructive/10'
              : 'hover:bg-muted/50',
        )}
      >
        {Icon && <Icon className="h-3 w-3 shrink-0" />}
        <span className="flex-1 truncate">{item.label}</span>
      </button>
    );
  };

  return (
    <div className="flex flex-col max-h-[480px]">
      <button
        type="button"
        onClick={onBack}
        className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 border-b hover:bg-muted/40"
      >
        <ChevronLeft className="h-3 w-3 text-muted-foreground" />
        <span className="truncate font-medium">{branch.name}</span>
      </button>
      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {buildBranchActions(branch, ops).map(renderItem)}
      </div>
    </div>
  );
}
