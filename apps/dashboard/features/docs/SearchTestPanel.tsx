/**
 * SearchTestPanel — quick search to validate retrieval quality without
 * having to spin up an agent. Hits the same `/api/docs/search` endpoint
 * the `rag_search_docs` tool relies on, so a green result here means the
 * agent will see the same data.
 *
 * Scoped to the selected collection — pass `collection=undefined` to
 * search globally. (We always pass the selected one because the test
 * panel lives inside `CollectionDetail`.)
 */
import { useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Badge } from '../../components/ui/badge.js';
import { Card, CardContent } from '../../components/ui/card.js';
import {
  searchDocs,
  type DocCollection,
  type DocSearchDiagnostics,
  type DocSearchResult,
} from './docs-api.js';

interface Props {
  collection: DocCollection;
}

export function SearchTestPanel({ collection }: Props) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<DocSearchResult[] | null>(null);
  const [diag, setDiag] = useState<DocSearchDiagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const response = await searchDocs({
        query: query.trim(),
        collection: collection.name,
        limit: 10,
      });
      setResults(response.results);
      setDiag(response.diag);
    } catch (err) {
      setError((err as Error).message);
      setResults([]);
      setDiag(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <form onSubmit={onSearch} className="flex gap-2">
        <Input
          placeholder={`Ex: como funciona Rigidbody.AddForce?`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button type="submit" disabled={loading || !query.trim()}>
          {loading ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Search className="h-3 w-3 mr-1" />}
          Buscar
        </Button>
      </form>

      <p className="text-xs text-muted-foreground">
        Filtrando pela coleção <strong>{collection.name}</strong>. Esta busca usa exatamente o mesmo
        backend (<code className="bg-muted px-1 py-0.5 rounded">DocHybridSearch</code>) que a tool
        <code className="bg-muted px-1 py-0.5 rounded ml-1">rag_search_docs</code> chama.
      </p>

      {diag && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline" className="text-[10px]">mode: {diag.mode}</Badge>
          <Badge variant="outline" className="text-[10px]">fts: {diag.fts_hits}</Badge>
          <Badge variant="outline" className="text-[10px]">vector: {diag.vector_hits}</Badge>
          {!diag.embedding_available && (
            <Badge variant="outline" className="text-[10px] border-amber-500 text-amber-600">
              embedder offline
            </Badge>
          )}
          {!diag.vector_available && (
            <Badge variant="outline" className="text-[10px] border-amber-500 text-amber-600">
              vector store offline
            </Badge>
          )}
        </div>
      )}

      {error && <div className="text-sm text-destructive">{error}</div>}

      {results !== null && results.length === 0 && !error && (
        <div className="rounded-md border border-dashed bg-muted/20 p-6 text-center text-sm text-muted-foreground">
          Nenhum resultado. Tente uma query mais ampla ou verifique se a coleção foi indexada.
        </div>
      )}

      {results && results.length > 0 && (
        <div className="space-y-2">
          {results.map((r, i) => (
            <Card key={r.chunk_id}>
              <CardContent className="pt-4 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs text-muted-foreground">#{i + 1}</div>
                    <div className="font-medium text-sm">{r.heading_path ?? '(sem heading)'}</div>
                    {r.source_uri && (
                      <a
                        href={r.source_uri.startsWith('pdf://') ? undefined : r.source_uri}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-muted-foreground underline truncate block"
                      >
                        {r.source_uri}
                      </a>
                    )}
                  </div>
                  <Badge variant="outline" className="text-[10px] tabular-nums">
                    {r.score.toFixed(3)}
                  </Badge>
                </div>
                {r.summary && (
                  <p className="text-xs text-muted-foreground italic">{r.summary}</p>
                )}
                {r.concepts.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {r.concepts.map((c) => (
                      <Badge key={c} variant="outline" className="text-[10px]">{c}</Badge>
                    ))}
                  </div>
                )}
                <pre className="text-xs whitespace-pre-wrap break-words bg-muted/30 p-2 rounded">
                  {r.snippet}
                </pre>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
