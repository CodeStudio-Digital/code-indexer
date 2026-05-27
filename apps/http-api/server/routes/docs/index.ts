/**
 * /api/docs/* — HTTP routes for the "Documentação" feature.
 *
 *   GET    /api/docs/collections                              list
 *   POST   /api/docs/collections                              create
 *   DELETE /api/docs/collections/:id                          drop (cascades chunks + vectors)
 *   GET    /api/docs/collections/:id/sources                  list sources
 *   POST   /api/docs/collections/:id/sources/url              add URL source + index
 *   POST   /api/docs/collections/:id/sources/pdf              upload PDF (multipart) + index
 *   GET    /api/docs/collections/:id/sources/:srcId           single source
 *   DELETE /api/docs/collections/:id/sources/:srcId           drop source
 *   POST   /api/docs/collections/:id/sources/:srcId/reindex   re-run ingestion (SSE)
 *   POST   /api/docs/sources/dry-run/url                      pre-flight estimate (URL)
 *   POST   /api/docs/sources/dry-run/pdf                      pre-flight estimate (PDF)
 *   POST   /api/docs/search                                   search test panel
 *
 * Auth: same `bearerMiddleware` as the rest of /api when enabled.
 *
 * Domain errors are mapped via `mapDocError` so route handlers stay terse.
 */
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { streamSSE } from 'hono/streaming';
import { accessSync, statSync, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { attachHeartbeat } from '../../../sse/SSEHeartbeat.js';
import {
  DocError,
  docErrorStatus,
  type DocIngestProgress,
} from '@mcp/services/services/docs/index.js';

/**
 * Set the response headers proxies need to pass `text/event-stream`
 * through immediately instead of buffering it. Hono's `streamSSE` already
 * sets `Content-Type: text/event-stream`, `Cache-Control: no-cache`, and
 * `Connection: keep-alive`; the extra `X-Accel-Buffering: no` is what
 * nginx / http-proxy (Vite dev) / Cloudflare key off of.
 */
function markUnbuffered(c: Context): void {
  c.header('X-Accel-Buffering', 'no');
}

function mapDocError(c: Context, err: unknown) {
  if (err instanceof DocError) {
    return c.json(
      { error: err.message, kind: err.kind },
      docErrorStatus(err.kind) as ContentfulStatusCode,
    );
  }
  throw err;
}

interface CreateCollectionBody {
  name: string;
  description?: string;
}

interface CreateUrlSourceBody {
  url: string;
  title?: string;
  crawl?: {
    enabled?: boolean;
    max_pages?: number;
    max_depth?: number;
    same_origin?: boolean;
    include_pattern?: string | null;
    exclude_pattern?: string | null;
    /** Migration 089: literal substring pin (e.g. `/6000.3/Documentation/Manual/`). */
    required_path?: string | null;
    /** Migration 092: run an LLM on the seed page to find URLs cheerio missed. */
    llm_extract_links?: boolean;
    /** Migration 099: bypass `EscalatingFetcher` heuristic and render every page via Chromium. */
    force_browser?: boolean;
    /** Migration 101: hybrid — Chromium only on the seed (depth=0), plain HTTP for every leaf. */
    browser_seed_only?: boolean;
  };
  /** Skip the actual ingestion, just create the row. Useful for the
   *  dashboard's "Save first, index later" flow. */
  defer_indexing?: boolean;
}

interface SearchBody {
  query: string;
  collection?: string;
  limit?: number;
  mode?: 'hybrid' | 'fts' | 'vector';
}

/**
 * Body de criação de source tipo `'folder'` (migration 103). Caminho
 * absoluto no FS do servidor + globs opcionais. Validado antes do
 * streamSSE pra retornar 400 estruturado em vez de explodir no meio
 * da stream.
 */
interface CreateFolderSourceBody {
  /** Absolute path no servidor. Obrigatório. */
  path: string;
  title?: string;
  folder?: {
    /** Default `**\/*.{html,htm,md,markdown,pdf,txt}`. */
    include_glob?: string | null;
    /** Default exclui `node_modules`, `.git`, `dist`, `build`, etc. */
    exclude_glob?: string | null;
    /** Default 5000, cap hard server-side 50000. */
    max_files?: number | null;
    /** Default true — pula LLM gate (docs locais geralmente curadas). */
    bypass_relevance_gate?: boolean;
  };
  /** Igual url/pdf: cria a row sem indexar (deferred). */
  defer_indexing?: boolean;
}

export function mountDocsRoutes(app: Hono, deps: ServerDeps): void {
  const { docStore, indexDocsUseCase, docHybridSearch, docProgressTracker } = deps;
  console.log('[doc-routes] mounted /api/docs/*');

  // ─── Collections ─────────────────────────────────────────────────

  app.get('/api/docs/collections', (c) => c.json(docStore.listCollections()));

  app.post('/api/docs/collections', async (c) => {
    const body = await parseJsonBody<CreateCollectionBody>(c);
    if (!body.name || typeof body.name !== 'string') {
      return c.json({ error: 'name is required' }, 400);
    }
    if (docStore.getCollectionByName(body.name)) {
      return c.json({ error: 'a collection with that name already exists' }, 409);
    }
    const created = docStore.createCollection({
      name: body.name.trim(),
      description: body.description?.trim() || null,
    });
    return c.json(created, 201);
  });

  app.get('/api/docs/collections/:id', (c) => {
    const found = docStore.getCollection(parseIdParam(c));
    if (!found) return notFound(c);
    return c.json(found);
  });

  app.delete('/api/docs/collections/:id', async (c) => {
    const id = parseIdParam(c);
    const existing = docStore.getCollection(id);
    if (!existing) return notFound(c);
    const result = await indexDocsUseCase.deleteCollection(id);
    return c.json({ ok: true, ...result });
  });

  // ─── Sources ─────────────────────────────────────────────────────

  app.get('/api/docs/collections/:id/sources', (c) => {
    const collectionId = parseIdParam(c);
    if (!docStore.getCollection(collectionId)) return notFound(c);
    return c.json(docStore.listSourcesByCollection(collectionId));
  });

  app.delete('/api/docs/collections/:id/sources/:srcId', async (c) => {
    const srcId = parseIdParam(c, 'srcId');
    const src = docStore.getSource(srcId);
    if (!src) return notFound(c);
    const result = await indexDocsUseCase.deleteSource(srcId);
    return c.json({ ok: true, ...result });
  });

  // POST /api/docs/collections/:id/sources/url — JSON body, immediate or
  // deferred ingestion. Streams progress when `Accept: text/event-stream`.
  app.post('/api/docs/collections/:id/sources/url', async (c) => {
    const collectionId = parseIdParam(c);
    const collection = docStore.getCollection(collectionId);
    if (!collection) return notFound(c);

    const body = await parseJsonBody<CreateUrlSourceBody>(c);
    if (!body.url || typeof body.url !== 'string') {
      return c.json({ error: 'url is required' }, 400);
    }

    if (body.defer_indexing) {
      try {
        const source = docStore.createSource({
          collection_id: collectionId,
          type: 'url',
          uri: body.url.trim(),
          title: body.title?.trim() || null,
          crawl: body.crawl,
        });
        return c.json(source, 201);
      } catch (err) {
        return mapDocError(c, err);
      }
    }

    const accept = c.req.header('accept') ?? '';
    if (accept.includes('text/event-stream')) {
      console.log(
        `[doc-indexer] route: SSE indexUrl collection=${collectionId} url=${body.url} crawl=${JSON.stringify(body.crawl ?? {})}`,
      );
      markUnbuffered(c);
      return streamSSE(c, async (stream) => {
        const stopHeartbeat = attachHeartbeat(stream);
        let seq = 0;
        const send = (event: string, data: unknown) =>
          stream.writeSSE({ id: String(seq++), event, data: JSON.stringify(data) });
        // Emit one frame immediately so the client sees the stream is live
        // even before the use-case fires its first event. Cures the
        // "Iniciando…" hang that proxies cause when the first real event
        // takes >5s (gate LLM batch, slow first fetch).
        await send('open', { ok: true, ts: Date.now() });
        try {
          await indexDocsUseCase.indexUrl(
            {
              collectionId,
              url: body.url!.trim(),
              title: body.title?.trim(),
              crawl: body.crawl,
            },
            {
              onStart: (p) => send('start', p),
              onProgress: (p) => send('progress', p),
              onDone: (r) => send('done', r),
              onError: (m) => send('error', { message: m }),
            },
          );
        } catch (err) {
          console.error(
            `[doc-indexer] route SSE failed collection=${collectionId} url=${body.url}: ${err instanceof Error ? err.message : String(err)}`,
          );
          send('error', { message: err instanceof Error ? err.message : String(err) });
        } finally {
          stopHeartbeat();
          await stream.close();
        }
      });
    }

    try {
      const result = await indexDocsUseCase.indexUrl({
        collectionId,
        url: body.url.trim(),
        title: body.title?.trim(),
        crawl: body.crawl,
      });
      return c.json(result, 201);
    } catch (err) {
      return mapDocError(c, err);
    }
  });

  // POST /api/docs/collections/:id/sources/pdf — multipart upload with field
  // `file` (the PDF bytes) and optional `title`. Always SSE-streamed because
  // a PDF can produce hundreds of chunks and the dashboard wants live counts.
  app.post('/api/docs/collections/:id/sources/pdf', async (c) => {
    const collectionId = parseIdParam(c);
    const collection = docStore.getCollection(collectionId);
    if (!collection) return notFound(c);

    let bytes: Uint8Array;
    let fileName: string;
    let title: string | undefined;
    try {
      const form = await c.req.parseBody();
      const file = form.file;
      if (!(file instanceof File)) {
        return c.json({ error: 'multipart field `file` is required' }, 400);
      }
      const ab = await file.arrayBuffer();
      bytes = new Uint8Array(ab);
      fileName = file.name || 'document.pdf';
      const rawTitle = form.title;
      if (typeof rawTitle === 'string') title = rawTitle.trim() || undefined;
    } catch (err) {
      return c.json({ error: `multipart parse failed: ${err instanceof Error ? err.message : String(err)}` }, 400);
    }

    const accept = c.req.header('accept') ?? '';
    if (accept.includes('text/event-stream')) {
      console.log(`[doc-indexer] route: SSE indexPdf collection=${collectionId} file=${fileName} bytes=${bytes.byteLength}`);
      markUnbuffered(c);
      return streamSSE(c, async (stream) => {
        const stopHeartbeat = attachHeartbeat(stream);
        let seq = 0;
        const send = (event: string, data: unknown) =>
          stream.writeSSE({ id: String(seq++), event, data: JSON.stringify(data) });
        await send('open', { ok: true, ts: Date.now() });
        try {
          await indexDocsUseCase.indexPdf(
            { collectionId, fileName, bytes, title },
            {
              onStart: (p) => send('start', p),
              onProgress: (p: DocIngestProgress) => send('progress', p),
              onDone: (r) => send('done', r),
              onError: (m) => send('error', { message: m }),
            },
          );
        } catch (err) {
          send('error', { message: err instanceof Error ? err.message : String(err) });
        } finally {
          stopHeartbeat();
          await stream.close();
        }
      });
    }

    try {
      const result = await indexDocsUseCase.indexPdf({ collectionId, fileName, bytes, title });
      return c.json(result, 201);
    } catch (err) {
      return mapDocError(c, err);
    }
  });

  // POST /api/docs/collections/:id/sources/folder — index uma pasta local
  // (migration 103). Body JSON, não multipart. Validação síncrona de
  // path absoluto + existe + é dir + readable ANTES do streamSSE pra
  // dar 400 estruturado em vez de explodir no meio da stream. Honra o
  // mesmo Accept: text/event-stream do PDF/URL pra UX consistente.
  app.post('/api/docs/collections/:id/sources/folder', async (c) => {
    const collectionId = parseIdParam(c);
    const collection = docStore.getCollection(collectionId);
    if (!collection) return notFound(c);

    const body = await parseJsonBody<CreateFolderSourceBody>(c);
    if (!body.path || typeof body.path !== 'string') {
      return c.json({ error: 'path is required' }, 400);
    }
    const rawPath = body.path.trim();
    // Validação síncrona — defense-in-depth. Sem absoluto não dá pra
    // distinguir CWD do server (que pode ser qualquer coisa).
    if (!path.isAbsolute(rawPath)) {
      return c.json(
        { error: 'path_invalid', detail: 'path must be absolute' },
        400,
      );
    }
    let stat;
    try {
      stat = statSync(rawPath);
    } catch (err) {
      return c.json(
        {
          error: 'path_invalid',
          detail: `cannot stat path: ${err instanceof Error ? err.message : String(err)}`,
        },
        400,
      );
    }
    if (!stat.isDirectory()) {
      return c.json(
        { error: 'path_invalid', detail: 'path is not a directory' },
        400,
      );
    }
    try {
      accessSync(rawPath, fsConstants.R_OK);
    } catch {
      return c.json(
        { error: 'path_invalid', detail: 'path is not readable' },
        400,
      );
    }

    const title = body.title?.trim() || undefined;

    if (body.defer_indexing) {
      try {
        const source = docStore.createSource({
          collection_id: collectionId,
          type: 'folder',
          uri: `folder://${rawPath}`,
          title: title ?? null,
          folder_root_path: rawPath,
          folder: body.folder,
        });
        return c.json(source, 201);
      } catch (err) {
        return mapDocError(c, err);
      }
    }

    const accept = c.req.header('accept') ?? '';
    if (accept.includes('text/event-stream')) {
      console.log(
        `[doc-indexer] route: SSE indexFolder collection=${collectionId} path=${rawPath} folder=${JSON.stringify(body.folder ?? {})}`,
      );
      markUnbuffered(c);
      return streamSSE(c, async (stream) => {
        const stopHeartbeat = attachHeartbeat(stream);
        let seq = 0;
        const send = (event: string, data: unknown) =>
          stream.writeSSE({ id: String(seq++), event, data: JSON.stringify(data) });
        await send('open', { ok: true, ts: Date.now() });
        try {
          await indexDocsUseCase.indexFolder(
            {
              collectionId,
              rootPath: rawPath,
              title,
              folder: body.folder,
            },
            {
              onStart: (p) => send('start', p),
              // Pre-flight: emite ANTES do primeiro `progress` pra UI
              // mostrar "Encontrados N · vou processar M (cap K)" sem
              // esperar o glob terminar.
              onScan: (p) => send('scan', p),
              onProgress: (p) => send('progress', p),
              onDone: (r) => send('done', r),
              onError: (m) => send('error', { message: m }),
            },
          );
        } catch (err) {
          send('error', { message: err instanceof Error ? err.message : String(err) });
        } finally {
          stopHeartbeat();
          await stream.close();
        }
      });
    }

    try {
      const result = await indexDocsUseCase.indexFolder({
        collectionId,
        rootPath: rawPath,
        title,
        folder: body.folder,
      });
      return c.json(result, 201);
    } catch (err) {
      return mapDocError(c, err);
    }
  });

  // POST /api/docs/collections/:id/sources/:srcId/reindex — re-run ingestion
  // for an existing source. Always SSE (same shape as the URL POST above).
  app.post('/api/docs/collections/:id/sources/:srcId/reindex', async (c) => {
    const srcId = parseIdParam(c, 'srcId');
    const src = docStore.getSource(srcId);
    if (!src) return notFound(c);
    if (src.type === 'pdf') {
      return c.json(
        { error: 'PDF reindex requires a fresh upload (the binary is not retained)' },
        400,
      );
    }
    // folder + url ambos suportam re-index via leitura da própria row.
    console.log(`[doc-indexer] route: SSE reindex source=${src.id} type=${src.type} uri=${src.uri}`);
    markUnbuffered(c);
    return streamSSE(c, async (stream) => {
      const stopHeartbeat = attachHeartbeat(stream);
      let seq = 0;
      const send = (event: string, data: unknown) =>
        stream.writeSSE({ id: String(seq++), event, data: JSON.stringify(data) });
      await send('open', { ok: true, ts: Date.now() });
      try {
        if (src.type === 'folder') {
          // Validar que a pasta ainda existe — se o operador moveu/
          // apagou desde o último run, dar erro claro em vez de SSE
          // mudo. `folder_root_path` é a fonte de verdade pra re-index
          // (uri é `folder://<path>` mas pode haver normalização);
          // fallback para slice do uri se a coluna estiver vazia em
          // rows antigas (defesa em profundidade).
          const rootPath =
            src.folder_root_path ?? src.uri.replace(/^folder:\/\//, '');
          try {
            const stat = statSync(rootPath);
            if (!stat.isDirectory()) {
              send('error', { message: `re-index failed: path is no longer a directory (${rootPath})` });
              return;
            }
          } catch (err) {
            send('error', {
              message:
                `re-index failed: folder no longer exists at ${rootPath} ` +
                `(${err instanceof Error ? err.message : String(err)})`,
            });
            return;
          }
          await indexDocsUseCase.indexFolder(
            {
              collectionId: src.collection_id,
              rootPath,
              title: src.title ?? undefined,
              // Sem passar `folder` aqui — `ensureSource` vai achar a
              // row existente e os campos folder_* persistidos serão
              // lidos automaticamente.
            },
            {
              onStart: (p) => send('start', p),
              onScan: (p) => send('scan', p),
              onProgress: (p) => send('progress', p),
              onDone: (r) => send('done', r),
              onError: (m) => send('error', { message: m }),
            },
          );
        } else {
          await indexDocsUseCase.indexUrl(
            {
              collectionId: src.collection_id,
              url: src.uri,
              title: src.title ?? undefined,
              crawl: {
                enabled: src.crawl_enabled,
                max_pages: src.crawl_max_pages,
                max_depth: src.crawl_max_depth,
                same_origin: src.crawl_same_origin,
                include_pattern: src.crawl_include_pattern,
                exclude_pattern: src.crawl_exclude_pattern,
                required_path: src.crawl_required_path,
                llm_extract_links: src.crawl_llm_extract_links,
              },
            },
            {
              onStart: (p) => send('start', p),
              onProgress: (p) => send('progress', p),
              onDone: (r) => send('done', r),
              onError: (m) => send('error', { message: m }),
            },
          );
        }
      } catch (err) {
        send('error', { message: err instanceof Error ? err.message : String(err) });
      } finally {
        stopHeartbeat();
        await stream.close();
      }
    });
  });

  // ─── Dry-run estimates ───────────────────────────────────────────

  app.post('/api/docs/sources/dry-run/url', async (c) => {
    const body = await parseJsonBody<CreateUrlSourceBody>(c);
    if (!body.url) return c.json({ error: 'url is required' }, 400);
    try {
      const estimate = await indexDocsUseCase.dryRunUrl({
        collectionId: 0,
        url: body.url.trim(),
        crawl: body.crawl,
      });
      return c.json(estimate);
    } catch (err) {
      return mapDocError(c, err);
    }
  });

  app.post('/api/docs/sources/dry-run/pdf', async (c) => {
    try {
      const form = await c.req.parseBody();
      const file = form.file;
      if (!(file instanceof File)) {
        return c.json({ error: 'multipart field `file` is required' }, 400);
      }
      const ab = await file.arrayBuffer();
      const bytes = new Uint8Array(ab);
      const estimate = await indexDocsUseCase.dryRunPdf({
        collectionId: 0,
        fileName: file.name || 'document.pdf',
        bytes,
      });
      return c.json(estimate);
    } catch (err) {
      return mapDocError(c, err);
    }
  });

  // ─── Re-embed missing ────────────────────────────────────────────

  app.post('/api/docs/embeddings/retry', async (c) => {
    try {
      const result = await indexDocsUseCase.retryEmbeddings();
      return c.json(result);
    } catch (err) {
      return mapDocError(c, err);
    }
  });

  // Per-source retry. SSE-streamed because a stuck source can have
  // thousands of missing chunks and the UI wants live progress in the
  // same `IndexProgressStream` dialog used for fresh ingests. The
  // ProgressTracker side-channel also fills (see retryEmbeddings),
  // so the SourceList row's live bar lights up too.
  app.post('/api/docs/sources/:srcId/embeddings/retry', async (c) => {
    const srcId = parseIdParam(c, 'srcId');
    const src = docStore.getSource(srcId);
    if (!src) return notFound(c);
    // `?force=1` wipes existing embedding state first. Used when the
    // remote vector store silently rejected previous upserts (badge
    // still says embedded but the search returns 0). Without force,
    // we only target chunks where `embedding_hash IS NULL`.
    const force = c.req.query('force') === '1';
    console.log(`[doc-indexer] route: SSE retry-embed source=${srcId} force=${force}`);
    markUnbuffered(c);
    return streamSSE(c, async (stream) => {
      const stopHeartbeat = attachHeartbeat(stream);
      let seq = 0;
      const send = (event: string, data: unknown) =>
        stream.writeSSE({ id: String(seq++), event, data: JSON.stringify(data) });
      await send('open', { ok: true, ts: Date.now() });
      try {
        const result = await indexDocsUseCase.retryEmbeddings(
          { sourceId: srcId, force },
          {
            onProgress: (p) => send('progress', { ...p, chunks_indexed: p.total }),
          },
        );
        send('done', {
          source_id: srcId,
          chunks_indexed: result.total,
          pages_fetched: 0,
          pages_accepted: 0,
          pages_rejected: 0,
          pages_via_browser: 0,
          cost_usd: 0,
          elapsed_ms: 0,
          ...result,
        });
      } catch (err) {
        console.error(
          `[doc-indexer] retry-embed failed source=${srcId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        send('error', { message: err instanceof Error ? err.message : String(err) });
      } finally {
        stopHeartbeat();
        await stream.close();
      }
    });
  });

  // Per-collection retry. Same shape as per-source but scopes the
  // listChunksMissingEmbedding query to a collection_id.
  app.post('/api/docs/collections/:id/embeddings/retry', async (c) => {
    const collectionId = parseIdParam(c);
    const collection = docStore.getCollection(collectionId);
    if (!collection) return notFound(c);
    console.log(`[doc-indexer] route: SSE retry-embed collection=${collectionId}`);
    markUnbuffered(c);
    return streamSSE(c, async (stream) => {
      const stopHeartbeat = attachHeartbeat(stream);
      let seq = 0;
      const send = (event: string, data: unknown) =>
        stream.writeSSE({ id: String(seq++), event, data: JSON.stringify(data) });
      await send('open', { ok: true, ts: Date.now() });
      try {
        const result = await indexDocsUseCase.retryEmbeddings(
          { collectionId },
          {
            onProgress: (p) => send('progress', { ...p, chunks_indexed: p.total }),
          },
        );
        send('done', {
          source_id: 0,
          chunks_indexed: result.total,
          pages_fetched: 0,
          pages_accepted: 0,
          pages_rejected: 0,
          pages_via_browser: 0,
          cost_usd: 0,
          elapsed_ms: 0,
          ...result,
        });
      } catch (err) {
        console.error(
          `[doc-indexer] retry-embed collection failed collection=${collectionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        send('error', { message: err instanceof Error ? err.message : String(err) });
      } finally {
        stopHeartbeat();
        await stream.close();
      }
    });
  });

  // ─── Live progress poll ─────────────────────────────────────────
  //
  // The UI's SourceList polls this every 2s for rows whose `status` is
  // `fetching|indexing`, so the user can see "Enriquecendo: 1234/6331"
  // in the table without having to keep an SSE stream open. The route
  // joins the in-memory snapshot from `DocIngestProgressTracker` with
  // the persisted `doc_sources.status` so consumers don't need a
  // separate call to know whether the run is active or just finished.
  app.get('/api/docs/sources/:srcId/progress', (c) => {
    const srcId = parseIdParam(c, 'srcId');
    const src = docStore.getSource(srcId);
    if (!src) return notFound(c);
    const snapshot = docProgressTracker.get(srcId);
    const active = src.status === 'fetching' || src.status === 'indexing';
    return c.json({ active, status: src.status, snapshot });
  });

  // ─── Health snapshot (post-completion stats) ────────────────────
  //
  // Read-only join over `doc_chunks` + `doc_chunk_vectors`. UI uses
  // this to show "✓ 6331/6331 embedded" or "⚠ 50 missing → [Re-embed]"
  // after a run completes. Cheap (3 small SELECTs); poll on demand,
  // not on a timer.
  app.get('/api/docs/sources/:srcId/health', (c) => {
    const srcId = parseIdParam(c, 'srcId');
    const health = docStore.getSourceHealth(srcId);
    if (!health) return notFound(c);
    return c.json(health);
  });

  // ─── Vector tombstone sweep (admin / debug) ─────────────────────
  //
  // Drains the `doc_vector_tombstones` retry queue — the boot path
  // already does this opportunistically; this endpoint exists so the
  // admin can force a drain after fixing whatever broke the vector
  // store, without restarting the server.
  app.get('/api/docs/vectors/pending', (c) => {
    return c.json({ pending: docStore.countPendingTombstones() });
  });

  app.post('/api/docs/vectors/sweep', async (c) => {
    try {
      const result = await indexDocsUseCase.sweepTombstones();
      return c.json(result);
    } catch (err) {
      return mapDocError(c, err);
    }
  });

  // ─── Diagnose vector pipeline ───────────────────────────────────
  //
  // The single-shot answer to "why is VECTOR:0 even though the badge
  // says embedded?". Probes the vector store end-to-end:
  //   - is the store wired and responding to isAvailable?
  //   - does embedQuery actually return a vector?
  //   - does search() return ANY hit with no filter?
  //   - does the corpus filter narrow it correctly?
  //   - does adding collection filter zero out (= Cloudflare metadata
  //     index wasn't declared at provisioning time)?
  //
  // Pass `?collection=NAME` to test the collection filter; otherwise
  // probes only corpus+type.
  app.post('/api/docs/vectors/diagnose', async (c) => {
    const body = await parseJsonBody<{ query?: string; collection?: string }>(c);
    const probeQuery = body.query ?? 'rigidbody physics raycast collider';
    const probeCollection = body.collection ?? undefined;
    const { embeddingService, vectorStore, docStore } = deps;

    type Step = { name: string; ok: boolean; detail?: unknown; error?: string };
    const steps: Step[] = [];

    // (1) Local mapping count.
    try {
      const count = docStore.countVectorMappings();
      steps.push({ name: 'sqlite_vector_mappings', ok: true, detail: { count } });
    } catch (e) {
      steps.push({ name: 'sqlite_vector_mappings', ok: false, error: (e as Error).message });
    }

    // (2) Vector store availability probe.
    if (!vectorStore) {
      steps.push({ name: 'vector_store', ok: false, error: 'no vectorStore wired (NullVectorStore?)' });
      return c.json({ probeQuery, probeCollection, steps });
    }
    try {
      const alive = await vectorStore.isAvailable();
      steps.push({ name: 'vector_store_available', ok: alive, detail: { kind: deps.vectorStoreKind } });
    } catch (e) {
      steps.push({ name: 'vector_store_available', ok: false, error: (e as Error).message });
    }

    // (3) Embed the probe query.
    if (!embeddingService) {
      steps.push({ name: 'embedder', ok: false, error: 'no embeddingService wired' });
      return c.json({ probeQuery, probeCollection, steps });
    }
    let queryVec: number[] = [];
    try {
      const r = await embeddingService.embedQuery(probeQuery);
      queryVec = r.vector;
      steps.push({
        name: 'embed_query',
        ok: queryVec.length > 0,
        detail: { dim: queryVec.length, kind: deps.embeddingKind },
      });
    } catch (e) {
      steps.push({ name: 'embed_query', ok: false, error: (e as Error).message });
      return c.json({ probeQuery, probeCollection, steps });
    }
    if (queryVec.length === 0) {
      return c.json({ probeQuery, probeCollection, steps });
    }

    // (4-6) Three searches with progressively narrower filters.
    const trySearch = async (label: string, filter: Record<string, string> | undefined) => {
      try {
        const matches = await vectorStore.search(queryVec, { topK: 5, filter });
        steps.push({
          name: label,
          ok: true,
          detail: {
            count: matches.length,
            sample: matches.slice(0, 3).map((m) => ({
              id: m.id,
              score: m.score,
              metadata: m.metadata,
            })),
          },
        });
      } catch (e) {
        steps.push({ name: label, ok: false, error: (e as Error).message });
      }
    };
    await trySearch('search_no_filter', undefined);
    await trySearch('search_corpus_only', { corpus: 'docs' });
    await trySearch('search_corpus_type', { corpus: 'docs', type: 'doc_chunk' });
    if (probeCollection) {
      await trySearch('search_with_collection', { corpus: 'docs', type: 'doc_chunk', collection: probeCollection });
    }

    return c.json({ probeQuery, probeCollection, steps });
  });

  // ─── Search ──────────────────────────────────────────────────────

  app.post('/api/docs/search', async (c) => {
    const body = await parseJsonBody<SearchBody>(c);
    if (!body.query || typeof body.query !== 'string') {
      return c.json({ error: 'query is required' }, 400);
    }
    try {
      const result = await docHybridSearch.search({
        query: body.query,
        collection: typeof body.collection === 'string' ? body.collection : undefined,
        limit: typeof body.limit === 'number' ? body.limit : undefined,
        mode: body.mode,
      });
      return c.json(result);
    } catch (err) {
      return mapDocError(c, err);
    }
  });
}
