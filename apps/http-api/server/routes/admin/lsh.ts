/**
 * Admin routes for the LSH index (migration 082).
 *
 *   GET  /api/admin/lsh/stats?project_id=X&entity_type=file
 *     → top buckets + cardinality (helps detect skewed projections)
 *
 *   POST /api/admin/lsh/ingest
 *     body: { project_id, entity_type, entries: [{ entity_id, embedding: [...] }] }
 *     → indexes one batch of embeddings. The indexer pipeline calls this
 *       (or LSHIndex.indexMany directly) alongside its vector-store upsert.
 *
 *   DELETE /api/admin/lsh/entry?project_id=X&entity_type=file&entity_id=42
 *     → removes one entity's LSH state. Called when a file is deleted.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';

type LshEntityType = 'file' | 'symbol';

const VALID_ENTITY_TYPES: LshEntityType[] = ['file', 'symbol'];

function isEntityType(s: unknown): s is LshEntityType {
  return typeof s === 'string' && VALID_ENTITY_TYPES.includes(s as LshEntityType);
}

export function mountAdminLshRoutes(app: Hono, deps: ServerDeps): void {
  const { lshIndex, lshIndexStore } = deps;

  app.get('/api/admin/lsh/stats', (c) => {
    const projectId = Number(c.req.query('project_id'));
    const entityType = c.req.query('entity_type');
    if (!Number.isFinite(projectId)) return c.json({ error: 'project_id required' }, 400);
    if (!isEntityType(entityType)) return c.json({ error: 'entity_type must be file or symbol' }, 400);
    const hashIdx = Number(c.req.query('hash_idx') ?? '0');
    const histogram = lshIndexStore.bucketHistogram({
      project_id: projectId,
      entity_type: entityType,
      hash_idx: Number.isFinite(hashIdx) ? hashIdx : 0,
    });
    return c.json({
      project_id: projectId,
      entity_type: entityType,
      hash_idx: hashIdx,
      bucket_histogram: histogram,
      params_hash: lshIndex.getParamsHash(),
      num_hyperplanes: lshIndex.numHyperplanes,
      num_hashes: lshIndex.numHashes,
      num_buckets: lshIndex.numBuckets,
      dim: lshIndex.dim,
    });
  });

  app.post('/api/admin/lsh/ingest', async (c) => {
    let body: {
      project_id?: number;
      entity_type?: string;
      entries?: Array<{ entity_id?: number; embedding?: number[] }>;
    };
    try { body = (await c.req.json()) as typeof body; }
    catch { return c.json({ error: 'invalid_json' }, 400); }
    if (!Number.isFinite(body.project_id)) return c.json({ error: 'project_id required' }, 400);
    if (!isEntityType(body.entity_type)) return c.json({ error: 'entity_type must be file or symbol' }, 400);
    if (!Array.isArray(body.entries)) return c.json({ error: 'entries must be an array' }, 400);

    const inputs = body.entries
      .filter((e) => Number.isFinite(e.entity_id) && Array.isArray(e.embedding))
      .map((e) => ({
        projectId: body.project_id as number,
        entityType: body.entity_type as LshEntityType,
        entityId: e.entity_id as number,
        embedding: Float32Array.from(e.embedding as number[]),
      }));

    lshIndex.indexMany(inputs);
    return c.json({ indexed: inputs.length, skipped: body.entries.length - inputs.length });
  });

  app.delete('/api/admin/lsh/entry', (c) => {
    const projectId = Number(c.req.query('project_id'));
    const entityType = c.req.query('entity_type');
    const entityId = Number(c.req.query('entity_id'));
    if (!Number.isFinite(projectId) || !isEntityType(entityType) || !Number.isFinite(entityId)) {
      return c.json({ error: 'project_id, entity_type, entity_id all required' }, 400);
    }
    lshIndex.remove({ projectId, entityType, entityId });
    return c.json({ ok: true });
  });
}
