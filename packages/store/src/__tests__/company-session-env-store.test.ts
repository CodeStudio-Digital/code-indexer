/**
 * CompanySessionEnvStore — per-service scope (D1, migration 192).
 *
 * Runs against the REAL schema (CodeIndexDB full lineage) so the ABI
 * invocation matters: better-sqlite3 is built for Electron — run via
 * `ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`.
 *
 * Pin invariants:
 *   - Rows land unscoped by default; NULL scope reaches EVERY service.
 *   - `asRecordForService` enforces the CSV ('main' = primary).
 *   - Upsert scope tri-state: omitted preserves, null clears, string sets
 *     (normalized). Legacy callers can never clobber an operator scope.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '../db.js';
import { CompanySessionEnvStore } from '../company-session-env-store.js';

interface Handle {
  db: CodeIndexDB;
  store: CompanySessionEnvStore;
  dir: string;
}

function setup(): Handle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-env-scope-test-'));
  const db = new CodeIndexDB(join(dir, 'test.db'));
  // company_session_envs.session_id FKs company_sessions — plant id=1.
  db.raw().prepare(`INSERT INTO company_sessions (name) VALUES ('env-scope-test')`).run();
  return { db, store: new CompanySessionEnvStore(db.raw()), dir };
}

let h: Handle;
beforeEach(() => { h = setup(); });
afterEach(() => {
  try { h.db.close(); } catch { /* */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
});

describe('asRecordForService — scope enforcement', () => {
  it('NULL scope goes to every service; scoped vars only to members', () => {
    h.store.upsert(1, 'SHARED', 'x', false);
    h.store.upsert(1, 'API_ONLY', 'y', false, { serviceScope: 'api' });
    h.store.upsert(1, 'PAIR', 'z', false, { serviceScope: 'main,api' });

    expect(h.store.asRecordForService(1, 'main')).toEqual({ SHARED: 'x', PAIR: 'z' });
    expect(h.store.asRecordForService(1, 'api')).toEqual({ SHARED: 'x', API_ONLY: 'y', PAIR: 'z' });
    expect(h.store.asRecordForService(1, 'web')).toEqual({ SHARED: 'x' });
    // Session-wide record stays scope-agnostic (legacy callers).
    expect(h.store.asRecord(1)).toEqual({ SHARED: 'x', API_ONLY: 'y', PAIR: 'z' });
  });

  it('matches case-insensitively (docker hostnames are lowercase)', () => {
    h.store.upsert(1, 'K', 'v', false, { serviceScope: 'API' });
    expect(h.store.asRecordForService(1, 'api')).toEqual({ K: 'v' });
    expect(h.store.asRecordForService(1, 'MAIN')).toEqual({});
  });
});

describe('upsert — serviceScope tri-state', () => {
  it('stores normalized CSV; row type carries service_scope', () => {
    h.store.upsert(1, 'K', 'v', false, { serviceScope: ' API , Main ' });
    expect(h.store.get(1, 'K')?.service_scope).toBe('api,main');
  });

  it('omitted scope PRESERVES an existing scope on overwrite', () => {
    h.store.upsert(1, 'K', 'v1', false, { serviceScope: 'api' });
    // Managed-env style rewrite: no serviceScope in opts.
    h.store.upsert(1, 'K', 'v2', true, { source: 'auto' });
    const row = h.store.get(1, 'K')!;
    expect(row.value).toBe('v2');
    expect(row.service_scope).toBe('api');
  });

  it('explicit null CLEARS the scope (back to all services)', () => {
    h.store.upsert(1, 'K', 'v', false, { serviceScope: 'api' });
    h.store.upsert(1, 'K', 'v', false, { serviceScope: null });
    expect(h.store.get(1, 'K')?.service_scope).toBeNull();
    expect(h.store.asRecordForService(1, 'web')).toEqual({ K: 'v' });
  });

  it('empty/whitespace CSV normalizes to NULL, never empty string', () => {
    h.store.upsert(1, 'K', 'v', false, { serviceScope: ' , ' });
    expect(h.store.get(1, 'K')?.service_scope).toBeNull();
  });

  it('rows default to unscoped (NULL)', () => {
    h.store.upsert(1, 'K', 'v', false);
    expect(h.store.get(1, 'K')?.service_scope).toBeNull();
  });

  it('onlyIfAbsent inserts carry the scope; existing rows stay untouched', () => {
    h.store.upsert(1, 'NEW', 'v', false, { onlyIfAbsent: true, serviceScope: 'api' });
    expect(h.store.get(1, 'NEW')?.service_scope).toBe('api');

    h.store.upsert(1, 'NEW', 'other', false, { onlyIfAbsent: true, serviceScope: null });
    const row = h.store.get(1, 'NEW')!;
    expect(row.value).toBe('v');
    expect(row.service_scope).toBe('api');
  });
});
