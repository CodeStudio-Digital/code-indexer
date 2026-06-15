/**
 * Find panel — project-wide search surfaced in the bottom drawer (next to
 * Problems / Output). Reuses the existing `search.project` handler (FTS5 +
 * vector hybrid) — the same backend the right-rail Search tool window uses.
 *
 * Results are grouped by file (like ProblemsPanel) and each hit reuses the
 * editor's one-shot reveal handoff (`setPendingReveal` + onOpenFile), so no
 * editor wiring is duplicated here. The index is contentless, so a hit is a
 * `file:line` (snippet shown only when the backend happens to return one).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, FileCode2 } from 'lucide-react';
import { apiCall } from '../../../lib/api-client.js';
import { Input } from '../../../components/ui/input.js';
import { setPendingReveal } from '../../workspace/editor/pending-reveal.js';
import { cn } from '../../../lib/utils.js';

interface FindHit {
  file_path: string;
  line?: number;
  snippet?: string;
  score: number;
}

interface FindPanelProps {
  projectId: number;
  onOpenFile?: (path: string) => void;
}

function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}
function dirName(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

export function FindPanel({ projectId, onOpenFile }: FindPanelProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FindHit[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const runSearch = useCallback(
    async (q: string) => {
      if (!q.trim()) {
        setResults([]);
        return;
      }
      setLoading(true);
      try {
        const r = await apiCall<{ results: FindHit[] }>('search.project', {
          projectId,
          query: q,
          mode: 'hybrid',
          type: 'all',
          limit: 100,
        });
        setResults(r.results ?? []);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [projectId],
  );

  // Debounce: 300ms after last keystroke (matches the Search tool window).
  useEffect(() => {
    const t = setTimeout(() => void runSearch(query), 300);
    return () => clearTimeout(t);
  }, [query, runSearch]);

  const groups = useMemo(() => {
    const byFile = new Map<string, FindHit[]>();
    for (const r of results) {
      const arr = byFile.get(r.file_path);
      if (arr) arr.push(r);
      else byFile.set(r.file_path, [r]);
    }
    return [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [results]);

  const open = (path: string, line?: number): void => {
    if (line != null) setPendingReveal(path, { line, column: 1 });
    onOpenFile?.(path);
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 p-2 border-b">
        <div className="relative">
          <Search className="h-3 w-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find in project…"
            className="h-7 text-[12px] pl-7"
          />
        </div>
        <div className="mt-1 text-[10px] text-muted-foreground">
          {loading
            ? 'Searching…'
            : `${results.length} result${results.length === 1 ? '' : 's'} in ${groups.length} file${groups.length === 1 ? '' : 's'}`}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto text-xs">
        {groups.map(([file, hits]) => (
          <div key={file}>
            <div className="flex items-center gap-1.5 bg-card/90 px-2 py-1 border-b sticky top-0">
              <FileCode2 className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="font-medium shrink-0">{baseName(file)}</span>
              <span className="text-muted-foreground truncate min-w-0">{dirName(file)}</span>
              <span className="ml-auto text-muted-foreground shrink-0 tabular-nums">{hits.length}</span>
            </div>
            {hits.map((h, i) => (
              <button
                key={`${file}:${h.line ?? 0}:${i}`}
                type="button"
                onClick={() => open(file, h.line)}
                title={`${file}:${h.line ?? '?'}`}
                className={cn(
                  'w-full flex items-baseline gap-2 px-3 py-1 text-left',
                  'hover:bg-muted/60 transition-colors min-w-0',
                )}
              >
                <span className="text-muted-foreground shrink-0 tabular-nums w-10 text-right">
                  {h.line ?? '·'}
                </span>
                <span className="flex-1 min-w-0 truncate font-mono text-[10.5px]">
                  {h.snippet ?? baseName(file)}
                </span>
              </button>
            ))}
          </div>
        ))}
        {!loading && query && results.length === 0 && (
          <div className="px-3 py-4 text-[11px] text-muted-foreground text-center">
            No matches for &quot;{query}&quot;.
          </div>
        )}
        {!query && (
          <div className="px-3 py-4 text-[11px] text-muted-foreground text-center">
            Type to search across the project.
          </div>
        )}
      </div>
    </div>
  );
}
