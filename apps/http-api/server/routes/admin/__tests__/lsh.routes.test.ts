/**
 * Integration tests for the admin LSH endpoints.
 *
 * Uses a real HttpRouter instance with in-memory routes and a temp SQLite via
 * CodeIndexDB. Verifies the round-trip: POST /ingest → GET /stats picks
 * up the buckets.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpRouter } from '@mcp/shared/http/router.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { LshIndexStore } from '@mcp/store/lsh-index-store.js';
import { LSHIndex } from '@mcp/indexer/search/lsh-index.js';
import { mountAdminLshRoutes } from '../lsh.js';
import type { ServerDeps } from '../../../deps.js';

interface Handle { app: HttpRouter; db: CodeIndexDB; dir: string }

function setup(): Handle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-lsh-routes-'));
  const db = new CodeIndexDB(join(dir, 'test.db'));
  const lshIndexStore = new LshIndexStore(db.raw());
  const lshIndex = new LSHIndex({ dim: 8, store: lshIndexStore, numHashes: 2, numBuckets: 16, seed: 1 });
  const app = new HttpRouter();
  mountAdminLshRoutes(app, { lshIndex, lshIndexStore } as unknown as ServerDeps);
  return { app, db, dir };
}

function teardown(h: Handle): void {
  try { h.db.close(); } catch { /* */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
}

describe('admin /lsh routes', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('ingest + stats round-trip', async () => {
    const ingest = await h.app.request('/api/admin/lsh/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: 1,
        entity_type: 'file',
        entries: [
          { entity_id: 10, embedding: [1, 0, 0, 0, 0, 0, 0, 0] },
          { entity_id: 11, embedding: [0, 1, 0, 0, 0, 0, 0, 0] },
          { entity_id: 12, embedding: [1, 0.1, 0, 0, 0, 0, 0, 0] }, // near 10
        ],
      }),
    });
    expect(ingest.status).toBe(200);
    const result = (await ingest.json()) as { indexed: number; skipped: number };
    expect(result.indexed).toBe(3);
    expect(result.skipped).toBe(0);

    const stats = await h.app.request('/api/admin/lsh/stats?project_id=1&entity_type=file&hash_idx=0');
    expect(stats.status).toBe(200);
    const statsBody = (await stats.json()) as {
      bucket_histogram: Array<{ bucket_hash: number; count: number }>;
      num_hyperplanes: number;
      num_hashes: number;
      dim: number;
    };
    expect(statsBody.num_hyperplanes).toBe(32);
    expect(statsBody.num_hashes).toBe(2);
    expect(statsBody.dim).toBe(8);
    expect(statsBody.bucket_histogram.length).toBeGreaterThan(0);
  });

  it('rejects bad entity_type', async () => {
    const r = await h.app.request('/api/admin/lsh/stats?project_id=1&entity_type=bogus');
    expect(r.status).toBe(400);
  });

  it('rejects missing project_id', async () => {
    const r = await h.app.request('/api/admin/lsh/stats?entity_type=file');
    expect(r.status).toBe(400);
  });

  it('skips entries missing required fields', async () => {
    const ingest = await h.app.request('/api/admin/lsh/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: 1,
        entity_type: 'symbol',
        entries: [
          { entity_id: 100, embedding: [0.1, 0.2, 0, 0, 0, 0, 0, 0] },
          { entity_id: 'bad' }, // missing embedding + bad type
          { embedding: [0.5, 0, 0, 0, 0, 0, 0, 0] }, // missing entity_id
        ],
      }),
    });
    const result = (await ingest.json()) as { indexed: number; skipped: number };
    expect(result.indexed).toBe(1);
    expect(result.skipped).toBe(2);
  });

  it('DELETE removes signature + buckets', async () => {
    await h.app.request('/api/admin/lsh/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: 1,
        entity_type: 'file',
        entries: [{ entity_id: 99, embedding: [1, 0, 0, 0, 0, 0, 0, 0] }],
      }),
    });
    const del = await h.app.request('/api/admin/lsh/entry?project_id=1&entity_type=file&entity_id=99', {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
    const stats = await h.app.request('/api/admin/lsh/stats?project_id=1&entity_type=file');
    const body = (await stats.json()) as { bucket_histogram: unknown[] };
    expect(body.bucket_histogram).toEqual([]);
  });
});
