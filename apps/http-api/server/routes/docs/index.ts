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
import type { HttpContext, HttpRouter } from '@mcp/shared/http/router.js';
import { streamSSE } from '@mcp/shared/http/sse.js';
import { accessSync, statSync, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { mountDocsProjectLinkRoutes } from './project-links.js';
import { attachHeartbeat } from '../../../sse/SSEHeartbeat.js';
import {
  DocError,
  docErrorStatus,
  chunkMarkdown,
  heuristicAccepts,
  readFolderEntry,
  scanFolderFiles,
  availableDocExtractionWorkers,
  resolveDocWorkerCount,
  type DocIngestProgress,
} from '@mcp/services/services/docs/index.js';
import { coerceDocType } from '@mcp/store/doc-store.js';
import { embedQueryForNamespace } from '@mcp/indexer/search/embeddings.js';
import { docNamespace } from '@mcp/shared/vector-namespace.js';

/**
 * Set the response headers proxies need to pass `text/event-stream`
 * through immediately instead of buffering it. HttpRouter's `streamSSE` already
 * sets `Content-Type: text/event-stream`, `Cache-Control: no-cache`, and
 * `Connection: keep-alive`; the extra `X-Accel-Buffering: no` is what
 * nginx / http-proxy (Vite dev) / Cloudflare key off of.
 */
function markUnbuffered(c: HttpContext): void {
  c.header('X-Accel-Buffering', 'no');
}

function mapDocError(c: HttpContext, err: unknown) {
  if (err instanceof DocError) {
    return c.json(
      { error: err.message, kind: err.kind },
      docErrorStatus(err.kind),
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
  /** Documentation type (migration 149); coerced to a valid DocType server-side. */
  doc_type?: string;
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
  /** Documentation type (migration 149); coerced to a valid DocType server-side. */
  doc_type?: string;
  enrichment_mode?: 'selective' | 'all' | 'off';
  folder?: {
    /** Default `**\/*.{html,htm,md,markdown,pdf,txt}`. */
    include_glob?: string | null;
    /** Default exclui `node_modules`, `.git`, `dist`, `build`, etc. */
    exclude_glob?: string | null;
    /** Default 5000, cap hard server-side 50000. */
    max_files?: number | null;
    /** Default true — pula LLM gate (docs locais geralmente curadas). */
    bypass_relevance_gate?: boolean;
    performance_profile?: 'economy' | 'balanced' | 'maximum' | 'custom';
    worker_count?: number | null;
  };
  /** Igual url/pdf: cria a row sem indexar (deferred). */
  defer_indexing?: boolean;
}

export function mountDocsRoutes(app: HttpRouter, deps: ServerDeps): void {
  const { docStore, indexDocsUseCase, docHybridSearch, docProgressTracker } = deps;
  console.log('[doc-routes] mounted /api/docs/*');

  // Project ↔ collection links (migration 134) — sub-mounted to keep this
  // file under control.
  mountDocsProjectLinkRoutes(app, deps);

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
          doc_type: coerceDocType(body.doc_type),
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
              docType: coerceDocType(body.doc_type),
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
        docType: coerceDocType(body.doc_type),
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
    let docType: string | undefined;
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
      const rawDocType = form.doc_type;
      if (typeof rawDocType === 'string') docType = rawDocType;
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
            { collectionId, fileName, bytes, title, docType: coerceDocType(docType) },
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
      const result = await indexDocsUseCase.indexPdf({ collectionId, fileName, bytes, title, docType: coerceDocType(docType) });
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
          doc_type: coerceDocType(body.doc_type),
          folder_root_path: rawPath,
          folder: body.folder,
          enrichment_mode: body.enrichment_mode,
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
              docType: coerceDocType(body.doc_type),
              enrichmentMode: body.enrichment_mode,
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
        docType: coerceDocType(body.doc_type),
        enrichmentMode: body.enrichment_mode,
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
              docType: src.doc_type,
              enrichmentMode: src.enrichment_mode,
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
    // `?force=1` wipes accepted embedding state first. Used when local
    // vectors need to be rebuilt despite a previously accepted hash.
    // Without force, semantic_items selects only chunks missing from the
    // current generation (or whose content hash changed).
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

  // Per-collection retry. Same shape as per-source, scoped through the
  // collection namespace's semantic_items ledger.
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
    const activeRun = docStore.getActiveIngestRun(srcId);
    const active = !!activeRun || src.status === 'fetching' || src.status === 'indexing';
    return c.json({ active, status: src.status, run: activeRun, snapshot });
  });

  app.post('/api/docs/sources/dry-run/folder', async (c) => {
    const body = await parseJsonBody<CreateFolderSourceBody>(c);
    const rootPath = body.path?.trim();
    if (!rootPath || !path.isAbsolute(rootPath)) return c.json({ error: 'absolute path is required' }, 400);
    try {
      const stat = statSync(rootPath);
      if (!stat.isDirectory()) return c.json({ error: 'path is not a directory' }, 400);
      const scan = await scanFolderFiles({
        rootPath,
        includeGlob: body.folder?.include_glob,
        excludeGlob: body.folder?.exclude_glob,
        maxFiles: body.folder?.max_files,
      });
      const samples = scan.entries.slice(0, 8);
      let samplePages = 0;
      let sampleChunks = 0;
      let accepted = 0;
      let extractor: 'generic' | 'unity-script-reference' = /[\\/]ScriptReference(?:[\\/]|$)/i.test(rootPath)
        ? 'unity-script-reference'
        : 'generic';
      for (const entry of samples) {
        const read = await readFolderEntry(entry, rootPath, 0);
        if (typeof read === 'string') continue;
        for (const page of read) {
          samplePages++;
          if (page.extractor) extractor = page.extractor;
          if (!heuristicAccepts(page).accept) continue;
          accepted++;
          sampleChunks += chunkMarkdown(page.markdown, { defaultRootTitle: page.title ?? 'Document' }).length;
        }
      }
      const avgChunks = accepted > 0 ? sampleChunks / accepted : 0;
      const estimatedChunks = Math.round(avgChunks * scan.entries.length);
      const detectedType = extractor === 'unity-script-reference' ? 'api_reference' : coerceDocType(body.doc_type);
      const mode = body.enrichment_mode ?? 'selective';
      return c.json({
        files_found: scan.totalMatches,
        files_to_process: scan.entries.length,
        cap: scan.cap,
        sample_pages: samplePages,
        sample_pages_accepted: accepted,
        estimated_chunks: estimatedChunks,
        extractor,
        detected_doc_type: detectedType,
        estimated_llm_calls: mode === 'off' || detectedType === 'api_reference' ? 0 : Math.ceil(estimatedChunks / 8),
        available_workers: availableDocExtractionWorkers(),
        configured_workers: resolveDocWorkerCount(body.folder?.performance_profile, body.folder?.worker_count),
        progressive: true,
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.get('/api/docs/sources/:srcId/runs', (c) => {
    const srcId = parseIdParam(c, 'srcId');
    if (!docStore.getSource(srcId)) return notFound(c);
    const limit = Number(c.req.query('limit') ?? 20);
    return c.json(docStore.listIngestRuns(srcId, Number.isFinite(limit) ? limit : 20));
  });

  app.post('/api/docs/sources/:srcId/index/cancel', (c) => {
    const srcId = parseIdParam(c, 'srcId');
    if (!docStore.getSource(srcId)) return notFound(c);
    const requested = docStore.requestIngestCancel(srcId);
    return c.json({ source_id: srcId, cancel_requested: requested }, requested ? 202 : 409);
  });

  app.post('/api/docs/sources/:srcId/index/pause', (c) => {
    const srcId = parseIdParam(c, 'srcId');
    if (!docStore.getSource(srcId)) return notFound(c);
    const requested = docStore.requestIngestPause(srcId);
    return c.json({ source_id: srcId, pause_requested: requested }, requested ? 202 : 409);
  });

  app.post('/api/docs/sources/:srcId/index/performance', async (c) => {
    const srcId = parseIdParam(c, 'srcId');
    const src = docStore.getSource(srcId);
    if (!src) return notFound(c);
    if (src.type !== 'folder') return c.json({ error: 'performance profiles apply only to folder sources' }, 400);
    const body = await parseJsonBody<{ profile?: string; worker_count?: number | null }>(c);
    const profile = body.profile === 'economy' || body.profile === 'maximum' || body.profile === 'custom'
      ? body.profile
      : 'balanced';
    const workers = resolveDocWorkerCount(profile, body.worker_count);
    const activeRunUpdated = docStore.updateIngestPerformance(srcId, profile, workers);
    return c.json({ source_id: srcId, profile, worker_count: workers, active_run_updated: activeRunUpdated });
  });

  app.post('/api/docs/sources/:srcId/index/resume', (c) => {
    const srcId = parseIdParam(c, 'srcId');
    const src = docStore.getSource(srcId);
    if (!src) return notFound(c);
    if (src.type !== 'folder') {
      return c.json({ error: 'resume currently applies to incremental folder sources; use reindex for URL/PDF' }, 400);
    }
    const resumable = docStore.listIngestRuns(srcId, 20).find((candidate) =>
      candidate.state === 'paused' || candidate.state === 'paused_limit');
    if (!resumable) return c.json({ error: 'no paused run is available to resume' }, 409);
    const rootPath = src.folder_root_path ?? src.uri.replace(/^folder:\/\//, '');
    const promise = indexDocsUseCase.indexFolder({
      collectionId: src.collection_id,
      rootPath,
      title: src.title ?? undefined,
      docType: src.doc_type,
      enrichmentMode: src.enrichment_mode,
      resumeRunId: resumable.id,
    });
    void promise.catch((error) => {
      console.error(`[doc-indexer] resume source=${srcId} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    const run = docStore.getActiveIngestRun(srcId);
    return c.json({ source_id: srcId, accepted: true, run_id: run?.id ?? resumable.id }, 202);
  });

  // ─── Health snapshot (post-completion stats) ────────────────────
  //
  // Read-only snapshot over the active semantic_items generation. UI uses
  // this to show "✓ 6331/6331 embedded" or "⚠ 50 missing → [Re-embed]"
  // after a run completes. Cheap (3 small SELECTs); poll on demand,
  // not on a timer.
  app.get('/api/docs/sources/:srcId/health', (c) => {
    const srcId = parseIdParam(c, 'srcId');
    const health = docStore.getSourceHealth(srcId);
    if (!health) return notFound(c);
    return c.json(health);
  });

  // ─── Diagnose vector pipeline ───────────────────────────────────
  //
  // Probes each collection's active immutable namespace generation. A docs
  // collection may still serve an older model while another collection has
  // already activated the replacement, so both embedding and search must be
  // pinned independently per `docs:c<ID>`. "No filter" below means no metadata
  // filter; it never means a cross-namespace vector search.
  app.post('/api/docs/vectors/diagnose', async (c) => {
    const body = await parseJsonBody<{ query?: string; collection?: string | number }>(c);
    const probeQuery = body.query?.trim() || 'rigidbody physics raycast collider';
    const selector = body.collection == null ? null : String(body.collection).trim();
    const { vectorStore, docStore, semanticProfileRuntime } = deps;

    type Step = { name: string; ok: boolean; detail?: unknown; error?: string };
    const steps: Step[] = [];
    const selected = selector
      ? [(/^\d+$/.test(selector)
          ? docStore.getCollection(Number(selector))
          : docStore.getCollectionByName(selector))]
          .filter((collection): collection is NonNullable<typeof collection> => collection !== null)
      : docStore.listCollections();
    if (selector && selected.length === 0) {
      return c.json({ error: `documentation collection not found: ${selector}` }, 404);
    }

    // Store availability is process-wide; embeddings and searches below are
    // still collection-specific because their generations/dimensions may differ.
    try {
      const alive = await vectorStore.isAvailable();
      steps.push({ name: 'vector_store_available', ok: alive, detail: { kind: deps.vectorStoreKind } });
    } catch (e) {
      steps.push({ name: 'vector_store_available', ok: false, error: (e as Error).message });
    }

    const queryEmbedding = semanticProfileRuntime.queryEmbedding('docs');
    const namespaces: Array<{
      namespace: string;
      collection: { id: number; name: string };
      generationId: number | null;
      steps: Step[];
    }> = [];
    for (const collection of selected) {
      const namespace = docNamespace(collection.id);
      const namespaceSteps: Step[] = [];
      const diagnostic = {
        namespace,
        collection: { id: collection.id, name: collection.name },
        generationId: null as number | null,
        steps: namespaceSteps,
      };
      namespaces.push(diagnostic);

      // Active-generation logical coverage comes from semantic_items, not the
      // retired doc_chunk_vectors/embedding mirror columns.
      try {
        const count = docStore.countIndexedVectorsByCollection(collection.id);
        namespaceSteps.push({
          name: 'semantic_items_active',
          ok: true,
          detail: { count },
        });
      } catch (e) {
        namespaceSteps.push({ name: 'semantic_items_active', ok: false, error: (e as Error).message });
      }

      let queryVec: number[];
      let generationId: number;
      try {
        const result = await embedQueryForNamespace(queryEmbedding, namespace, probeQuery);
        if (!Number.isSafeInteger(result.generationId) || result.generationId! < 1) {
          throw new Error(`active query embedding did not return a generation for ${namespace}`);
        }
        queryVec = result.vector;
        generationId = result.generationId!;
        diagnostic.generationId = generationId;
        namespaceSteps.push({
          name: 'embed_query',
          ok: queryVec.length > 0,
          detail: { dim: queryVec.length, generationId, kind: deps.embeddingKind },
          error: queryVec.length === 0 ? 'embedding returned empty vector' : undefined,
        });
      } catch (e) {
        namespaceSteps.push({ name: 'embed_query', ok: false, error: (e as Error).message });
        continue;
      }
      if (queryVec.length === 0) continue;

      const trySearch = async (label: string, filter?: Record<string, string>) => {
        try {
          const matches = await vectorStore.search(queryVec, {
            topK: 5,
            filter,
            namespace,
            generationId,
          });
          namespaceSteps.push({
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
          namespaceSteps.push({ name: label, ok: false, error: (e as Error).message });
        }
      };
      await trySearch('search_no_filter');
      await trySearch('search_corpus_only', { corpus: 'docs' });
      await trySearch('search_corpus_type', { corpus: 'docs', type: 'doc_chunk' });
      await trySearch('search_with_collection', {
        corpus: 'docs',
        type: 'doc_chunk',
        collection: collection.name,
      });
    }

    return c.json({ probeQuery, probeCollection: selector, steps, namespaces });
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
