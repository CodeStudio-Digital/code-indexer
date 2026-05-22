/**
 * API client for the /api/docs/* HTTP routes (Documentação feature).
 * Mirrors the shape of `apps/dashboard/features/admin/hot-state-cache-api.ts`:
 *   - thin fetch wrappers
 *   - typed responses
 *   - no react-query dep — callers manage their own state
 */

export interface DocCollection {
  id: number;
  name: string;
  description: string | null;
  status: 'idle' | 'indexing' | 'error';
  status_message: string | null;
  embedding_provider_id: string | null;
  chunk_count: number;
  source_count: number;
  created_at: string;
  updated_at: string;
}

export interface DocSource {
  id: number;
  collection_id: number;
  type: 'pdf' | 'url';
  uri: string;
  title: string | null;
  status: 'queued' | 'fetching' | 'indexing' | 'done' | 'error';
  error_message: string | null;
  chunk_count: number;
  page_count: number;
  pages_accepted: number;
  pages_rejected: number;
  last_indexed_at: string | null;
  crawl_enabled: boolean;
  crawl_max_pages: number;
  crawl_max_depth: number;
  crawl_same_origin: boolean;
  crawl_include_pattern: string | null;
  crawl_exclude_pattern: string | null;
  crawl_required_path: string | null;
  crawl_llm_extract_links: boolean;
  pdf_size_bytes: number | null;
  cost_usd: number;
  created_at: string;
  updated_at: string;
}

export interface DocCrawlConfig {
  enabled?: boolean;
  max_pages?: number;
  max_depth?: number;
  same_origin?: boolean;
  include_pattern?: string | null;
  exclude_pattern?: string | null;
  /**
   * Literal substring the URL must contain (e.g. `/6000.3/Documentation/Manual/`).
   * Useful for pinning a specific manual / API version inside a larger docs site.
   * Empty string disables the check.
   */
  required_path?: string | null;
  /**
   * When true, the crawler calls an LLM on the seed page to surface
   * URLs the static HTML parser missed (JS-rendered sidebars,
   * data-attribute routes, embedded JSON page maps). 1 LLM call per
   * source. Configure the model in Admin → Pipelines under
   * `doc_ingest/link_extractor`. Falls back to cheerio-only when no
   * binding is set.
   */
  llm_extract_links?: boolean;
  /**
   * When true, every page in the crawl is fetched via Chromium
   * (headless browser) instead of plain HTTP — required for docs
   * whose navigation is populated by client-side JavaScript (Unity
   * ScriptReference, sites with an SPA shell that still has body
   * content). Costs ~15-30s per page vs ~100ms plain. Requires
   * ChromeService to be enabled in Admin → Chrome Service; if
   * unavailable, falls back to plain and annotates each page with
   * `force_browser_unavailable` in `blocked_signals`.
   */
  force_browser?: boolean;
}

export interface DocIngestEstimate {
  pages_to_fetch: number;
  pages_likely_accepted: number;
  estimated_chunks: number;
  estimated_tokens: number;
  estimated_cost_usd: number;
  notes?: string[];
}

export interface DocSearchResult {
  chunk_id: number;
  collection: string;
  source_id: number;
  source_uri: string | null;
  heading_path: string | null;
  snippet: string;
  score: number;
  summary: string | null;
  concepts: string[];
}

export interface DocSearchDiagnostics {
  fts_hits: number;
  vector_hits: number;
  mode: 'hybrid' | 'fts' | 'vector';
  embedding_available: boolean;
  vector_available: boolean;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try {
      const body = await r.json() as { error?: string };
      if (body.error) detail = body.error;
    } catch { /* ignore */ }
    throw new Error(detail);
  }
  return (await r.json()) as T;
}

// ─── Collections ────────────────────────────────────────────────────

export async function listCollections(): Promise<DocCollection[]> {
  return jsonFetch('/api/docs/collections');
}

export async function createCollection(input: {
  name: string;
  description?: string;
}): Promise<DocCollection> {
  return jsonFetch('/api/docs/collections', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/**
 * Outcome of a delete-with-vector-cleanup call. Both fields are zero when
 * the source/collection had no embeddings registered (e.g. indexed before
 * the embedder was wired). Non-zero `queued_for_retry` means the vector
 * store rejected the remote delete and the leftover ids landed in the
 * tombstone sweep queue — they'll be retried at the next server boot or
 * via POST /api/docs/vectors/sweep.
 */
export interface DocDeleteResult {
  ok: boolean;
  remote_deleted: number;
  queued_for_retry: number;
}

export async function deleteCollection(id: number): Promise<DocDeleteResult> {
  return jsonFetch(`/api/docs/collections/${id}`, { method: 'DELETE' });
}

// ─── Sources ────────────────────────────────────────────────────────

export async function listSources(collectionId: number): Promise<DocSource[]> {
  return jsonFetch(`/api/docs/collections/${collectionId}/sources`);
}

export async function deleteSource(collectionId: number, sourceId: number): Promise<DocDeleteResult> {
  return jsonFetch(`/api/docs/collections/${collectionId}/sources/${sourceId}`, {
    method: 'DELETE',
  });
}

export async function fetchPendingVectorTombstones(): Promise<{ pending: number }> {
  return jsonFetch('/api/docs/vectors/pending');
}

export interface DocSourceHealth {
  source_id: number;
  status: 'queued' | 'fetching' | 'indexing' | 'done' | 'error';
  chunks_persisted: number;
  chunks_embedded: number;
  embedding_complete: boolean;
  missing_count: number;
  last_indexed_at: string | null;
}

export async function fetchSourceHealth(sourceId: number): Promise<DocSourceHealth> {
  return jsonFetch(`/api/docs/sources/${sourceId}/health`);
}

/**
 * Stream a per-source re-embed of chunks whose vector mapping is missing.
 * Uses the same SSE event shape as fresh ingest, so `IndexProgressStream`
 * renders without modification (only the `embedding` phase fires).
 */
export async function retrySourceEmbeddingsStream(
  sourceId: number,
  callbacks: {
    onStart?: (p: unknown) => void;
    onProgress?: (p: DocIngestProgressFrame) => void;
    onDone?: (r: DocIngestDoneFrame) => void;
    onError?: (msg: string) => void;
  } = {},
  opts: { force?: boolean } = {},
): Promise<void> {
  const url = opts.force
    ? `/api/docs/sources/${sourceId}/embeddings/retry?force=1`
    : `/api/docs/sources/${sourceId}/embeddings/retry`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { accept: 'text/event-stream' },
  });
  return consumeEventStream(r, callbacks);
}

export async function retryCollectionEmbeddingsStream(
  collectionId: number,
  callbacks: {
    onStart?: (p: unknown) => void;
    onProgress?: (p: DocIngestProgressFrame) => void;
    onDone?: (r: DocIngestDoneFrame) => void;
    onError?: (msg: string) => void;
  } = {},
): Promise<void> {
  const r = await fetch(`/api/docs/collections/${collectionId}/embeddings/retry`, {
    method: 'POST',
    headers: { accept: 'text/event-stream' },
  });
  return consumeEventStream(r, callbacks);
}

export async function sweepVectorTombstones(): Promise<{ drained: number; still_pending: number }> {
  return jsonFetch('/api/docs/vectors/sweep', { method: 'POST' });
}

export async function addUrlSource(
  collectionId: number,
  input: { url: string; title?: string; crawl?: DocCrawlConfig; defer_indexing?: boolean },
): Promise<DocSource> {
  return jsonFetch(`/api/docs/collections/${collectionId}/sources/url`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/**
 * Index a URL with live SSE progress. The returned Promise resolves on the
 * `done` event (or rejects on `error`). Progress events are forwarded to
 * the optional `onProgress` callback.
 */
export async function indexUrlStream(
  collectionId: number,
  input: { url: string; title?: string; crawl?: DocCrawlConfig },
  callbacks: {
    onStart?: (p: unknown) => void;
    onProgress?: (p: DocIngestProgressFrame) => void;
    onDone?: (r: DocIngestDoneFrame) => void;
    onError?: (msg: string) => void;
  } = {},
): Promise<void> {
  const r = await fetch(`/api/docs/collections/${collectionId}/sources/url`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify(input),
  });
  return consumeEventStream(r, callbacks);
}

/**
 * Index a PDF (multipart upload) with live SSE progress.
 */
export async function indexPdfStream(
  collectionId: number,
  file: File,
  callbacks: {
    onStart?: (p: unknown) => void;
    onProgress?: (p: DocIngestProgressFrame) => void;
    onDone?: (r: DocIngestDoneFrame) => void;
    onError?: (msg: string) => void;
  } = {},
  title?: string,
): Promise<void> {
  const form = new FormData();
  form.append('file', file);
  if (title) form.append('title', title);
  const r = await fetch(`/api/docs/collections/${collectionId}/sources/pdf`, {
    method: 'POST',
    headers: { accept: 'text/event-stream' },
    body: form,
  });
  return consumeEventStream(r, callbacks);
}

/** Re-run ingestion for an existing URL source (PDFs require re-upload). */
export async function reindexSourceStream(
  collectionId: number,
  sourceId: number,
  callbacks: {
    onStart?: (p: unknown) => void;
    onProgress?: (p: DocIngestProgressFrame) => void;
    onDone?: (r: DocIngestDoneFrame) => void;
    onError?: (msg: string) => void;
  } = {},
): Promise<void> {
  const r = await fetch(`/api/docs/collections/${collectionId}/sources/${sourceId}/reindex`, {
    method: 'POST',
    headers: { accept: 'text/event-stream' },
  });
  return consumeEventStream(r, callbacks);
}

// ─── Dry-run ────────────────────────────────────────────────────────

export async function dryRunUrl(input: {
  url: string;
  crawl?: DocCrawlConfig;
}): Promise<DocIngestEstimate> {
  return jsonFetch('/api/docs/sources/dry-run/url', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function dryRunPdf(file: File): Promise<DocIngestEstimate> {
  const form = new FormData();
  form.append('file', file);
  const r = await fetch('/api/docs/sources/dry-run/pdf', {
    method: 'POST',
    body: form,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as DocIngestEstimate;
}

// ─── Search ─────────────────────────────────────────────────────────

export async function searchDocs(input: {
  query: string;
  collection?: string;
  limit?: number;
  mode?: 'hybrid' | 'fts' | 'vector';
}): Promise<{ results: DocSearchResult[]; diag: DocSearchDiagnostics }> {
  return jsonFetch('/api/docs/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

// ─── SSE plumbing ───────────────────────────────────────────────────

export type DocIngestPhase =
  | 'fetching'
  | 'gating'
  | 'chunking'
  | 'enriching'
  | 'embedding'
  | 'done'
  | 'error';

export interface DocIngestProgressFrame {
  phase: DocIngestPhase;
  current: number;
  total: number;
  label?: string;
  pages_fetched?: number;
  pages_accepted?: number;
  pages_rejected?: number;
  pages_via_browser?: number;
  chunks_indexed?: number;
  cost_usd?: number;
  elapsed_ms?: number;
}

export interface DocIngestDoneFrame {
  source_id: number;
  chunks_indexed: number;
  pages_fetched: number;
  pages_accepted: number;
  pages_rejected: number;
  pages_via_browser: number;
  cost_usd: number;
  elapsed_ms: number;
}

/**
 * Drain a `text/event-stream` body, dispatching each event to the matching
 * callback. Resolves on `done`, rejects on `error`. The Response is
 * expected to be a successful (`ok`) response — the caller already checked.
 */
async function consumeEventStream(
  response: Response,
  callbacks: {
    onStart?: (p: unknown) => void;
    onProgress?: (p: DocIngestProgressFrame) => void;
    onDone?: (r: DocIngestDoneFrame) => void;
    onError?: (msg: string) => void;
  },
): Promise<void> {
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.text();
      if (body) detail = body;
    } catch { /* ignore */ }
    throw new Error(detail);
  }
  if (!response.body) throw new Error('response body is not streamable');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  return new Promise<void>((resolve, reject) => {
    const pump = async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split('\n\n');
          buffer = events.pop() ?? '';
          for (const block of events) {
            const evt = parseEventBlock(block);
            if (!evt) continue;
            try {
              dispatch(evt, callbacks, resolve, reject);
            } catch (e) {
              reject(e);
              return;
            }
          }
        }
        resolve();
      } catch (e) {
        reject(e);
      }
    };
    void pump();
  });
}

function parseEventBlock(block: string): { event: string; data: string } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

function dispatch(
  evt: { event: string; data: string },
  cb: {
    onStart?: (p: unknown) => void;
    onProgress?: (p: DocIngestProgressFrame) => void;
    onDone?: (r: DocIngestDoneFrame) => void;
    onError?: (msg: string) => void;
  },
  resolve: () => void,
  reject: (err: Error) => void,
): void {
  let payload: unknown;
  try { payload = JSON.parse(evt.data); }
  catch { payload = evt.data; }

  switch (evt.event) {
    case 'start':
      cb.onStart?.(payload);
      break;
    case 'progress':
      cb.onProgress?.(payload as DocIngestProgressFrame);
      break;
    case 'done':
      cb.onDone?.(payload as DocIngestDoneFrame);
      resolve();
      break;
    case 'error': {
      const msg = (payload && typeof payload === 'object' && 'message' in payload)
        ? String((payload as { message: unknown }).message)
        : 'unknown error';
      cb.onError?.(msg);
      reject(new Error(msg));
      break;
    }
  }
}
