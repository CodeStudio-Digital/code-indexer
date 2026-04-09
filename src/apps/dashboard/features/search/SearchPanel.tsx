import { useState } from 'react';
import { AlertCircle, Info, Search as SearchIcon } from 'lucide-react';
import { EmbeddingsDebugPanel } from './EmbeddingsDebugPanel.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';

interface SearchResult {
  id: number;
  type: 'file' | 'symbol';
  score: number;
  fts_rank: number | null;
  vector_score: number | null;
  data: Record<string, unknown>;
}

interface SearchDiagnostics {
  vectorAvailable: boolean;
  embeddingAvailable: boolean;
  queryVariants?: string[];
  vectorRawMatches?: number;
  vectorRehydrated?: number;
  vectorError?: string;
  ftsCount?: number;
}

interface SearchPanelProps {
  projectId: number;
  projectName: string;
}

type SearchMode = 'hybrid' | 'fts' | 'vector';

export default function SearchPanel({ projectId }: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('hybrid');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [diagnostics, setDiagnostics] = useState<SearchDiagnostics | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/search?q=${encodeURIComponent(query)}&mode=${mode}&limit=20`,
      );
      const data = await res.json();
      // Support both old format (array) and new format ({ results, diagnostics })
      if (Array.isArray(data)) {
        setResults(data as SearchResult[]);
        setDiagnostics(null);
      } else {
        setResults((data.results ?? []) as SearchResult[]);
        setDiagnostics((data.diagnostics ?? null) as SearchDiagnostics | null);
      }
    } catch {
      setResults([]);
      setDiagnostics(null);
    }
    setLoading(false);
  };

  const hasVectorIssue = diagnostics && (mode === 'vector' || mode === 'hybrid') && (
    !diagnostics.vectorAvailable || !diagnostics.embeddingAvailable || diagnostics.vectorError
  );

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Search files and symbols…"
            className="pl-9"
          />
        </div>
        <Select value={mode} onValueChange={(v) => setMode(v as SearchMode)}>
          <SelectTrigger className="w-[120px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="hybrid">Hybrid</SelectItem>
            <SelectItem value="fts">FTS</SelectItem>
            <SelectItem value="vector">Vector</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={handleSearch} disabled={loading}>
          {loading ? '…' : 'Search'}
        </Button>
      </div>

      <EmbeddingsDebugPanel projectId={projectId} />

      {/* Diagnostics bar */}
      {diagnostics && query && !loading && (
        <div className="text-xs space-y-1.5">
          {hasVectorIssue && (
            <div className="flex items-start gap-2 p-2.5 rounded-md bg-destructive/10 text-destructive border border-destructive/20">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <div>
                {!diagnostics.vectorAvailable && <div>Vector store not configured. Configure in Admin &gt; Embeddings &amp; Vector Stores.</div>}
                {!diagnostics.embeddingAvailable && <div>Embedding service not configured. Configure in Admin &gt; Embeddings &amp; Vector Stores.</div>}
                {diagnostics.vectorError && diagnostics.vectorAvailable && diagnostics.embeddingAvailable && (
                  <div>Vector search error: {diagnostics.vectorError}</div>
                )}
              </div>
            </div>
          )}
          {diagnostics && !hasVectorIssue && (mode === 'vector' || mode === 'hybrid') && (
            <div className="flex items-center gap-2 p-2 rounded-md bg-muted/50 text-muted-foreground">
              <Info className="h-3.5 w-3.5 shrink-0" />
              <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                {diagnostics.queryVariants && diagnostics.queryVariants.length > 1 && (
                  <span>Variants: {diagnostics.queryVariants.map((v, i) => (
                    <span key={i} className="font-mono">{i > 0 ? ', ' : ''}"{v}"</span>
                  ))}</span>
                )}
                {diagnostics.vectorRawMatches !== undefined && (
                  <span>Raw matches: {diagnostics.vectorRawMatches}</span>
                )}
                {diagnostics.vectorRehydrated !== undefined && (
                  <span>Rehydrated: {diagnostics.vectorRehydrated}</span>
                )}
                {diagnostics.ftsCount !== undefined && mode === 'hybrid' && (
                  <span>FTS: {diagnostics.ftsCount}</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {results.length > 0 && (
        <div className="space-y-2">
          {results.map((r, i) => {
            const path = (r.data.path ?? r.data.file_path ?? '') as string;
            const name = (r.data.name ?? '') as string;
            const summary = ((r.data.summary ?? r.data.comment ?? '') as string).slice(0, 160);
            return (
              <div
                key={`${r.type}-${r.id}-${i}`}
                className="p-3 rounded-lg border hover:bg-accent/40 transition-colors"
              >
                <div className="flex items-center gap-2 mb-1">
                  <Badge variant={r.type === 'file' ? 'info' : 'secondary'}>{r.type}</Badge>
                  <span className="font-mono text-sm truncate">
                    {path}
                    {name ? `:${name}` : ''}
                  </span>
                  <span className="text-xs text-muted-foreground ml-auto tabular-nums shrink-0">
                    {r.vector_score !== null && <span className="text-emerald-500 mr-2">vec:{r.vector_score.toFixed(3)}</span>}
                    {r.fts_rank !== null && <span className="mr-2">fts:#{r.fts_rank}</span>}
                    score: {r.score.toFixed(4)}
                  </span>
                </div>
                {summary && <p className="text-sm text-muted-foreground">{summary}</p>}
              </div>
            );
          })}
        </div>
      )}
      {results.length === 0 && query && !loading && (
        <p className="text-muted-foreground text-sm">No results found.</p>
      )}
    </div>
  );
}
