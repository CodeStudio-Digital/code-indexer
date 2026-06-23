/**
 * Problems panel — the project's diagnostics as a clickable, file-grouped
 * list (VS Code / IntelliJ "Problems" tool window). Rows come from
 * `useProjectDiagnostics` (run one level up, in BottomPanel, so the tab can
 * show a live count even when inactive).
 *
 * Clicking a row reuses the editor's one-shot reveal handoff
 * (`setPendingReveal` + the files tab) — the exact path the selection chip and
 * Search Everywhere already use, so no editor wiring is duplicated here.
 *
 * The grouped list is flattened (header + item rows) and virtualized so a
 * project with hundreds of diagnostics — common while indexing settles —
 * renders only the visible rows instead of every button. Trade-off vs the
 * old markup: group headers scroll with content rather than sticking.
 */
import { useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertCircle, AlertTriangle, FileCode2, Info, Lightbulb } from 'lucide-react';
import type { ProblemRow, Severity } from './diagnostics-reducer.js';
import { setPendingReveal } from '../../workspace/editor/pending-reveal.js';
import { cn } from '../../../lib/utils.js';

const SEVERITY_ICON: Record<Severity, { Icon: React.ComponentType<{ className?: string }>; className: string }> = {
  error: { Icon: AlertCircle, className: 'text-red-500' },
  warning: { Icon: AlertTriangle, className: 'text-amber-500' },
  info: { Icon: Info, className: 'text-sky-500' },
  hint: { Icon: Lightbulb, className: 'text-muted-foreground' },
};

const HEADER_H = 25;
const ITEM_H = 24;

function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}
function dirName(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

type FlatRow =
  | { kind: 'header'; key: string; file: string; count: number }
  | { kind: 'item'; key: string; row: ProblemRow };

interface ProblemsPanelProps {
  items: ProblemRow[];
  onOpenFile?: (path: string) => void;
}

export function ProblemsPanel({ items, onOpenFile }: ProblemsPanelProps) {
  const flat = useMemo<FlatRow[]>(() => {
    const byFile = new Map<string, ProblemRow[]>();
    for (const it of items) {
      const arr = byFile.get(it.file);
      if (arr) arr.push(it);
      else byFile.set(it.file, [it]);
    }
    const groups = [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const rows: FlatRow[] = [];
    for (const [file, group] of groups) {
      rows.push({ kind: 'header', key: `h:${file}`, file, count: group.length });
      const sorted = [...group].sort((x, y) => x.line - y.line || x.column - y.column);
      sorted.forEach((row, i) => {
        rows.push({ kind: 'item', key: `${file}:${row.source}:${row.line}:${row.column}:${i}`, row });
      });
    }
    return rows;
  }, [items]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: flat.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (flat[i].kind === 'header' ? HEADER_H : ITEM_H),
    overscan: 12,
  });

  if (items.length === 0) {
    return (
      <div className="h-full grid place-items-center text-xs text-muted-foreground p-2">
        No problems detected.
      </div>
    );
  }

  const open = (row: ProblemRow): void => {
    setPendingReveal(row.file, { line: row.line, column: row.column });
    onOpenFile?.(row.file);
  };

  return (
    <div ref={scrollRef} className="h-full overflow-auto text-xs">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((v) => {
          const r = flat[v.index];
          const style: React.CSSProperties = {
            position: 'absolute', top: 0, left: 0, width: '100%',
            transform: `translateY(${v.start}px)`, height: v.size,
          };
          if (r.kind === 'header') {
            return (
              <div
                key={r.key}
                style={style}
                className="flex items-center gap-1.5 bg-card/90 px-2 py-1 border-b"
              >
                <FileCode2 className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="font-medium shrink-0">{baseName(r.file)}</span>
                <span className="text-muted-foreground truncate min-w-0">{dirName(r.file)}</span>
                <span className="ml-auto text-muted-foreground shrink-0 tabular-nums">{r.count}</span>
              </div>
            );
          }
          const { Icon, className } = SEVERITY_ICON[r.row.severity];
          return (
            <button
              key={r.key}
              type="button"
              style={style}
              onClick={() => open(r.row)}
              title={r.row.message}
              className="flex items-start gap-1.5 px-3 py-1 text-left hover:bg-muted/60"
            >
              <Icon className={cn('h-3 w-3 mt-0.5 shrink-0', className)} />
              <span className="flex-1 min-w-0 truncate">{r.row.message}</span>
              {r.row.code != null && (
                <span className="text-muted-foreground shrink-0">{String(r.row.code)}</span>
              )}
              <span className="text-muted-foreground shrink-0 tabular-nums">
                {r.row.line}:{r.row.column}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
