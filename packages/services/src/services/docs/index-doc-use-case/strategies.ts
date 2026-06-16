import { PDF_MAX_BYTES, parsePdf } from '../pdf-parser.js';
import { crawlUrl } from '../crawler.js';
import {
  readFolder,
  FOLDER_HARD_MAX_FILES,
  FOLDER_DEFAULT_INCLUDE_GLOB,
  FOLDER_DEFAULT_EXCLUDE_GLOB,
  type FolderReaderEvent,
} from '../folder-reader.js';
import { DocError } from '../errors.js';
import { ensureSource, estimateFromPages, requireCollection } from './source-helpers.js';
import { runIngest } from './run-ingest.js';
import { defaultCrawlConfig, normalizeSeedUrl, sanitizeFileName, stripExtension } from './utils.js';
import {
  type IndexDocStreamCallbacks,
  type IndexDocUseCaseDeps,
  type IndexFolderInput,
  type IndexPdfInput,
  type IndexUrlInput,
} from './types.js';
import type { DocIngestEstimate, DocIngestProgress, DocIngestResult } from '../types.js';

// ─── PDF ─────────────────────────────────────────────────────────

export async function indexPdf(
  deps: IndexDocUseCaseDeps,
  input: IndexPdfInput,
  callbacks?: IndexDocStreamCallbacks,
): Promise<DocIngestResult> {
  const collection = requireCollection(deps.docStore, input.collectionId);
  if (input.bytes.byteLength > PDF_MAX_BYTES) {
    throw new DocError('too_large', `PDF exceeds ${PDF_MAX_BYTES} bytes`);
  }
  const uri = `pdf://${sanitizeFileName(input.fileName)}`;
  const source = ensureSource(deps.docStore, {
    collection_id: collection.id,
    type: 'pdf',
    uri,
    title: input.title ?? stripExtension(input.fileName),
    doc_type: input.docType,
    pdf_size_bytes: input.bytes.byteLength,
  });
  return runIngest(deps, collection, source, async () => {
    return parsePdf(input.bytes, { sourceId: source.id, sourceUri: uri, titleHint: stripExtension(input.fileName) });
  }, callbacks);
}

export async function dryRunPdf(input: IndexPdfInput): Promise<DocIngestEstimate> {
  if (input.bytes.byteLength > PDF_MAX_BYTES) {
    throw new DocError('too_large', `PDF exceeds ${PDF_MAX_BYTES} bytes`);
  }
  const pages = await parsePdf(input.bytes, {
    sourceId: 0,
    sourceUri: `pdf://${sanitizeFileName(input.fileName)}`,
    titleHint: stripExtension(input.fileName),
  });
  return estimateFromPages(pages);
}

// ─── URL ─────────────────────────────────────────────────────────

export async function indexUrl(
  deps: IndexDocUseCaseDeps,
  input: IndexUrlInput,
  callbacks?: IndexDocStreamCallbacks,
): Promise<DocIngestResult> {
  const collection = requireCollection(deps.docStore, input.collectionId);
  const normalizedUrl = normalizeSeedUrl(input.url);
  if (!normalizedUrl) throw new DocError('bad_request', `Invalid URL: "${input.url}"`);

  const source = ensureSource(deps.docStore, {
    collection_id: collection.id,
    type: 'url',
    uri: normalizedUrl,
    title: input.title ?? null,
    doc_type: input.docType,
    crawl: input.crawl,
  });
  return runIngest(deps, collection, source, async () => {
    return crawlUrl({
      seedUrl: normalizedUrl,
      sourceId: source.id,
      crawl: input.crawl ?? defaultCrawlConfig(source),
      renderer: deps.renderBackend,
      // Forward the resolver only when the crawl wants LLM-assisted link
      // extraction. The crawler still falls back gracefully when the binding
      // is missing.
      linkExtractorResolver: deps.pipelineProviderResolver,
      resolveContext: deps.resolveContext,
      onPageFetched: ({ totalFetched, ok, reason }) => {
        const frame: DocIngestProgress = {
          phase: 'fetching',
          current: totalFetched,
          total: input.crawl?.max_pages ?? 1,
          label: reason ?? '',
          pages_fetched: totalFetched,
        };
        deps.progressTracker?.put(source.id, frame);
        void callbacks?.onProgress?.(frame);
      },
    });
  }, callbacks);
}

export async function dryRunUrl(input: IndexUrlInput): Promise<DocIngestEstimate> {
  const crawl = input.crawl ?? { enabled: false, max_pages: 1, max_depth: 0, same_origin: true };
  const normalized = normalizeSeedUrl(input.url);
  if (!normalized) throw new DocError('bad_request', `Invalid URL: "${input.url}"`);

  const pages = await crawlUrl({ seedUrl: normalized, sourceId: 0, crawl });
  // Apply the heuristic gate locally — the LLM gate is what changes between
  // dry-run and full run, so use heuristics as the lower bound.
  const heuristic = pages.filter((p) => (p.markdown ?? '').length >= 500);
  return estimateFromPages(heuristic, pages.length);
}

// ─── Folder (migration 103) ──────────────────────────────────────

/**
 * Indexa uma pasta no filesystem do servidor. Caso de uso: doc offline do
 * Unity (`…\Editor\Data\Documentation\en\ScriptReference\`) — milhares de
 * HTML estáticos sem precisar de crawler/Chromium/429.
 */
export async function indexFolder(
  deps: IndexDocUseCaseDeps,
  input: IndexFolderInput,
  callbacks?: IndexDocStreamCallbacks,
): Promise<DocIngestResult> {
  const collection = requireCollection(deps.docStore, input.collectionId);
  const rootPath = input.rootPath;
  // O route já valida (existe, é dir, readable). Aqui só normalizamos — o
  // source.uri é o root_path com prefixo `folder://` pra distinguir de file://.
  const uri = `folder://${rootPath}`;
  const source = ensureSource(deps.docStore, {
    collection_id: collection.id,
    type: 'folder',
    uri,
    title: input.title ?? null,
    doc_type: input.docType,
    folder_root_path: rootPath,
    folder: input.folder,
  });
  const skipGate = source.folder_bypass_relevance_gate;
  return runIngest(
    deps,
    collection,
    source,
    async () => {
      // Fase "reading" — análoga ao "fetching" do URL, distinta para a UI.
      await callbacks?.onProgress?.({
        phase: 'reading',
        current: 0,
        total: 0,
        label: rootPath,
      });
      const result = await readFolder({
        rootPath,
        includeGlob: source.folder_include_glob ?? FOLDER_DEFAULT_INCLUDE_GLOB,
        excludeGlob: source.folder_exclude_glob ?? FOLDER_DEFAULT_EXCLUDE_GLOB,
        maxFiles: source.folder_max_files ?? undefined,
        sourceId: source.id,
        onEvent: (ev: FolderReaderEvent) => handleFolderEvent(deps, source.id, ev, callbacks),
      });
      console.log(
        `[doc-indexer] folder read done source=${source.id} scanned=${result.filesScanned} ` +
          `processed=${result.filesProcessed} skipped=${result.filesSkipped} errored=${result.filesErrored} ` +
          `pages=${result.pages.length} (cap=${FOLDER_HARD_MAX_FILES})`,
      );
      return result.pages;
    },
    callbacks,
    { skipGate },
  );
}

function handleFolderEvent(
  deps: IndexDocUseCaseDeps,
  sourceId: number,
  ev: FolderReaderEvent,
  callbacks: IndexDocStreamCallbacks | undefined,
): void {
  if (ev.kind === 'file') {
    deps.progressTracker?.put(sourceId, {
      phase: 'reading', current: ev.index, total: ev.total, label: ev.filePath, pages_fetched: ev.index,
    });
    void callbacks?.onProgress?.({
      phase: 'reading', current: ev.index, total: ev.total, label: ev.filePath, pages_fetched: ev.index,
    });
    return;
  }
  if (ev.kind === 'scan') {
    // Pre-flight one-shot — UI mostra "Encontrados N · vou processar M (cap K)".
    console.log(
      `[doc-indexer] folder scan source=${sourceId} totalMatches=${ev.totalMatches} ` +
        `willProcess=${ev.willProcess} cap=${ev.cap}` +
        (ev.totalMatches > ev.willProcess
          ? ` ⚠ cap atingido — ${ev.totalMatches - ev.willProcess} arquivo(s) descartado(s); aumente em Avançado`
          : ''),
    );
    void callbacks?.onScan?.({ totalMatches: ev.totalMatches, willProcess: ev.willProcess, cap: ev.cap });
    return;
  }
  // skip | error — log only, sem contagem visual.
  console.log(
    `[doc-indexer] folder ${ev.kind}: ${ev.filePath}` +
      ('reason' in ev ? ` (${ev.reason})` : '') +
      ('message' in ev ? ` — ${ev.message}` : ''),
  );
}
