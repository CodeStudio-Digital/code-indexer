/**
 * Tests for `CompanyServiceLogsStore` — company B1 (migration 188).
 *
 * Covers:
 *   - appendBatch (single transaction, empty no-op)
 *   - trimToCap ring behaviour with a small cap
 *   - appendAndTrim (insert + trim per touched pair, one transaction)
 *   - listPage filters: stream, q (literal LIKE), beforeId, limit
 *   - purgeSession scoping
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '../db.js';
import {
  CompanyServiceLogsStore,
  type AppendServiceLogInput,
} from '../company-service-logs-store.js';

interface Handle {
  db: CodeIndexDB;
  store: CompanyServiceLogsStore;
  dir: string;
}

function setup(): Handle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-svc-logs-test-'));
  const db = new CodeIndexDB(join(dir, 'test.db'));
  return { db, store: new CompanyServiceLogsStore(db.raw()), dir };
}

function teardown(h: Handle): void {
  try { h.db.close(); } catch { /* */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
}

function log(line: string, over: Partial<AppendServiceLogInput> = {}): AppendServiceLogInput {
  return { sessionId: 1, serviceId: 'api', stream: 'devserver', line, atMs: 1_000, ...over };
}

let h: Handle;
beforeEach(() => { h = setup(); });
afterEach(() => teardown(h));

describe('CompanyServiceLogsStore — appendBatch', () => {
  it('inserts every row of the batch, listed newest-first', () => {
    h.store.appendBatch([log('one'), log('two'), log('three')]);
    expect(h.store.listPage(1).map((r) => r.line)).toEqual(['three', 'two', 'one']);
  });

  it('no-ops on an empty batch', () => {
    expect(() => h.store.appendBatch([])).not.toThrow();
    expect(h.store.listPage(1)).toEqual([]);
  });

  it('maps rows to camelCase', () => {
    h.store.appendBatch([log('hello', { atMs: 42 })]);
    const [row] = h.store.listPage(1);
    expect(row).toMatchObject({ sessionId: 1, serviceId: 'api', stream: 'devserver', line: 'hello', atMs: 42 });
    expect(row.id).toBeGreaterThan(0);
  });

  it('rejects an invalid stream (CHECK constraint) and rolls the batch back', () => {
    expect(() =>
      h.store.appendBatch([log('ok'), log('bad', { stream: 'bogus' as unknown as 'devserver' })]),
    ).toThrow(/CHECK/i);
    expect(h.store.listPage(1)).toEqual([]); // first row rolled back too
  });
});

describe('CompanyServiceLogsStore — trimToCap (ring)', () => {
  it('keeps only the cap newest rows and reports deletions', () => {
    h.store.appendBatch(Array.from({ length: 8 }, (_, i) => log(`l${i}`)));
    expect(h.store.trimToCap(1, 'api', 5)).toBe(3);
    expect(h.store.listPage(1).map((r) => r.line)).toEqual(['l7', 'l6', 'l5', 'l4', 'l3']);
  });

  it('no-ops when under the cap', () => {
    h.store.appendBatch([log('a'), log('b')]);
    expect(h.store.trimToCap(1, 'api', 5)).toBe(0);
    expect(h.store.listPage(1)).toHaveLength(2);
  });

  it('only trims the addressed (session, service) pair', () => {
    h.store.appendBatch(Array.from({ length: 6 }, (_, i) => log(`api${i}`)));
    h.store.appendBatch(Array.from({ length: 6 }, (_, i) => log(`fe${i}`, { serviceId: 'frontend' })));
    h.store.trimToCap(1, 'api', 2);
    expect(h.store.listPage(1, { serviceId: 'api' })).toHaveLength(2);
    expect(h.store.listPage(1, { serviceId: 'frontend' })).toHaveLength(6);
  });
});

describe('CompanyServiceLogsStore — appendAndTrim', () => {
  it('inserts and trims each touched pair to the cap', () => {
    h.store.appendBatch(Array.from({ length: 4 }, (_, i) => log(`old${i}`)));
    h.store.appendAndTrim(
      [log('new0'), log('new1'), log('fe0', { serviceId: 'frontend' })],
      5,
    );
    const api = h.store.listPage(1, { serviceId: 'api' });
    expect(api.map((r) => r.line)).toEqual(['new1', 'new0', 'old3', 'old2', 'old1']);
    expect(h.store.listPage(1, { serviceId: 'frontend' })).toHaveLength(1);
  });

  it('no-ops on an empty batch', () => {
    expect(() => h.store.appendAndTrim([], 5)).not.toThrow();
  });
});

describe('CompanyServiceLogsStore — listPage filters', () => {
  it('filters by stream', () => {
    h.store.appendBatch([
      log('dev line'),
      log('container line', { stream: 'container' }),
      log('scaffold line', { stream: 'scaffold' }),
    ]);
    const rows = h.store.listPage(1, { stream: 'container' });
    expect(rows).toHaveLength(1);
    expect(rows[0].line).toBe('container line');
  });

  it('filters by q as a literal substring (LIKE wildcards escaped)', () => {
    h.store.appendBatch([log('error: EADDRINUSE'), log('listening on 5173'), log('100% done')]);
    expect(h.store.listPage(1, { q: 'EADDRINUSE' })).toHaveLength(1);
    expect(h.store.listPage(1, { q: '0% d' })).toHaveLength(1); // literal %, not wildcard
    expect(h.store.listPage(1, { q: 'nope' })).toEqual([]);
  });

  it('paginates with beforeId + limit', () => {
    h.store.appendBatch(Array.from({ length: 5 }, (_, i) => log(`l${i}`)));
    const page1 = h.store.listPage(1, { limit: 2 });
    expect(page1.map((r) => r.line)).toEqual(['l4', 'l3']);
    const page2 = h.store.listPage(1, { limit: 2, beforeId: page1[1].id });
    expect(page2.map((r) => r.line)).toEqual(['l2', 'l1']);
  });

  it('combines stream + q + serviceId', () => {
    h.store.appendBatch([
      log('vite ready', { serviceId: 'frontend' }),
      log('vite ready', { serviceId: 'frontend', stream: 'container' }),
      log('vite ready'),
    ]);
    const rows = h.store.listPage(1, { serviceId: 'frontend', stream: 'devserver', q: 'ready' });
    expect(rows).toHaveLength(1);
  });
});

describe('CompanyServiceLogsStore — purgeSession', () => {
  it('removes only the given session and reports the count', () => {
    h.store.appendBatch([log('a'), log('b'), log('other', { sessionId: 2 })]);
    expect(h.store.purgeSession(1)).toBe(2);
    expect(h.store.listPage(1)).toEqual([]);
    expect(h.store.listPage(2)).toHaveLength(1);
  });
});
