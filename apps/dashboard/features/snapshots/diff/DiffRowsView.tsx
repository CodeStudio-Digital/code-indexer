/**
 * The virtualized diff body — one flat `@tanstack/react-virtual` list over
 * `DiffRow[]`. Extracted from `SnapshotDiffViewer` so both the full panel and the
 * inline chat diff render identical rows without duplicating the virtualizer.
 */
import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { DiffRow, type DiffRowHandlers } from './DiffRow.js';
import type { DiffRow as DiffRowModel } from './useDiffRows.js';

export function DiffRowsView({
  rows,
  maxContentChars,
  handlers,
}: {
  rows: DiffRowModel[];
  maxContentChars: number;
  handlers: DiffRowHandlers;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 20,
    overscan: 12,
    getItemKey: (index) => rows[index].key,
  });

  return (
    <div ref={parentRef} className="flex-1 min-h-0 overflow-auto bg-background">
      <div
        className="relative font-mono text-[11.5px] leading-snug"
        style={{
          height: virtualizer.getTotalSize(),
          width: `${Math.ceil(maxContentChars * 8.5) + 200}px`,
          minWidth: '100%',
        }}
      >
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
          >
            <DiffRow row={rows[item.index]} handlers={handlers} />
          </div>
        ))}
      </div>
    </div>
  );
}
