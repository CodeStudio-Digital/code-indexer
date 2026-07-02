/**
 * Tests for `CompanyServiceTransitionsStore` — company B1 (migration 188).
 *
 * Covers:
 *   - record + listPage round-trip with camelCase mapping
 *   - newest-first ordering (id DESC)
 *   - serviceId filter
 *   - keyset pagination via beforeId + limit
 *   - purgeSession scoping
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '../db.js';
import {
  CompanyServiceTransitionsStore,
  type RecordServiceTransitionInput,
} from '../company-service-transitions-store.js';

interface Handle {
  db: CodeIndexDB;
  store: CompanyServiceTransitionsStore;
  dir: string;
}

function setup(): Handle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-svc-transitions-test-'));
  const db = new CodeIndexDB(join(dir, 'test.db'));
  return { db, store: new CompanyServiceTransitionsStore(db.raw()), dir };
}

function teardown(h: Handle): void {
  try { h.db.close(); } catch { /* */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
}

function input(over: Partial<RecordServiceTransitionInput> = {}): RecordServiceTransitionInput {
  return {
    sessionId: 1,
    serviceId: 'api',
    kind: 'status',
    fromState: 'provisioning',
    toState: 'running',
    reason: 'container started',
    actor: 'supervisor',
    atMs: 1_000,
    ...over,
  };
}

let h: Handle;
beforeEach(() => { h = setup(); });
afterEach(() => teardown(h));

describe('CompanyServiceTransitionsStore — record + listPage', () => {
  it('round-trips a transition with camelCase mapping', () => {
    const id = h.store.record(input());
    expect(id).toBeGreaterThan(0);
    const rows = h.store.listPage(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id,
      sessionId: 1,
      serviceId: 'api',
      kind: 'status',
      fromState: 'provisioning',
      toState: 'running',
      reason: 'container started',
      actor: 'supervisor',
      atMs: 1_000,
    });
  });

  it('defaults fromState/reason to null and atMs to now', () => {
    const before = Date.now();
    h.store.record({ sessionId: 1, serviceId: 'api', kind: 'health', toState: 'healthy', actor: 'supervisor' });
    const [row] = h.store.listPage(1);
    expect(row.fromState).toBeNull();
    expect(row.reason).toBeNull();
    expect(row.atMs).toBeGreaterThanOrEqual(before);
  });

  it('rejects an invalid kind (CHECK constraint)', () => {
    expect(() =>
      h.store.record(input({ kind: 'bogus' as unknown as 'status' })),
    ).toThrow(/CHECK/i);
  });

  it('lists newest-first (id DESC)', () => {
    h.store.record(input({ toState: 'a' }));
    h.store.record(input({ toState: 'b' }));
    h.store.record(input({ toState: 'c' }));
    expect(h.store.listPage(1).map((r) => r.toState)).toEqual(['c', 'b', 'a']);
  });

  it('scopes by session', () => {
    h.store.record(input({ sessionId: 1 }));
    h.store.record(input({ sessionId: 2 }));
    expect(h.store.listPage(1)).toHaveLength(1);
    expect(h.store.listPage(999)).toEqual([]);
  });
});

describe('CompanyServiceTransitionsStore — filters + pagination', () => {
  it('filters by serviceId', () => {
    h.store.record(input({ serviceId: 'api' }));
    h.store.record(input({ serviceId: 'frontend' }));
    h.store.record(input({ serviceId: 'api', kind: 'health', toState: 'healthy' }));
    const rows = h.store.listPage(1, { serviceId: 'api' });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.serviceId === 'api')).toBe(true);
  });

  it('paginates with beforeId + limit (keyset, no overlap, no gap)', () => {
    const ids = Array.from({ length: 7 }, (_, i) => h.store.record(input({ toState: `s${i}` })));
    const page1 = h.store.listPage(1, { limit: 3 });
    expect(page1.map((r) => r.id)).toEqual([ids[6], ids[5], ids[4]]);
    const page2 = h.store.listPage(1, { limit: 3, beforeId: page1[page1.length - 1].id });
    expect(page2.map((r) => r.id)).toEqual([ids[3], ids[2], ids[1]]);
    const page3 = h.store.listPage(1, { limit: 3, beforeId: page2[page2.length - 1].id });
    expect(page3.map((r) => r.id)).toEqual([ids[0]]);
  });

  it('combines serviceId filter with beforeId', () => {
    h.store.record(input({ serviceId: 'api', toState: 'a' }));
    const frontendId = h.store.record(input({ serviceId: 'frontend', toState: 'b' }));
    h.store.record(input({ serviceId: 'api', toState: 'c' }));
    const rows = h.store.listPage(1, { serviceId: 'api', beforeId: frontendId + 1 });
    expect(rows.map((r) => r.toState)).toEqual(['a']);
  });
});

describe('CompanyServiceTransitionsStore — purgeSession', () => {
  it('removes only the given session and reports the count', () => {
    h.store.record(input({ sessionId: 1 }));
    h.store.record(input({ sessionId: 1 }));
    h.store.record(input({ sessionId: 2 }));
    expect(h.store.purgeSession(1)).toBe(2);
    expect(h.store.listPage(1)).toEqual([]);
    expect(h.store.listPage(2)).toHaveLength(1);
  });
});
