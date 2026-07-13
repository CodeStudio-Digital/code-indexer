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

/**
 * Documentation type taxonomy (migration 149). Mirrors `DocType` in
 * `@mcp/store/doc/doc-type.ts` — kept as a local union so the dashboard
 * stays decoupled from the store package.
 */
export type DocType =
  | 'api_reference'
  | 'guide'
  | 'conceptual'
  | 'reference'
  | 'changelog'
  | 'handbook'
  | 'mixed';

export interface DocSource {
  id: number;
  collection_id: number;
  type: 'pdf' | 'url' | 'folder';
  doc_type: DocType;
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
  enrichment_mode: 'selective' | 'all' | 'off';
  embedding_fingerprint: string | null;
  last_ingest_run_id: number | null;
  folder_performance_profile: DocPerformanceProfile;
  folder_worker_count: number | null;
}

export type DocPerformanceProfile = 'economy' | 'balanced' | 'maximum' | 'custom';

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
  /**
   * Hybrid render mode: Chromium ONLY on the seed page (depth=0) to
   * surface JS-rendered nav, then plain HTTP for every discovered
   * leaf. Massive cost win on Unity-ScriptReference-style sites
   * where the sidebar is JS-only but each leaf is plain HTML.
   * Priority when both are set: `force_browser` wins.
   */
  browser_seed_only?: boolean;
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
  stale_vector_hits?: number;
  vector_coverage?: number;
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

// ─── Project links (migration 134) ──────────────────────────────────
// Linking a collection to a project scopes agent retrieval: a session's
// `rag_search_docs` searches the linked collections first. `origin` is
// 'auto' when the link came from approving a doc-source suggestion.

export interface DocProjectLink {
  project_id: number;
  project_name: string;
  origin: 'manual' | 'auto';
  created_at: string;
}

export async function listCollectionProjects(collectionId: number): Promise<DocProjectLink[]> {
  return jsonFetch(`/api/docs/collections/${collectionId}/projects`);
}

export async function linkCollectionToProject(
  collectionId: number,
  projectId: number,
  origin: 'manual' | 'auto' = 'manual',
): Promise<{ linked: boolean; created: boolean }> {
  return jsonFetch(`/api/docs/collections/${collectionId}/projects/${projectId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ origin }),
  });
}

export async function unlinkCollectionFromProject(
  collectionId: number,
  projectId: number,
): Promise<{ unlinked: boolean }> {
  return jsonFetch(`/api/docs/collections/${collectionId}/projects/${projectId}`, {
    method: 'DELETE',
  });
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
  lexical_ready: boolean;
  vector_ready: boolean;
  enrichment_ready: boolean;
  embedding_fingerprint: string | null;
  last_checkpoint_at: string | null;
  active_run_id: number | null;
}

export interface DocProjectSuggestion {
  project_id: number;
  project_name: string;
  confidence: number;
  reason: string;
}

export async function listCollectionProjectSuggestions(collectionId: number): Promise<DocProjectSuggestion[]> {
  return jsonFetch(`/api/docs/collections/${collectionId}/project-suggestions`);
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
    onScan?: (p: DocIngestScanFrame) => void;
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
    onScan?: (p: DocIngestScanFrame) => void;
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
  input: { url: string; title?: string; doc_type?: DocType; crawl?: DocCrawlConfig; defer_indexing?: boolean },
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
  input: { url: string; title?: string; doc_type?: DocType; crawl?: DocCrawlConfig },
  callbacks: {
    onStart?: (p: unknown) => void;
    onScan?: (p: DocIngestScanFrame) => void;
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
    onScan?: (p: DocIngestScanFrame) => void;
    onProgress?: (p: DocIngestProgressFrame) => void;
    onDone?: (r: DocIngestDoneFrame) => void;
    onError?: (msg: string) => void;
  } = {},
  title?: string,
  docType?: string,
): Promise<void> {
  const form = new FormData();
  form.append('file', file);
  if (title) form.append('title', title);
  if (docType) form.append('doc_type', docType);
  const r = await fetch(`/api/docs/collections/${collectionId}/sources/pdf`, {
    method: 'POST',
    headers: { accept: 'text/event-stream' },
    body: form,
  });
  return consumeEventStream(r, callbacks);
}

/**
 * Config para source tipo `'folder'` (migration 103). Espelha o tipo
 * server-side `DocFolderConfig`.
 */
export interface DocFolderConfig {
  /** Default `**\/*.{html,htm,md,markdown,pdf,txt}`. */
  include_glob?: string | null;
  /** Default exclui `node_modules`, `.git`, `dist`, `build`, etc. */
  exclude_glob?: string | null;
  /** Default 5000; server clampa hard em 50000. */
  max_files?: number | null;
  /** Default true — pula LLM gate (docs locais geralmente curadas). */
  bypass_relevance_gate?: boolean;
  performance_profile?: DocPerformanceProfile;
  worker_count?: number | null;
}

/**
 * Indexar uma pasta no FS do servidor com live SSE. Caso de uso real:
 * Unity ScriptReference offline em `…\Editor\Data\Documentation\en\
 * ScriptReference\`. Mesma forma de callbacks de `indexUrlStream` —
 * apenas o body é diferente (`path` em vez de `url`).
 */
export async function indexFolderStream(
  collectionId: number,
  input: { path: string; title?: string; doc_type?: DocType; enrichment_mode?: 'selective' | 'all' | 'off'; folder?: DocFolderConfig },
  callbacks: {
    onStart?: (p: unknown) => void;
    onScan?: (p: DocIngestScanFrame) => void;
    onProgress?: (p: DocIngestProgressFrame) => void;
    onDone?: (r: DocIngestDoneFrame) => void;
    onError?: (msg: string) => void;
  } = {},
): Promise<void> {
  const r = await fetch(`/api/docs/collections/${collectionId}/sources/folder`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify(input),
  });
  return consumeEventStream(r, callbacks);
}

/** Re-run ingestion for an existing URL/folder source (PDFs require re-upload). */
export async function reindexSourceStream(
  collectionId: number,
  sourceId: number,
  callbacks: {
    onStart?: (p: unknown) => void;
    onScan?: (p: DocIngestScanFrame) => void;
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

export async function cancelSourceIndex(sourceId: number): Promise<{ cancel_requested: boolean }> {
  return jsonFetch(`/api/docs/sources/${sourceId}/index/cancel`, { method: 'POST' });
}

export async function pauseSourceIndex(sourceId: number): Promise<{ pause_requested: boolean }> {
  return jsonFetch(`/api/docs/sources/${sourceId}/index/pause`, { method: 'POST' });
}

export async function updateSourceIndexPerformance(
  sourceId: number,
  profile: DocPerformanceProfile,
  workerCount?: number | null,
): Promise<{ profile: DocPerformanceProfile; worker_count: number; active_run_updated: boolean }> {
  return jsonFetch(`/api/docs/sources/${sourceId}/index/performance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile, worker_count: workerCount }),
  });
}

export async function resumeSourceIndex(sourceId: number): Promise<{ accepted: boolean; run_id: number | null }> {
  return jsonFetch(`/api/docs/sources/${sourceId}/index/resume`, { method: 'POST' });
}

export interface DocIngestRun {
  id: number;
  source_id: number;
  state: 'running' | 'paused' | 'paused_limit' | 'cancelled' | 'completed' | 'failed';
  phase: string;
  total_items: number;
  processed_items: number;
  changed_items: number;
  unchanged_items: number;
  chunks_persisted: number;
  embeddings_completed: number;
  enrichments_completed: number;
  pause_requested: boolean;
  performance_profile: DocPerformanceProfile;
  worker_count: number;
  heartbeat_at: string;
  error_message: string | null;
}

export async function listSourceRuns(sourceId: number): Promise<DocIngestRun[]> {
  return jsonFetch(`/api/docs/sources/${sourceId}/runs`);
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
  | 'reading'    // folder source: glob + per-file read from disk
  | 'gating'
  | 'chunking'
  | 'enriching'
  | 'embedding'
  | 'paused'
  | 'paused_limit'
  | 'cancelled'
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
  run_id?: number;
  state?: DocIngestRun['state'];
  files_changed?: number;
  files_unchanged?: number;
  files_skipped?: number;
  chunks_persisted?: number;
  embeddings_completed?: number;
  embeddings_pending?: number;
  enrichments_completed?: number;
  enrichments_pending?: number;
  searchable?: boolean;
  rate_per_sec?: number;
  eta_ms?: number | null;
  workers_active?: number;
  workers_configured?: number;
  extraction_ms?: number;
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
  run_id?: number;
  state?: 'paused' | 'paused_limit' | 'cancelled' | 'completed';
  searchable?: boolean;
}

export interface DocFolderPreview {
  files_found: number;
  files_to_process: number;
  cap: number;
  sample_pages: number;
  sample_pages_accepted: number;
  estimated_chunks: number;
  extractor: 'generic' | 'unity-script-reference';
  detected_doc_type: DocType;
  estimated_llm_calls: number;
  available_workers: number;
  configured_workers: number;
  progressive: boolean;
}

export async function dryRunFolder(input: {
  path: string;
  doc_type?: DocType;
  enrichment_mode?: 'selective' | 'all' | 'off';
  folder?: DocFolderConfig;
}): Promise<DocFolderPreview> {
  return jsonFetch('/api/docs/sources/dry-run/folder', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/**
 * Pre-flight summary emitido por `indexFolder` apenas (não vem em
 * URL/PDF). Mapeia 1:1 com `DocIngestScanSummary` no server. Permite
 * a UI mostrar "Encontrados N · vou processar M (cap K)" antes do
 * progress bar começar a se mexer.
 */
export interface DocIngestScanFrame {
  totalMatches: number;
  willProcess: number;
  cap: number;
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
    onScan?: (p: DocIngestScanFrame) => void;
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
    onScan?: (p: DocIngestScanFrame) => void;
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
    case 'scan':
      // Apenas folder sources emitem `scan`. URL/PDF não disparam — o
      // case existe pra evitar warning "unhandled event" + permitir a
      // UI mostrar pre-flight summary.
      cb.onScan?.(payload as DocIngestScanFrame);
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
