/**
 * Find results (left pane) — matches grouped by file, IntelliJ-style. Each row
 * is one match: the line number + the source line with the matched span
 * highlighted (precise, using the grep's start/end offsets). Click selects
 * (drives the preview); double-click opens the file at the line.
 */
import type { ReactNode } from 'react';
import { FileCode2 } from 'lucide-react';
import { setPendingReveal } from '../../workspace/editor/pending-reveal.js';
import { cn } from '../../../lib/utils.js';
import type { FindCtl } from './useFindReplace.js';
import type { GMatch } from './find-types.js';

function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}
function dirName(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/** Trim leading indentation and shift the match span to match. */
function renderMatch(m: GMatch): ReactNode {
  const lead = m.text.length - m.text.trimStart().length;
  const text = m.text.slice(lead);
  const start = Math.max(0, m.start - lead);
  const end = Math.max(start, m.end - lead);
  return (
    <>
      {text.slice(0, start)}
      <mark className="bg-amber-400/30 text-foreground rounded-sm">{text.slice(start, end)}</mark>
      {text.slice(end)}
    </>
  );
}

export function FindResults({ c, onOpenFile }: { c: FindCtl; onOpenFile?: (p: string) => void }) {
  const files = c.result?.files ?? [];
  const sel = c.selected;

  const open = (path: string, line: number): void => {
    setPendingReveal(path, { line, column: 1 });
    onOpenFile?.(path);
  };

  if (!c.query) {
    return <div className="h-full grid place-items-center text-[11px] text-muted-foreground p-3 text-center">{'Type to search across the project.'}</div>;
  }
  if (!c.loading && files.length === 0) {
    return <div className="h-full grid place-items-center text-[11px] text-muted-foreground p-3 text-center">{'No matches.'}</div>;
  }

  return (
    <div className="h-full overflow-auto text-xs">
      {files.map((f) => (
        <div key={f.path}>
          <button
            type="button"
            onClick={() => f.matches[0] && c.setSelected({ path: f.path, line: f.matches[0].line })}
            onDoubleClick={() => f.matches[0] && open(f.path, f.matches[0].line)}
            className="w-full flex items-center gap-1.5 bg-card/90 px-2 py-1 border-b sticky top-0 text-left"
            title={f.path}
          >
            <FileCode2 className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="font-medium shrink-0">{baseName(f.path)}</span>
            <span className="text-muted-foreground truncate min-w-0">{dirName(f.path)}</span>
            <span className="ml-auto text-muted-foreground shrink-0 tabular-nums">{f.matches.length}</span>
          </button>
          {f.matches.map((m, i) => {
            const active = sel?.path === f.path && sel.line === m.line;
            return (
              <button
                key={`${f.path}:${i}`}
                type="button"
                onClick={() => c.setSelected({ path: f.path, line: m.line })}
                onDoubleClick={() => open(f.path, m.line)}
                title={`${f.path}:${m.line}`}
                className={cn(
                  'w-full flex items-baseline gap-2 px-3 py-0.5 text-left min-w-0',
                  active ? 'bg-primary/15' : 'hover:bg-muted/60',
                )}
              >
                <span className="text-muted-foreground shrink-0 tabular-nums w-10 text-right">{m.line}</span>
                <span className="flex-1 min-w-0 truncate font-mono text-[10.5px] whitespace-pre">{renderMatch(m)}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
