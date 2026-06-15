/**
 * Problems panel — the project's diagnostics as a clickable, file-grouped
 * list (VS Code / IntelliJ "Problems" tool window). Rows come from
 * `useProjectDiagnostics` (run one level up, in BottomPanel, so the tab can
 * show a live count even when inactive).
 *
 * Clicking a row reuses the editor's one-shot reveal handoff
 * (`setPendingReveal` + the files tab) — the exact path the selection chip and
 * Search Everywhere already use, so no editor wiring is duplicated here.
 */
import { useMemo } from 'react';
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

function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}
function dirName(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

interface ProblemsPanelProps {
  items: ProblemRow[];
  onOpenFile?: (path: string) => void;
}

export function ProblemsPanel({ items, onOpenFile }: ProblemsPanelProps) {
  const groups = useMemo(() => {
    const byFile = new Map<string, ProblemRow[]>();
    for (const it of items) {
      const arr = byFile.get(it.file);
      if (arr) arr.push(it);
      else byFile.set(it.file, [it]);
    }
    return [...byFile.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([file, rows]) => ({
        file,
        rows: [...rows].sort((x, y) => x.line - y.line || x.column - y.column),
      }));
  }, [items]);

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
    <div className="h-full overflow-auto text-xs">
      {groups.map((g) => (
        <div key={g.file}>
          <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-card/90 backdrop-blur px-2 py-1 border-b">
            <FileCode2 className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="font-medium shrink-0">{baseName(g.file)}</span>
            <span className="text-muted-foreground truncate min-w-0">{dirName(g.file)}</span>
            <span className="ml-auto text-muted-foreground shrink-0 tabular-nums">{g.rows.length}</span>
          </div>
          {g.rows.map((row, i) => {
            const { Icon, className } = SEVERITY_ICON[row.severity];
            return (
              <button
                key={`${row.source}:${row.line}:${row.column}:${i}`}
                type="button"
                onClick={() => open(row)}
                title={row.message}
                className="w-full flex items-start gap-1.5 px-3 py-1 text-left hover:bg-muted/60"
              >
                <Icon className={cn('h-3 w-3 mt-0.5 shrink-0', className)} />
                <span className="flex-1 min-w-0 truncate">{row.message}</span>
                {row.code != null && (
                  <span className="text-muted-foreground shrink-0">{String(row.code)}</span>
                )}
                <span className="text-muted-foreground shrink-0 tabular-nums">
                  {row.line}:{row.column}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
