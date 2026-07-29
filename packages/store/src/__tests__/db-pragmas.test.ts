/**
 * Tuning pragmas applied to the index DB and sqlite-vec store.
 * Requires the Node-ABI better-sqlite3 build (`pnpm node:rebuild`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '../db.js';
import { SqliteVecVectorStore } from '../sqlite-vec-store.js';
import { applyTuningPragmas } from '../db/pragmas.js';

let dir: string;
const ENV_KEYS = ['MCP_SQLITE_BUSY_TIMEOUT_MS', 'MCP_SQLITE_MMAP_MB'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-pragmas-'));
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});

describe('applyTuningPragmas', () => {
  it('CodeIndexDB gets busy_timeout, temp_store=MEMORY and mmap by default', () => {
    const db = new CodeIndexDB(join(dir, 'index.db'));
    try {
      const raw = db.raw();
      expect(raw.pragma('busy_timeout', { simple: true })).toBe(5000);
      expect(raw.pragma('temp_store', { simple: true })).toBe(2); // 2 = MEMORY
      expect(Number(raw.pragma('mmap_size', { simple: true }))).toBeGreaterThan(0);
      // Pre-existing pragmas keep working.
      expect(raw.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(raw.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });

  it('sqlite-vec store gets synchronous=NORMAL plus the tuning set', () => {
    const store = new SqliteVecVectorStore({ path: join(dir, 'vec.db') });
    const raw = (store as unknown as { db: { pragma(s: string, o?: { simple: boolean }): unknown } }).db;
    expect(raw.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
    expect(raw.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(Number(raw.pragma('mmap_size', { simple: true }))).toBeGreaterThan(0);
  });

  it('env overrides win and MCP_SQLITE_MMAP_MB=0 disables mmap', () => {
    process.env.MCP_SQLITE_BUSY_TIMEOUT_MS = '1234';
    process.env.MCP_SQLITE_MMAP_MB = '0';
    const db = new CodeIndexDB(join(dir, 'index2.db'));
    try {
      expect(db.raw().pragma('busy_timeout', { simple: true })).toBe(1234);
      expect(Number(db.raw().pragma('mmap_size', { simple: true }))).toBe(0);
    } finally {
      db.close();
    }
  });

  it('invalid env values fall back to code defaults', () => {
    process.env.MCP_SQLITE_BUSY_TIMEOUT_MS = 'banana';
    process.env.MCP_SQLITE_MMAP_MB = '-5';
    const fake = { applied: [] as string[], pragma(sql: string) { this.applied.push(sql); } };
    applyTuningPragmas(fake);
    expect(fake.applied).toContain('busy_timeout = 5000');
    expect(fake.applied).toContain(`mmap_size = ${256 * 1024 * 1024}`);
  });

  // The Electron-main handle caps its busy wait: better-sqlite3 blocks inside a
  // synchronous native call, so on that thread the ceiling bounds how long every
  // window can freeze. Worker/CLI connections keep the 5s default.
  it('busyTimeoutMs option caps the ceiling for one connection', () => {
    const db = new CodeIndexDB(join(dir, 'index3.db'), { busyTimeoutMs: 250 });
    try {
      expect(db.raw().pragma('busy_timeout', { simple: true })).toBe(250);
    } finally {
      db.close();
    }
  });

  it('busyTimeoutMs option wins over the env override', () => {
    process.env.MCP_SQLITE_BUSY_TIMEOUT_MS = '9000';
    const db = new CodeIndexDB(join(dir, 'index4.db'), { busyTimeoutMs: 250 });
    try {
      expect(db.raw().pragma('busy_timeout', { simple: true })).toBe(250);
    } finally {
      db.close();
    }
  });

  it('omitting busyTimeoutMs leaves every existing caller on 5000', () => {
    const fake = { applied: [] as string[], pragma(sql: string) { this.applied.push(sql); } };
    applyTuningPragmas(fake, { busyTimeoutMs: undefined });
    expect(fake.applied).toContain('busy_timeout = 5000');
  });

  it('withBusyTimeout restores the connection ceiling afterwards', () => {
    const db = new CodeIndexDB(join(dir, 'index5.db'), { busyTimeoutMs: 250 });
    try {
      const inner = db.withBusyTimeout(5000, () =>
        Number(db.raw().pragma('busy_timeout', { simple: true })));
      expect(inner).toBe(5000);
      expect(db.raw().pragma('busy_timeout', { simple: true })).toBe(250);
    } finally {
      db.close();
    }
  });

  it('withBusyTimeout restores the ceiling even when the operation throws', () => {
    const db = new CodeIndexDB(join(dir, 'index6.db'), { busyTimeoutMs: 250 });
    try {
      expect(() => db.withBusyTimeout(5000, () => { throw new Error('boom'); })).toThrow('boom');
      expect(db.raw().pragma('busy_timeout', { simple: true })).toBe(250);
    } finally {
      db.close();
    }
  });
});
