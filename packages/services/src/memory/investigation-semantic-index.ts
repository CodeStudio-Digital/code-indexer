import { createHash } from 'node:crypto';
import {
  embedDocumentsForNamespace,
  embedQueryForNamespace,
  type EmbeddingService,
} from '@mcp/indexer/search/embeddings.js';
import { projectMemoryNamespace } from '@mcp/shared/vector-namespace.js';
import type { VectorRecord } from '@mcp/shared/types.js';
import type { VectorItemState, VectorStore, VectorWriteTarget } from '@mcp/store/vectors.js';

/** Relational source shape intentionally contains text/metadata only. */
export interface InvestigationSemanticRow {
  id: string;
  project_id: number | null;
  session_id: string;
  topic: string;
  summary: string;
  body: string;
  source_label: string | null;
  agent_type: string | null;
  tokens: number;
  created_at: string;
}

export interface InvestigationSemanticSource {
  listProject(
    projectId: number,
  ): InvestigationSemanticRow[] | Promise<InvestigationSemanticRow[]>;
}

export function investigationEmbeddingText(
  row: Pick<InvestigationSemanticRow, 'topic' | 'summary'>,
): string {
  return `${row.topic}\n${row.summary}`;
}

export function investigationEmbeddingTextHash(
  row: Pick<InvestigationSemanticRow, 'topic' | 'summary'>,
  fingerprint: string,
): string {
  return createHash('md5')
    .update(`${fingerprint}\n${investigationEmbeddingText(row)}`)
    .digest('hex');
}

export function investigationVectorId(investigationId: string): string {
  return 'inv_' + createHash('md5')
    .update(`investigation:${investigationId}`)
    .digest('hex')
    .slice(0, 24);
}

/**
 * Derivable semantic side of Session Drive investigations.
 *
 * Rows stay in their owning session bundles. Vectors share the project's
 * Memory generation with project memory, using the collision-free
 * `investigation:<id>` semantic item key and `type=investigation` filter.
 */
export class InvestigationSemanticIndex {
  constructor(
    private readonly source: InvestigationSemanticSource,
    private readonly embeddingService: EmbeddingService | null,
    private readonly vectorStore: VectorStore | null,
    private readonly queryEmbeddingService: EmbeddingService | null = embeddingService,
  ) {}

  async listProject(projectId: number): Promise<InvestigationSemanticRow[]> {
    return this.source.listProject(projectId);
  }

  private fingerprint(): string {
    return this.embeddingService?.fingerprint?.() ?? 'no-embed';
  }

  private async isCurrent(
    namespace: string,
    itemKey: string,
    hash: string,
    writeTarget?: VectorWriteTarget,
  ): Promise<boolean> {
    const items: VectorItemState[] = await (writeTarget
      ? this.vectorStore?.listItems?.(namespace, [itemKey], writeTarget)
      : this.vectorStore?.listItems?.(namespace, [itemKey])) ?? [];
    return items.length === 1
      && items[0].itemKey === itemKey
      && items[0].chunkIndex === 0
      && items[0].status === 'indexed'
      && items[0].vectorId === investigationVectorId(
        itemKey.slice('investigation:'.length),
      )
      && items[0].sourceHash === hash;
  }

  async embedAndUpsert(
    row: InvestigationSemanticRow,
  ): Promise<{ ok: boolean; error?: string; skipped?: 'no-project' | 'no-backend' | 'unchanged' }> {
    if (row.project_id == null) return { ok: true, skipped: 'no-project' };
    if (!this.embeddingService || !this.vectorStore) return { ok: true, skipped: 'no-backend' };
    const namespace = projectMemoryNamespace(row.project_id);
    const itemKey = `investigation:${row.id}`;
    const initialHash = investigationEmbeddingTextHash(row, this.fingerprint());
    try {
      if (await this.isCurrent(namespace, itemKey, initialHash)) {
        return { ok: true, skipped: 'unchanged' };
      }
      const embedded = await embedDocumentsForNamespace(
        this.embeddingService,
        namespace,
        [investigationEmbeddingText(row)],
      );
      const { vectors, writeTarget } = embedded;
      const vector = vectors[0];
      if (vectors.length !== 1
        || !vector
        || vector.length === 0
        || vector.some((value) => !Number.isFinite(value))) {
        return { ok: false, error: 'embedding service returned an invalid investigation vector' };
      }
      const hash = investigationEmbeddingTextHash(
        row,
        writeTarget?.embeddingFingerprint ?? this.fingerprint(),
      );
      if (hash !== initialHash && await this.isCurrent(namespace, itemKey, hash, writeTarget)) {
        return { ok: true, skipped: 'unchanged' };
      }
      const record: VectorRecord = {
        id: investigationVectorId(row.id),
        values: vector,
        metadata: {
          type: 'investigation',
          ref_id: String(row.id),
          session_id: String(row.session_id ?? ''),
          chunk_index: '0',
          embedding_hash: hash,
        },
      };
      const accepted = await (writeTarget
        ? this.vectorStore.upsert([record], namespace, writeTarget)
        : this.vectorStore.upsert([record], namespace));
      if (accepted !== 1) throw new Error(`vector store accepted ${accepted}/1 investigation record`);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async backfillProject(
    projectId: number,
  ): Promise<{ embedded: number; failed: number; skipped: number; total: number }> {
    const rows = await this.listProject(projectId);
    let embedded = 0;
    let failed = 0;
    let skipped = 0;
    for (const row of rows) {
      const result = await this.embedAndUpsert(row);
      if (!result.ok) failed++;
      else if (result.skipped) skipped++;
      else embedded++;
    }
    return { embedded, failed, skipped, total: rows.length };
  }

  async search(projectId: number, query: string, limit = 8, signal?: AbortSignal): Promise<string[]> {
    signal?.throwIfAborted();
    const text = query.trim();
    const topK = Math.max(1, Math.min(50, Math.floor(limit)));
    if (!text || !this.queryEmbeddingService || !this.vectorStore) return [];
    try {
      const namespace = projectMemoryNamespace(projectId);
      const { vector, generationId } = await embedQueryForNamespace(
        this.queryEmbeddingService,
        namespace,
        text,
        signal ? { signal } : undefined,
      );
      signal?.throwIfAborted();
      if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) return [];
      const matches = await this.vectorStore.search(vector, {
        namespace,
        generationId,
        topK: topK * 4,
        filter: { type: 'investigation' },
      });
      signal?.throwIfAborted();
      const ids: string[] = [];
      const seen = new Set<string>();
      for (const match of matches) {
        const id = match.metadata.ref_id;
        if (
          typeof id !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
          seen.has(id)
        ) {
          continue;
        }
        seen.add(id);
        ids.push(id);
        if (ids.length >= topK) break;
      }
      return ids;
    } catch {
      signal?.throwIfAborted();
      // Missing generation, disabled/failed provider and worker failure all
      // deliberately degrade to Session Drive's lexical recall.
      return [];
    }
  }
}
