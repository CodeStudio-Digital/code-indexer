import type { Hono } from 'hono';
import { NullVectorStore } from '../../../../store/vectors.js';
import { NullEmbeddingService } from '../../../../core/search/embeddings.js';
import type { ServerDeps } from '../deps.js';

export function mountStatsRoutes(app: Hono, deps: ServerDeps): void {
  const { db, embeddingService, vectorStore, embeddingKind, vectorStoreKind } = deps;

  app.get('/api/projects/:id/stats', (c) => {
    return c.json(db.getStats(parseInt(c.req.param('id'), 10)));
  });

  /** Embedding diagnostics for the debug panel. */
  app.get('/api/projects/:id/embeddings/stats', async (c) => {
    const projectId = parseInt(c.req.param('id'), 10);
    const project = db.getProject(projectId);
    if (!project) return c.json({ error: 'Not found' }, 404);

    const coverage = db.getEmbeddingCoverage(projectId);
    const vectorIds = db.getVectorIdStats(projectId);

    let vectorStoreAvailable = false;
    try {
      if (!(vectorStore instanceof NullVectorStore)) {
        vectorStoreAvailable = await vectorStore.isAvailable();
      }
    } catch { /* unavailable */ }

    const sampleEmbedded = db.sampleEmbeddedFiles(projectId, 5);
    const sampleNotEmbedded = db.sampleNotEmbeddedFiles(projectId, 5);

    return c.json({
      coverage,
      vectorIds,
      health: {
        embeddingService: embeddingKind,
        vectorStore: vectorStoreKind,
        vectorStoreAvailable,
      },
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
    const projectId = parseInt(c.req.param('id'), 10);
    const project = db.getProject(projectId);
    if (!project) return c.json({ error: 'Not found' }, 404);

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
    try {
      if (embeddingService instanceof NullEmbeddingService) {
        steps.push({ step: 'embed', ok: false, error: 'NullEmbeddingService — no embedding backend configured' });
      } else {
        const result = await embeddingService.embedQuery(query);
        vector = result.vector;
        steps.push({
          step: 'embed',
          ok: vector.length > 0,
          detail: `vector length: ${vector.length}, tokens: ${result.tokens}`,
          error: vector.length === 0 ? 'embedding returned empty vector' : undefined,
        });
      }
    } catch (err) {
      steps.push({ step: 'embed', ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    // Step 2: search vector store
    if (vector.length > 0 && !(vectorStore instanceof NullVectorStore)) {
      try {
        const filter: Record<string, string> = { project_name: project.name };
        const raw = await vectorStore.search(vector, { topK: 10, filter });
        steps.push({ step: 'search', ok: true, detail: `raw matches: ${raw.length}` });

        // Step 3: rehydrate
        let found = 0;
        let notFound = 0;
        for (const m of raw) {
          const isFile = m.metadata.type === 'file';
          const refId = m.metadata.ref_id ? parseInt(m.metadata.ref_id, 10) : 0;
          if (!refId) { notFound++; continue; }

          const record = isFile ? db.getFileById(refId) : db.getSymbolById(refId);
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

    return c.json({ steps, matches });
  });
}
