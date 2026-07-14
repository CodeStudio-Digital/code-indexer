/**
 * A scrollable list of changed files (status letter + path + ±counts),
 * each opening its diff on click. Shared by the commit preview and the
 * stash preview so both snapshots read identically.
 */

import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '../../../../../lib/utils.js';
import { fileKind } from './file-kind.js';

export interface ChangedFile {
  path: string;
  oldPath?: string;
  state: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied';
  additions: number;
  deletions: number;
}

export function ChangedFilesList({
  files,
  onOpenFile,
}: {
  files: ChangedFile[];
  onOpenFile: (f: ChangedFile) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 29,
    overscan: 10,
  });

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
      {virtualizer.getVirtualItems().map((item) => {
        const f = files[item.index];
        const k = fileKind(f.state);
        return (
          <div
            key={f.path}
            data-index={item.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${item.start}px)`,
            }}
          >
            <button
              type="button"
              onClick={() => onOpenFile(f)}
              className="w-full flex items-center gap-2 px-3 py-1 text-left text-[11.5px] hover:bg-muted/40 border-b transition-colors"
              title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
            >
              <span className={cn('font-mono text-[10px] w-3 shrink-0 text-center', k.color)}>
                {k.letter}
              </span>
              <span className="truncate flex-1">{f.path}</span>
              <span className="shrink-0 flex items-center gap-1.5 text-[10px] font-mono">
                {f.additions > 0 && <span className="text-emerald-400">+{f.additions}</span>}
                {f.deletions > 0 && <span className="text-destructive">−{f.deletions}</span>}
              </span>
            </button>
          </div>
        );
      })}
      </div>
    </div>
  );
}
