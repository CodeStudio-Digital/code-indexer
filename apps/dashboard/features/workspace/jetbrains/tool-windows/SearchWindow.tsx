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

interface SearchResult {
  file_path: string;
  line?: number;
  snippet?: string;
  score: number;
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
          {results.map((r, i) => (
            <button
              key={`${r.file_path}:${r.line ?? 0}:${i}`}
              type="button"
              onClick={() => onOpen(r.file_path)}
              className={cn(
                'w-full text-left px-2.5 py-1.5 border-b last:border-b-0',
                'hover:bg-muted/40 transition-colors',
                'flex flex-col gap-0.5 min-w-0',
              )}
              title={`${r.file_path}:${r.line ?? '?'}`}
            >
              <span className="text-[11.5px] text-foreground truncate">
                {r.file_path}
                {r.line && <span className="text-muted-foreground/60">:{r.line}</span>}
              </span>
              {r.snippet && (
                <span className="text-[10.5px] text-muted-foreground truncate font-mono">
                  {r.snippet}
                </span>
              )}
            </button>
          ))}
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
