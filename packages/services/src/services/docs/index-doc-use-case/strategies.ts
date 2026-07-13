import { PDF_MAX_BYTES, parsePdf } from '../pdf-parser.js';
import { crawlUrl } from '../crawler.js';
import { DocError } from '../errors.js';
import { ensureSource, estimateFromPages, requireCollection } from './source-helpers.js';
import { runIngest } from './run-ingest.js';
import { runIncrementalFolderIngest } from './incremental-folder.js';
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
    enrichment_mode: input.enrichmentMode,
  });
  if (source.doc_type === 'mixed' && /[\\/]ScriptReference(?:[\\/]|$)/i.test(rootPath)) {
    deps.docStore.updateSourceDocType(source.id, 'api_reference');
    source.doc_type = 'api_reference';
  }
  return runIncrementalFolderIngest(deps, collection, source, callbacks, input.resumeRunId);
}
