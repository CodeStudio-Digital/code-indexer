/**
 * Worker-local documentation search used by agent sessions.
 *
 * The full semantic backend owns provider-backed embedding/reranking services
 * in the Electron host. A slow provider call there blocks the host's event
 * loop for the entire RPC and makes the UI unresponsive even though the agent
 * worker is healthy. Agent searches therefore use the corpus' local FTS index
 * in their existing worker DB connection. Structural reads remain host RPCs;
 * they are short SQLite lookups and do not cross the slow semantic boundary.
 */
import { createHash } from 'node:crypto';
import type { DocSearchBackend } from '../../../packages/code-agent/src/tools/doc-search-types.js';
import { DocHybridSearch } from '../../../packages/services/src/services/docs/search.js';
import { resolveDocSearchScope } from '../../../packages/services/src/services/docs/search-scope.js';
import type { DocSearchInput } from '../../../packages/services/src/services/docs/search.js';
import type { DocStore } from '../../../packages/store/src/doc-store.js';
import type { DocSearchEventInput } from '../../../packages/store/src/doc/rag-telemetry.js';

type WorkerDocSearchBackend = Pick<DocSearchBackend, 'search'> & {
  flushTelemetry(): Promise<void>;
  dispose(): Promise<void>;
};

const TELEMETRY_FLUSH_MS = 100;
const TELEMETRY_BATCH_SIZE = 50;
const TELEMETRY_MAX_PENDING = 2_048;
const TELEMETRY_RETRY_MS = 250;

class DocSearchTelemetryBuffer {
  private pending: DocSearchEventInput[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly writeBatch: (events: readonly DocSearchEventInput[]) => void,
  ) {}

  enqueue(event: DocSearchEventInput): void {
    if (this.stopped) return;
    this.pending.push(event);
    if (this.pending.length > TELEMETRY_MAX_PENDING) {
      this.pending.splice(0, this.pending.length - TELEMETRY_MAX_PENDING);
    }
    this.schedule(this.pending.length >= TELEMETRY_BATCH_SIZE ? 0 : TELEMETRY_FLUSH_MS);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) {
      if (delayMs !== 0) return;
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delayMs);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.pending.splice(0, TELEMETRY_BATCH_SIZE);
    if (batch.length === 0) return;
    try {
      this.writeBatch(batch);
    } catch {
      // Telemetry is best-effort, but retain a bounded batch for a quieter WAL
      // moment instead of issuing one write per RAG query.
      this.pending.unshift(...batch);
      if (this.pending.length > TELEMETRY_MAX_PENDING) {
        this.pending.length = TELEMETRY_MAX_PENDING;
      }
      this.schedule(TELEMETRY_RETRY_MS);
      return;
    }
    if (this.pending.length > 0) this.schedule(0);
  }

  async dispose(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopped = true;
    // `flush()` intentionally writes bounded chunks. During shutdown there
    // will be no timer to schedule the next chunk, so drain every remaining
    // chunk explicitly instead of silently dropping everything after the
    // first 50 events.
    while (this.pending.length > 0) {
      const before = this.pending.length;
      await this.flush();
      // A busy/failing telemetry sink requeues the same batch. Telemetry is
      // best-effort; do not turn worker shutdown into an unbounded retry loop.
      if (this.pending.length >= before) break;
    }
    this.pending = [];
  }
}

export function buildWorkerDocSearch(docStore: DocStore): WorkerDocSearchBackend {
  // Expose only the reads the FTS path needs. Passing the full DocStore would
  // make DocHybridSearch calculate vector coverage after every lexical query;
  // that active-generation COUNT is irrelevant here and expensive on a large
  // corpus. The original store remains available below for scope + telemetry.
  const lexicalStore = {
    getCollectionByName: docStore.getCollectionByName.bind(docStore),
    searchChunksFts: docStore.searchChunksFts.bind(docStore),
    getChunksByIds: docStore.getChunksByIds.bind(docStore),
    getCollection: docStore.getCollection.bind(docStore),
  } as unknown as DocStore;
  const lexicalSearch = new DocHybridSearch(lexicalStore, null, null);
  const telemetry = new DocSearchTelemetryBuffer((events) => {
    const write = (): void => {
      if (typeof docStore.recordDocSearchEvents === 'function') {
        docStore.recordDocSearchEvents(events);
      } else {
        for (const event of events) docStore.recordDocSearchEvent(event);
      }
    };
    if (typeof docStore.withBusyTimeout === 'function') docStore.withBusyTimeout(0, write);
    else write();
  });

  return {
    flushTelemetry: () => telemetry.flush(),
    dispose: () => telemetry.dispose(),
    search: async (input, signal) => {
      signal?.throwIfAborted();
      const { scope, project_id, ...rest } = input;
      const { scope: resolvedScope, collections: scoped } = resolveDocSearchScope(docStore, input);

      const forward: DocSearchInput = {
        ...rest,
        mode: 'fts',
        signal,
        enhancements: { rewrite: false, rerank: false },
      };
      if (scoped.length > 0) forward.collection_ids = scoped.map((collection) => collection.id);

      const started = Date.now();
      const out = await lexicalSearch.search(forward);
      signal?.throwIfAborted();
      out.diag.scope = resolvedScope;
      if (scoped.length > 0) out.diag.scoped_collections = scoped.map((collection) => collection.name);

      const explicitCollectionId = input.collection
        ? docStore.getCollectionByName(input.collection)?.id
        : undefined;
      telemetry.enqueue({
        project_id,
        query_hash: createHash('sha256').update(input.query).digest('hex'),
        scope: out.diag.scope,
        collection_ids: explicitCollectionId != null
          ? [explicitCollectionId]
          : scoped.map((collection) => collection.id),
        mode: out.diag.mode,
        duration_ms: Date.now() - started,
        fts_hits: out.diag.fts_hits,
        vector_hits: out.diag.vector_hits,
        stale_vector_hits: out.diag.stale_vector_hits,
        vector_coverage: out.diag.vector_coverage,
        top_relevance: out.diag.top_relevance,
        no_good_match: out.diag.no_good_match,
        result_count: out.results.length,
      });

      return out;
    },
  };
}
