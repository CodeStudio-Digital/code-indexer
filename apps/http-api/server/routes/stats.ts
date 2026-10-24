import type { Hono } from 'hono';
import { generationMatchesEmbeddingFingerprint, NullVectorStore } from '@mcp/store/vectors.js';
import { embedQueryForNamespace } from '@mcp/indexer/search/embeddings.js';
import { codeNamespace } from '@mcp/shared/vector-namespace.js';
import { readFsSessionMemoryKpis } from '@mcp/session-storage/fs-store/index.js';
import type { ServerDeps } from '../deps.js';
import { parseIdParam, notFound } from './_helpers.js';
import { timeSection } from '../perf/breakdown.js';

export function mountStatsRoutes(app: Hono, deps: ServerDeps): void {
  const { db, vectorStore, vectorStoreKind } = deps;

  app.get('/api/projects/:id/stats', (c) => {
    return c.json(db.getStats(parseIdParam(c)));
  });

  /**
   * Agent Memory health (migration 181) — feeds the project Memory tab's
   * "is memory actually being used?" card: live project/user memory counts plus
   * telemetry (remember/recall/forget + recalls that injected ≥1 memory).
   * Read-only over shared agent_memory tables and filesystem session bundles.
   */
  app.get('/api/projects/:id/agent-memory/stats', async (c) => {
    const projectId = parseIdParam(c);
    const project = db.getProject(projectId);
    if (!project) return notFound(c);
    const sessionKpis = await readFsSessionMemoryKpis(
      deps.sessionStore,
      projectId,
    );
    return c.json({
      ...db.getAgentMemoryStats(projectId),
      // Shared memory stock/recall stays in SQLite. Learning and explicit-tool
      // counters come from the owning/linked filesystem session bundles.
      kpis: db.getMemoryEffectivenessKpis(projectId, sessionKpis),
    });
  });

  /**
   * Embedding diagnostics for the debug panel — the FAST half: indexed
   * coverage counts (now index-only via idx_files_project_embedding),
   * vector-id stats, fingerprint, health. The expensive `ORDER BY RANDOM()`
   * file samples moved to `/embeddings/samples` (loaded lazily by the panel)
   * so opening the panel no longer waits on two full-table random scans.
   *
   * NOT cached: the diagnostics panel may refetch immediately after an
   * explicit semantic build, and stale coverage would make that build look
   * ineffective. The indexed ledger counts are already cheap.
   */
  app.get('/api/projects/:id/embeddings/stats', async (c) => {
    const projectId = parseIdParam(c);
    const project = db.getProject(projectId);
    if (!project) return notFound(c);

    const coverage = timeSection('embeddings.stats', 'coverage', () => db.getEmbeddingCoverage(projectId));
    const vectorIds = timeSection('embeddings.stats', 'vectorIds', () => db.getVectorIdStats(projectId));

    let vectorStoreAvailable = false;
    try {
      if (!(vectorStore instanceof NullVectorStore)) {
        vectorStoreAvailable = await timeSection('embeddings.stats', 'vectorStore.isAvailable', () =>
          vectorStore.isAvailable(),
        );
      }
    } catch { /* unavailable */ }

    // Compare the immutable active semantic generation with the desired Code
    // profile. The legacy projects.embedding_fingerprint belongs to the old
    // direct-index path and can otherwise report false mismatches here.
    const activeGeneration = timeSection('embeddings.stats', 'fingerprint', () =>
      deps.semanticStore.getActiveGeneration(codeNamespace(projectId)),
    );
    const codeProfile = deps.semanticStore.getProfile('code');
    const storedFingerprint = activeGeneration?.fingerprint ?? null;
    let liveFingerprint: string | null = null;
    try {
      liveFingerprint = deps.semanticProfileRuntime.embedding('code').fingerprint?.() ?? null;
    } catch { /* an unavailable desired target is reported by health/probe */ }

    return c.json({
      coverage,
      vectorIds,
      fingerprint: {
        stored: storedFingerprint,
        live: liveFingerprint,
        mismatch: !!(storedFingerprint && liveFingerprint
          && !generationMatchesEmbeddingFingerprint(storedFingerprint, liveFingerprint)),
      },
      health: {
        embeddingService: codeProfile?.embedding_target.kind ?? 'disabled',
        vectorStore: vectorStoreKind,
        vectorStoreAvailable,
      },
    });
  });

  /** Random file samples (embedded / not embedded) — the slow scans, split
   *  out so the panel can defer them after the headline coverage renders. */
  app.get('/api/projects/:id/embeddings/samples', (c) => {
    const projectId = parseIdParam(c);
    const project = db.getProject(projectId);
    if (!project) return notFound(c);

    const sampleEmbedded = timeSection('embeddings.samples', 'sampleEmbedded', () =>
      db.sampleEmbeddedFiles(projectId, 5),
    );
    const sampleNotEmbedded = timeSection('embeddings.samples', 'sampleNotEmbedded', () =>
      db.sampleNotEmbeddedFiles(projectId, 5),
    );

    return c.json({
      sampleEmbedded: sampleEmbedded.map((f) => ({
        type: 'file' as const,
        path: f.path,
        embeddingHash: f.embedding_hash.slice(0, 12) + '…',
      })),
      sampleNotEmbedded: sampleNotEmbedded.map((f) => ({
        type: 'file' as const,
        path: f.path,
      })),
    });
  });

  /** Step-by-step test query for debugging vector search. */
  app.post('/api/projects/:id/embeddings/test-query', async (c) => {
    const projectId = parseIdParam(c);
    const project = db.getProject(projectId);
    if (!project) return notFound(c);
    const namespace = codeNamespace(projectId);

    const body = await c.req.json<{ query: string }>();
    const query = body.query?.trim();
    if (!query) return c.json({ error: 'query required' }, 400);

    type Step = { step: string; ok: boolean; detail?: string; error?: string };
    const steps: Step[] = [];
    const matches: Array<{
      vectorId: string;
      score: number;
      type: string;
      refId: number;
      rehydrated: boolean;
      path?: string;
      name?: string;
    }> = [];

    // Step 1: embed
    let vector: number[] = [];
    let generationId: number | null = null;
    try {
      const queryEmbedding = deps.semanticProfileRuntime.queryEmbedding('code');
      const result = await embedQueryForNamespace(queryEmbedding, namespace, query);
      if (!Number.isSafeInteger(result.generationId) || result.generationId! < 1) {
        throw new Error(`active query embedding did not return a generation for ${namespace}`);
      }
      vector = result.vector;
      generationId = result.generationId!;
      steps.push({
        step: 'embed',
        ok: vector.length > 0,
        detail: `namespace: ${namespace}, generation: ${generationId}, vector length: ${vector.length}, tokens: ${result.tokens}`,
        error: vector.length === 0 ? 'embedding returned empty vector' : undefined,
      });
    } catch (err) {
      steps.push({ step: 'embed', ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    // Step 2: search vector store
    if (vector.length > 0 && generationId !== null && !(vectorStore instanceof NullVectorStore)) {
      try {
        // Step 2a: metadata-unfiltered, but still isolated inside this project's
        // immutable namespace generation.
        const unfilteredRaw = await vectorStore.search(vector, {
          topK: 3,
          namespace,
          generationId,
        });
        steps.push({
          step: 'search_unfiltered',
          ok: unfilteredRaw.length > 0,
          detail: `namespace matches: ${unfilteredRaw.length}`,
        });

        // Step 2b: full namespace search for rehydration. Project names are
        // descriptive metadata and may still contain the pre-rename value;
        // code:p<ID> is the isolation boundary.
        const raw = await vectorStore.search(vector, {
          topK: 10,
          namespace,
          generationId,
        });
        steps.push({ step: 'search', ok: raw.length > 0, detail: `raw matches: ${raw.length}` });

        // Step 3: rehydrate
        let found = 0;
        let notFound = 0;
        for (const m of raw) {
          const isFile = m.metadata.type === 'file';
          const refId = m.metadata.ref_id ? parseInt(m.metadata.ref_id, 10) : 0;
          if (!refId) { notFound++; continue; }

          // Route the surrogate-id lookup to THIS project's DB (post-split the id
          // is unique only within the project DB; central when the flag is off).
          const record = isFile ? db.getFileById(refId, project.id) : db.getSymbolById(refId, project.id);
          if (record) {
            found++;
            matches.push({
              vectorId: m.id,
              score: m.score,
              type: m.metadata.type,
              refId,
              rehydrated: true,
              path: (record as unknown as Record<string, unknown>).path as string ?? (record as unknown as Record<string, unknown>).file_path as string,
              name: (record as unknown as Record<string, unknown>).name as string | undefined,
            });
          } else {
            notFound++;
            matches.push({
              vectorId: m.id,
              score: m.score,
              type: m.metadata.type,
              refId,
              rehydrated: false,
            });
          }
        }
        steps.push({ step: 'rehydrate', ok: found > 0, detail: `found: ${found}, not found: ${notFound}` });
      } catch (err) {
        steps.push({ step: 'search', ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    } else if (vectorStore instanceof NullVectorStore) {
      steps.push({ step: 'search', ok: false, error: 'NullVectorStore — no vector store configured' });
    }

    return c.json({ namespace, generationId, steps, matches });
  });
}
