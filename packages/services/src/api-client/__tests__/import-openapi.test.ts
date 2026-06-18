/**
 * Tests for reconcileOperations — idempotent import that preserves verified
 * requests and (the fix) unverifies orphaned import-sourced requests whose
 * endpoint vanished from the spec, so the regression battery never runs a
 * dead path.
 */
import { describe, it, expect } from 'vitest';
import type { ApiClientStore } from '@mcp/store/api-client-store.js';
import { reconcileOperations } from '../import-openapi.js';
import type { ParsedOperation } from '../openapi-walker.js';

interface Row {
  id: number; collection_id: number; method: string; path_template: string;
  verified: boolean; source: string;
}

function fakeStore(rows: Row[]): ApiClientStore & { rows: Map<number, Row> } {
  const map = new Map(rows.map((r) => [r.id, r]));
  let nextId = Math.max(0, ...rows.map((r) => r.id)) + 1;
  return {
    rows: map,
    listRequests: (cid: number) => [...map.values()].filter((r) => r.collection_id === cid),
    updateRequest: () => undefined,
    createRequest: (input: { collection_id: number; method?: string; path_template?: string }) => {
      const r: Row = { id: nextId++, collection_id: input.collection_id, method: input.method ?? 'GET', path_template: input.path_template ?? '', verified: false, source: 'openapi' };
      map.set(r.id, r);
      return r;
    },
    unverifyRequest: (id: number) => { const r = map.get(id); if (r) { r.verified = false; } },
  } as unknown as ApiClientStore & { rows: Map<number, Row> };
}

const op = (method: string, path: string): ParsedOperation =>
  ({ method, path, name: `${method} ${path}`, folder: '', headers: {}, query: {} });

describe('reconcileOperations', () => {
  it('creates new, preserves verified, counts correctly', () => {
    const store = fakeStore([
      { id: 1, collection_id: 1, method: 'GET', path_template: '/users', verified: true, source: 'openapi' },
    ]);
    const res = reconcileOperations(store, 1, [op('GET', '/users'), op('POST', '/users')]);
    expect(res.created).toBe(1);   // POST /users is new
    expect(res.stale).toBe(0);     // GET /users still present
    expect(store.rows.get(1)!.verified).toBe(true); // preserved
  });

  it('unverifies an orphaned verified request when its endpoint is renamed', () => {
    const store = fakeStore([
      { id: 1, collection_id: 1, method: 'GET', path_template: '/users', verified: true, source: 'openapi' },
    ]);
    // spec renamed /users → /customers
    const res = reconcileOperations(store, 1, [op('GET', '/customers')]);
    expect(res.created).toBe(1);
    expect(res.stale).toBe(1);
    expect(store.rows.get(1)!.verified).toBe(false); // dropped from the battery
  });

  it('never touches manual (non-openapi) requests', () => {
    const store = fakeStore([
      { id: 1, collection_id: 1, method: 'GET', path_template: '/manual', verified: true, source: 'manual' },
    ]);
    const res = reconcileOperations(store, 1, [op('GET', '/other')]);
    expect(res.stale).toBe(0);
    expect(store.rows.get(1)!.verified).toBe(true);
  });
});
