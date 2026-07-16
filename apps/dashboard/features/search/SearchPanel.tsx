import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Info, Search as SearchIcon } from 'lucide-react';
import type { DBFile, DBSymbol, HybridSearchResult } from '@mcp/shared/types.js';
import { EmbeddingsDebugPanel } from './EmbeddingsDebugPanel.js';
import { structuralResultPreview } from './search-result-preview.js';
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

type SearchResult = HybridSearchResult;

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
}

type SearchMode = 'hybrid' | 'fts' | 'vector';

export default function SearchPanel({ projectId }: SearchPanelProps) {
  const { t } = useTranslation(['search', 'common']);
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
      if (!res.ok) throw new Error(`search failed (${res.status})`);
      const data = await res.json() as {
        results?: SearchResult[];
        diagnostics?: SearchDiagnostics | null;
      };
      setResults(data.results ?? []);
      setDiagnostics(data.diagnostics ?? null);
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
            placeholder={t('search:placeholder')}
            className="pl-9"
          />
        </div>
        <Select value={mode} onValueChange={(v) => setMode(v as SearchMode)}>
          <SelectTrigger className="w-[120px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="hybrid">{t('search:hybrid')}</SelectItem>
            <SelectItem value="fts">{t('search:fts')}</SelectItem>
            <SelectItem value="vector">{t('search:vector')}</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={handleSearch} disabled={loading}>
          {loading ? '…' : t('common:actions.search')}
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
                {!diagnostics.vectorAvailable && <div>{t('search:vectorNotConfigured')}</div>}
                {!diagnostics.embeddingAvailable && <div>{t('search:embeddingNotConfigured')}</div>}
                {diagnostics.vectorError && diagnostics.vectorAvailable && diagnostics.embeddingAvailable && (
                  <div>{t('search:vectorError')} {diagnostics.vectorError}</div>
                )}
              </div>
            </div>
          )}
          {diagnostics && !hasVectorIssue && (mode === 'vector' || mode === 'hybrid') && (
            <div className="flex items-center gap-2 p-2 rounded-md bg-muted/50 text-muted-foreground">
              <Info className="h-3.5 w-3.5 shrink-0" />
              <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                {diagnostics.queryVariants && diagnostics.queryVariants.length > 1 && (
                  <span>{t('search:variants')} {diagnostics.queryVariants.map((v, i) => (
                    <span key={i} className="font-mono">{i > 0 ? ', ' : ''}"{v}"</span>
                  ))}</span>
                )}
                {diagnostics.vectorRawMatches !== undefined && (
                  <span>{t('search:rawMatches')} {diagnostics.vectorRawMatches}</span>
                )}
                {diagnostics.vectorRehydrated !== undefined && (
                  <span>{t('search:rehydrated')} {diagnostics.vectorRehydrated}</span>
                )}
                {diagnostics.ftsCount !== undefined && mode === 'hybrid' && (
                  <span>{t('search:ftsLabel')} {diagnostics.ftsCount}</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {results.length > 0 && (
        <div className="space-y-2">
          {results.map((r, i) => {
            const path = r.type === 'file'
              ? (r.data as DBFile).path
              : (r.data as DBSymbol).file_path;
            const name = r.type === 'symbol' ? (r.data as DBSymbol).name : '';
            const structuralPreview = structuralResultPreview(r);
            return (
              <div
                key={`${r.type}-${r.id}-${i}`}
                className="p-3 rounded-lg border hover:bg-accent/40 transition-colors"
              >
                <div className="flex items-center gap-2 mb-1">
                  <Badge variant={r.type === 'file' ? 'info' : 'secondary'}>{r.type === 'file' ? t('search:file') : r.type}</Badge>
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
                {structuralPreview && (
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                    {structuralPreview}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
      {results.length === 0 && query && !loading && (
        <p className="text-muted-foreground text-sm">{t('search:noResults')}</p>
      )}
    </div>
  );
}
