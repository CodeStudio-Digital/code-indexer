/**
 * Search tool window — code search across the project. Reuses the
 * existing `search.project` handler (FTS5 + vector hybrid).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { apiCall } from '../../../../lib/api-client.js';
import { Input } from '../../../../components/ui/input.js';
import { ToolWindowFrame } from '../ToolWindowFrame.js';
import { cn } from '../../../../lib/utils.js';

interface SearchWindowProps {
  projectId: number;
  onOpen: (path: string) => void;
  onClose?: () => void;
}

/**
 * `search.project` returns `HybridSearchResult` — path/line/name live under
 * `data` (DBFile `.path` for file hits, DBSymbol `.file_path`/`.name`/`.line`
 * for symbol hits), NOT flat on the row. Read `data` defensively.
 */
interface SearchResult {
  id: number;
  type: 'file' | 'symbol';
  score: number;
  data?: { path?: string; file_path?: string; name?: string; line?: number | null } | null;
}

function resPath(r: SearchResult): string | null {
  const p = r.data ? (r.data.path ?? r.data.file_path) : undefined;
  return typeof p === 'string' && p.length > 0 ? p : null;
}
function resLine(r: SearchResult): number | undefined {
  return typeof r.data?.line === 'number' ? r.data.line : undefined;
}
function resLabel(r: SearchResult): string {
  const name = r.data?.name;
  if (typeof name === 'string' && name.length > 0) return name;
  const p = resPath(r);
  return p ? p.slice(p.lastIndexOf('/') + 1) : '';
}

export function SearchWindow({ projectId, onOpen, onClose }: SearchWindowProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the search input every time the window mounts — a window the
  // user just opened is almost certainly about to be typed into.
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
        const r = await apiCall<{ results: SearchResult[] }>('search.project', {
          projectId,
          query: q,
          mode: 'hybrid',
          type: 'all',
          limit: 50,
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

  // Debounce: 300ms after last keystroke before firing.
  useEffect(() => {
    const t = setTimeout(() => void runSearch(query), 300);
    return () => clearTimeout(t);
  }, [query, runSearch]);

  return (
    <ToolWindowFrame title="Search" onClose={onClose}>
      <div className="flex flex-col h-full min-h-0">
        <div className="shrink-0 p-2 border-b">
          <div className="relative">
            <Search className="h-3 w-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search across project…"
              className="h-7 text-[12px] pl-7"
            />
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground">
            {loading ? 'Searching…' : `${results.length} result${results.length === 1 ? '' : 's'}`}
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {results.map((r, i) => {
            const path = resPath(r);
            if (!path) return null;
            const line = resLine(r);
            return (
              <button
                key={`${r.id}:${i}`}
                type="button"
                onClick={() => onOpen(path)}
                className={cn(
                  'w-full text-left px-2.5 py-1.5 border-b last:border-b-0',
                  'hover:bg-muted/40 transition-colors',
                  'flex flex-col gap-0.5 min-w-0',
                )}
                title={`${path}${line != null ? `:${line}` : ''}`}
              >
                <span className="text-[11.5px] text-foreground truncate">
                  {resLabel(r)}
                  {line != null && <span className="text-muted-foreground/60">:{line}</span>}
                </span>
                <span className="text-[10.5px] text-muted-foreground truncate font-mono">
                  {path}
                </span>
              </button>
            );
          })}
          {!loading && query && results.length === 0 && (
            <div className="px-3 py-4 text-[11px] text-muted-foreground text-center">
              No matches for &quot;{query}&quot;.
            </div>
          )}
        </div>
      </div>
    </ToolWindowFrame>
  );
}
