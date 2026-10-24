import type { DocChunkInput, DocCollection, DocSource } from '@mcp/store/doc-store.js';
import { chunkMarkdown } from '../section-chunker.js';
import type { SectionChunk } from '../section-chunker.js';
import { enrichChunksBatched } from '../enricher.js';
import { type FolderFileEntry } from '../folder-reader.js';
import type { DocIngestProgress, RawPage } from '../types.js';
import { deterministicMetadata, extractApiMetadata, stableChunkKey } from '../incremental-metadata.js';
import { buildEmbeddingText, hashContent, hashEmbeddingInput } from './utils.js';
import type { IndexDocUseCaseDeps } from './types.js';
export interface ProcessedEntry {
  entry: FolderFileEntry;
  kind: 'unchanged' | 'changed' | 'skipped' | 'error';
  pages?: RawPage[];
  sectionsByPage?: Record<string, SectionChunk[]>;
  contentHash?: string;
  error?: string;
}

export function buildItemChunks(
  collection: DocCollection,
  source: DocSource,
  entry: FolderFileEntry,
  pages: RawPage[],
  runId: number,
  embeddingFingerprint: string,
  sectionsByPage?: Record<string, SectionChunk[]>,
): DocChunkInput[] {
  const out: DocChunkInput[] = [];
  const apiReference = source.doc_type === 'api_reference' || pages.some((p) => p.extractor === 'unity-script-reference');
  const occurrences = new Map<string, number>();
  for (const page of pages) {
    const sourceUri = page.canonical_uri ?? page.uri;
    for (const section of sectionsByPage?.[page.candidateId]
      ?? chunkMarkdown(page.markdown, { defaultRootTitle: page.title ?? 'Document' })) {
      const occurrence = occurrences.get(section.heading_path) ?? 0;
      occurrences.set(section.heading_path, occurrence + 1);
      const api = apiReference ? extractApiMetadata(section.heading_path, section.content) : { symbol: null, signature: null };
      const meta = deterministicMetadata(section.heading_path, section.content, api);
      const embeddingText = buildEmbeddingText(section.heading_path, null, section.content, api.signature);
      out.push({
        collection_id: collection.id,
        source_id: source.id,
        ord: entry.index * 10_000 + section.ord,
        heading_path: section.heading_path,
        content: section.content,
        content_hash: hashContent(section.content),
        summary: meta.summary,
        concepts: meta.concepts,
        token_count: section.token_count,
        source_uri: sourceUri,
        doc_type: apiReference ? 'api_reference' : source.doc_type,
        anchor: section.anchor,
        api_symbol: api.symbol,
        api_signature: api.signature,
        stable_key: stableChunkKey({
          itemKey: entry.relPath,
          pageKey: page.candidateId,
          headingPath: section.heading_path,
          occurrence,
        }),
        item_key: entry.relPath,
        ingest_run_id: runId,
        embedding_input_hash: hashEmbeddingInput(embeddingText),
        embedding_fingerprint: embeddingFingerprint,
        enrichment_fingerprint: apiReference || source.enrichment_mode === 'off'
          ? 'deterministic:v1'
          : source.enrichment_mode === 'all' || !meta.strong
            ? 'pending:llm'
            : 'deterministic:v1',
      });
    }
  }
  return out;
}

export async function runSelectiveEnrichment(
  deps: IndexDocUseCaseDeps,
  sourceId: number,
  runId: number,
  emit: (p: DocIngestProgress) => Promise<void>,
): Promise<void> {
  let completed = 0;
  const binding = await deps.pipelineProviderResolver.resolveOrNull('doc_ingest', 'scorer_llm', deps.resolveContext ?? {});
  const fingerprint = binding ? `${binding.provider.id}:${binding.modelId}:enrich-v1` : 'deterministic:no-binding';
  while (true) {
    const pending = deps.docStore.listChunksPendingEnrichment(sourceId, 128);
    if (pending.length === 0) break;
    for (let offset = 0; offset < pending.length; offset += 8) {
      const batch = pending.slice(offset, offset + 8);
      const uncached: typeof batch = [];
      for (const chunk of batch) {
        const hit = deps.docStore.getDocEnrichmentCache(chunk.content_hash, fingerprint);
        if (hit) {
          deps.docStore.updateChunkEnrichment(chunk.id, hit.summary ?? chunk.summary, hit.concepts, fingerprint);
          completed++;
        } else uncached.push(chunk);
      }
      if (uncached.length === 0) continue;
      if (!binding) {
        for (const chunk of uncached) {
          deps.docStore.updateChunkEnrichment(chunk.id, chunk.summary, chunk.concepts, fingerprint);
          completed++;
        }
        continue;
      }
      const enriched = await enrichChunksBatched(uncached.map((chunk, index) => ({
        chunk_index: index,
        heading_path: chunk.heading_path ?? '',
        content: chunk.content,
      })), {
        resolver: deps.pipelineProviderResolver,
        resolveContext: deps.resolveContext,
        concurrency: 1,
        batchSize: 8,
      });
      for (const result of enriched) {
        const chunk = uncached[result.chunk_index];
        if (!chunk) continue;
        const value = { summary: result.summary ?? chunk.summary, concepts: result.concepts.length ? result.concepts : chunk.concepts };
        deps.docStore.updateChunkEnrichment(chunk.id, value.summary, value.concepts, fingerprint);
        deps.docStore.putDocEnrichmentCache(chunk.content_hash, fingerprint, value);
        completed++;
      }
      deps.docStore.updateIngestRun(runId, { enrichments_completed: completed });
      await emit({
        phase: 'enriching', current: completed, total: completed + deps.docStore.listChunksPendingEnrichment(sourceId, 10_000).length,
        enrichments_completed: completed, searchable: true, state: 'completed',
      });
    }
  }
  deps.docStore.updateIngestRun(runId, { enrichments_completed: completed });
}

export async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, () => worker()));
  return out;
}
