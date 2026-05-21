/**
 * ResearchPanel — converse with the DocsAgent.
 *
 *   ┌───────────────────────────────────────────────────────────┐
 *   │ History list │  Input + Run                              │
 *   │   (recent    │  Markdown render of the latest result     │
 *   │   research   │  Citations panel                          │
 *   │   sessions)  │                                           │
 *   └───────────────────────────────────────────────────────────┘
 *
 * One-shot synchronous call to /api/docs-agent/research. SSE streaming
 * is wired on the API side; this MVP uses the JSON variant so the panel
 * stays simple (no incremental rendering).
 */
import { useEffect, useState } from 'react';
import { Loader2, Search, Trash2, BookText } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { listCollections, type DocCollection } from '../docs-api.js';
import {
  type DocsResearchResult,
  type DocsResearchSessionRow,
  type ResearchConfidence,
  deleteResearchSession,
  getResearchSession,
  listResearchSessions,
  runResearch,
} from './research-api.js';

export function ResearchPanel() {
  const [query, setQuery] = useState('');
  const [collectionsSelected, setCollectionsSelected] = useState<string[]>([]);
  const [collections, setCollections] = useState<DocCollection[] | null>(null);
  const [sessions, setSessions] = useState<DocsResearchSessionRow[] | null>(null);
  const [activeResult, setActiveResult] = useState<DocsResearchResult | null>(null);
  const [activeChunks, setActiveChunks] = useState<
    Array<{ id: number; heading_path: string | null; source_uri: string | null; summary: string | null }>
  >([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const [list, all] = await Promise.all([
        listResearchSessions({ limit: 20 }),
        listCollections(),
      ]);
      setSessions(list);
      setCollections(all);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleRun() {
    if (!query.trim()) return;
    setRunning(true);
    setError(null);
    setActiveResult(null);
    setActiveChunks([]);
    try {
      const result = await runResearch({
        query: query.trim(),
        collections: collectionsSelected.length > 0 ? collectionsSelected : undefined,
      });
      setActiveResult(result);
      // Hydrate cited chunks for the citations panel.
      try {
        const detail = await getResearchSession(result.sessionId);
        setActiveChunks(detail.cited_chunks);
      } catch {
        // Detail fetch is best-effort.
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function handleOpen(sessionId: number) {
    try {
      const detail = await getResearchSession(sessionId);
      setActiveResult({
        sessionId: detail.session.id,
        markdown: detail.session.final_markdown ?? '_(no answer captured)_',
        chunks_cited: detail.session.final_chunk_ids_json
          ? (JSON.parse(detail.session.final_chunk_ids_json) as number[])
          : [],
        confidence: detail.session.confidence,
        errorMessage: detail.session.error_message ?? undefined,
        telemetry: {
          turns: detail.session.num_turns,
          searches: detail.session.num_searches,
          chunks_read: detail.session.num_chunks_read,
          input_tokens: detail.session.input_tokens,
          output_tokens: detail.session.output_tokens,
          cost_usd: detail.session.cost_usd,
          duration_ms: 0,
        },
      });
      setActiveChunks(detail.cited_chunks);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleDelete(id: number) {
    setError(null);
    try {
      await deleteResearchSession(id);
      if (activeResult?.sessionId === id) {
        setActiveResult(null);
        setActiveChunks([]);
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
      {/* Left: history */}
      <aside className="space-y-3">
        <header>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Recent research
          </h3>
        </header>
        {sessions == null ? (
          <div className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : sessions.length === 0 ? (
          <div className="text-sm text-muted-foreground rounded-md border border-dashed px-3 py-4 text-center">
            No research sessions yet. Ask a question on the right.
          </div>
        ) : (
          <ul className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
            {sessions.map((s) => (
              <li
                key={s.id}
                className={`rounded-md border px-2 py-2 cursor-pointer hover:bg-muted/40 ${activeResult?.sessionId === s.id ? 'bg-muted/60 border-primary/40' : 'bg-card'}`}
                onClick={() => handleOpen(s.id)}
              >
                <div className="flex items-start justify-between gap-1">
                  <p className="text-xs line-clamp-2 flex-1">{s.query}</p>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDelete(s.id);
                    }}
                    className="opacity-60 hover:opacity-100 hover:text-destructive shrink-0"
                    aria-label="Delete session"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
                <div className="text-[10px] text-muted-foreground mt-1 flex items-center gap-2">
                  <StatusBadge status={s.status} />
                  {s.confidence && <ConfidenceBadge confidence={s.confidence} />}
                  <span>{s.num_turns}t / {s.num_chunks_read}c</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </aside>

      {/* Right: input + result */}
      <section className="space-y-4 min-w-0">
        <div className="rounded-md border bg-card p-3 space-y-3">
          <div>
            <label className="text-sm font-semibold">Ask the docs</label>
            <p className="text-xs text-muted-foreground">
              The DocsAgent will search, read chunks, and synthesize a cited markdown answer.
              Costs ~5-15s and 5-10× the tokens of <code>rag_search_docs</code>.
            </p>
          </div>
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="How do I authenticate with OAuth in Next.js 15 server actions?"
            rows={3}
            disabled={running}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground">Scope to:</span>
            {(collections ?? []).map((c) => {
              const active = collectionsSelected.includes(c.name);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() =>
                    setCollectionsSelected((prev) =>
                      active ? prev.filter((n) => n !== c.name) : [...prev, c.name],
                    )
                  }
                  className={`text-xs px-2 py-0.5 rounded-full border ${active ? 'bg-primary/10 border-primary/40 text-primary' : 'bg-muted/30 text-muted-foreground'}`}
                >
                  {c.name}
                </button>
              );
            })}
            <div className="ml-auto">
              <Button onClick={handleRun} disabled={running || !query.trim()}>
                {running ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Researching…
                  </>
                ) : (
                  <>
                    <Search className="mr-2 h-4 w-4" />
                    Run research
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {activeResult && (
          <article className="rounded-md border bg-card p-4 space-y-3 min-w-0">
            <header className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <BookText className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-semibold">Result</span>
                {activeResult.confidence && (
                  <ConfidenceBadge confidence={activeResult.confidence} />
                )}
                <span className="text-xs text-muted-foreground">
                  session {activeResult.sessionId}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                {activeResult.telemetry.turns} turns ·{' '}
                {activeResult.telemetry.searches} searches ·{' '}
                {activeResult.telemetry.chunks_read} chunks
              </div>
            </header>
            {activeResult.errorMessage && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
                {activeResult.errorMessage}
              </div>
            )}
            <div className="prose prose-sm max-w-none dark:prose-invert whitespace-pre-wrap break-words">
              {activeResult.markdown}
            </div>
            {activeChunks.length > 0 && (
              <footer className="border-t pt-3 space-y-1">
                <h4 className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">
                  Cited chunks
                </h4>
                <ul className="space-y-1 text-xs">
                  {activeChunks.map((c, i) => (
                    <li key={c.id} className="flex items-start gap-2">
                      <span className="font-mono text-muted-foreground">[^{i + 1}]</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{c.heading_path ?? '(untitled)'}</div>
                        {c.source_uri && (
                          <a
                            href={c.source_uri}
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary hover:underline text-[11px] truncate block"
                          >
                            {c.source_uri}
                          </a>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </footer>
            )}
          </article>
        )}
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: DocsResearchSessionRow['status'] }) {
  const tone =
    status === 'completed'
      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
      : status === 'running'
        ? 'bg-blue-500/10 text-blue-700 dark:text-blue-300'
        : status === 'failed'
          ? 'bg-destructive/10 text-destructive'
          : 'bg-muted text-muted-foreground';
  return <span className={`px-1.5 py-0.5 rounded ${tone}`}>{status}</span>;
}

function ConfidenceBadge({ confidence }: { confidence: ResearchConfidence }) {
  const tone =
    confidence === 'high'
      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
      : confidence === 'medium'
        ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
        : 'bg-muted text-muted-foreground';
  return <span className={`px-1.5 py-0.5 rounded ${tone}`}>conf: {confidence}</span>;
}
