/**
 * Find preview (right pane) — the selected match shown in its file with the
 * surrounding lines for context, the matched line highlighted, and every
 * occurrence of the term marked. Reads the file on demand and scrolls the
 * selection into view.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { apiCall } from '../../../lib/api-client.js';
import { cn } from '../../../lib/utils.js';
import type { FindCtl } from './useFindReplace.js';
import type { FindOpts } from './find-types.js';

const WINDOW = 60; // lines of context above/below the match

/** Client-side mirror of the grep matcher, for highlighting preview lines. */
function clientMatcher(query: string, o: FindOpts): RegExp | null {
  if (!query) return null;
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let src = o.regex ? query : esc(query);
  if (o.wholeWord) src = `\\b(?:${src})\\b`;
  try {
    return new RegExp(src, 'g' + (o.caseSensitive ? '' : 'i'));
  } catch {
    return null;
  }
}

function highlight(text: string, matcher: RegExp | null): ReactNode {
  if (!matcher) return text;
  matcher.lastIndex = 0;
  const parts: ReactNode[] = [];
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = matcher.exec(text)) !== null) {
    if (m.index > i) parts.push(text.slice(i, m.index));
    parts.push(<mark key={m.index} className="bg-amber-400/30 text-foreground rounded-sm">{m[0]}</mark>);
    i = m.index + m[0].length;
    if (m[0].length === 0) matcher.lastIndex++;
  }
  if (parts.length === 0) return text;
  if (i < text.length) parts.push(text.slice(i));
  return <>{parts}</>;
}

export function FindPreview({ projectId, c }: { projectId: number; c: FindCtl }) {
  const sel = c.selected;
  const [lines, setLines] = useState<string[] | null>(null);
  const selRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sel) { setLines(null); return; }
    let alive = true;
    setLines(null);
    apiCall<{ content?: string }>('files.read', { projectId, path: sel.path })
      .then((r) => { if (alive) setLines(typeof r.content === 'string' ? r.content.split('\n') : []); })
      .catch(() => { if (alive) setLines([]); });
    return () => { alive = false; };
  }, [projectId, sel?.path]);

  useEffect(() => {
    selRef.current?.scrollIntoView({ block: 'center' });
  }, [sel?.line, lines]);

  if (!sel) {
    return <div className="h-full grid place-items-center text-[11px] text-muted-foreground p-3 text-center">{'Select a match to preview.'}</div>;
  }
  if (!lines) {
    return <div className="h-full grid place-items-center text-[11px] text-muted-foreground">{'Loading…'}</div>;
  }

  const matcher = clientMatcher(c.query, c.opts);
  const from = Math.max(0, sel.line - 1 - WINDOW);
  const to = Math.min(lines.length, sel.line - 1 + WINDOW + 1);
  const slice = lines.slice(from, to);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 px-2 py-1 border-b text-[10px] text-muted-foreground truncate font-mono" title={sel.path}>
        {sel.path}
      </div>
      <div className="flex-1 min-h-0 overflow-auto text-[11px] font-mono leading-[1.45]">
        {slice.map((text, idx) => {
          const ln = from + idx + 1;
          const isSel = ln === sel.line;
          return (
            <div
              key={ln}
              ref={isSel ? selRef : undefined}
              className={cn('flex min-w-0', isSel ? 'bg-primary/10' : '')}
            >
              <span className="shrink-0 w-12 pr-2 text-right text-muted-foreground/60 tabular-nums select-none">{ln}</span>
              <span className="flex-1 whitespace-pre">{highlight(text, matcher)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
