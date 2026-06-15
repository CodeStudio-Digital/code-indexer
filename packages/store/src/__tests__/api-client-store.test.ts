/**
 * Tests for ApiClientStore (migration 147) — collections, environments,
 * requests (verification folded in) and regression-run round-trips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '../db.js';
import { ApiClientStore } from '../api-client-store.js';

interface Handle { db: CodeIndexDB; store: ApiClientStore; dir: string }

function setup(): Handle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-apiclient-test-'));
  const db = new CodeIndexDB(join(dir, 'test.db'));
  return { db, store: new ApiClientStore(db.raw()), dir };
}
function teardown(h: Handle): void {
  try { h.db.close(); } catch { /* */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
}

describe('ApiClientStore', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('creates + lists + deletes collections (cascade to requests)', () => {
    const col = h.store.createCollection({ project_id: 1, name: 'Users', spec_hash: 'abc' });
    expect(col.id).toBeGreaterThan(0);
    expect(h.store.listCollections(1)).toHaveLength(1);
    expect(h.store.findCollectionBySpecHash(1, 'abc')?.id).toBe(col.id);

    const req = h.store.createRequest({ collection_id: col.id, name: 'list', method: 'GET', path_template: '/users' });
    expect(h.store.listRequests(col.id)).toHaveLength(1);

    h.store.deleteCollection(col.id);
    expect(h.store.listCollections(1)).toHaveLength(0);
    expect(h.store.getRequest(req.id)).toBeNull();
  });

  it('upserts environments and keeps a single default', () => {
    const a = h.store.upsertEnvironment({ project_id: 1, name: 'local', base_url: 'http://localhost:3000', is_default: true });
    const b = h.store.upsertEnvironment({ project_id: 1, name: 'staging', base_url: 'https://stg', is_default: true });
    const envs = h.store.listEnvironments(1);
    expect(envs).toHaveLength(2);
    expect(envs.filter((e) => e.is_default)).toHaveLength(1);
    expect(h.store.getDefaultEnvironment(1)?.id).toBe(b.id);

    h.store.upsertEnvironment({ id: a.id, project_id: 1, name: 'local2' });
    expect(h.store.getEnvironment(a.id)?.name).toBe('local2');
  });

  it('patches a request and marks it verified', () => {
    const col = h.store.createCollection({ project_id: 1, name: 'C' });
    const req = h.store.createRequest({ collection_id: col.id, name: 'r', method: 'POST', path_template: '/x' });
    expect(req.verified).toBe(false);

    h.store.updateRequest(req.id, { headers_json: '{"x":"1"}', last_status: 422 });
    expect(h.store.getRequest(req.id)?.headers_json).toBe('{"x":"1"}');
    expect(h.store.getRequest(req.id)?.last_status).toBe(422);

    h.store.markVerified(req.id, 200, '{"shape":{"id":"number"}}');
    const after = h.store.getRequest(req.id)!;
    expect(after.verified).toBe(true);
    expect(after.expected_status).toBe(200);
  });

  it('records a regression run', () => {
    const col = h.store.createCollection({ project_id: 1, name: 'C' });
    const runId = h.store.createRun(col.id, null, 'manual');
    h.store.finishRun(runId, { status: 'passed', total: 3, passed: 3, failed: 0, results_json: '[]' });
    const runs = h.store.listRuns(col.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('passed');
    expect(runs[0].passed).toBe(3);
  });
});
