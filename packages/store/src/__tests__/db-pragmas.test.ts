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
});
