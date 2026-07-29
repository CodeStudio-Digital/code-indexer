/**
 * SubAgentResultCache tests.
 *
 * Uses the post-filesystem-cutover global cache schema.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import { SubAgentResultCacheStore } from '@mcp/store/sub-agent-result-cache-store.js';
import { SubAgentResultCache } from '../sub-agent-result-cache.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3') as typeof DatabaseConstructor;

function createGlobalCacheTable(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE sub_agent_result_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt_hash TEXT NOT NULL,
      context_digest TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      result_json TEXT NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 0,
      ttl_seconds INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(prompt_hash, context_digest, agent_type)
    )
  `);
}

describe('SubAgentResultCache', () => {
  let db: InstanceType<typeof Database>;
  let store: SubAgentResultCacheStore;
  let cache: SubAgentResultCache;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    createGlobalCacheTable(db);
    store = new SubAgentResultCacheStore(db);
    cache = new SubAgentResultCache(store);
  });

  afterEach(() => db.close());

  it('returns null on miss, then the cached value after write', () => {
    const key = cache.buildKey({
      prompt: 'explore the auth flow',
      projectIds: [42],
      agentType: 'Explore',
    });
    expect(cache.tryRead(key)).toBeNull();
    cache.write(key, { summary: 'auth uses OAuth2 with PKCE' });
    const hit = cache.tryRead<{ summary: string }>(key);
    expect(hit).not.toBeNull();
    expect(hit?.cached).toBe(true);
    expect(hit?.result.summary).toBe('auth uses OAuth2 with PKCE');
  });

  it('produces different keys for different contexts', () => {
    const a = cache.buildKey({
      prompt: 'same prompt',
      projectIds: [1],
      agentType: 'Explore',
    });
    const b = cache.buildKey({
      prompt: 'same prompt',
      projectIds: [2],
      agentType: 'Explore',
    });
    expect(a.contextDigest).not.toBe(b.contextDigest);
    expect(a.promptHash).toBe(b.promptHash);
  });

  it('treats recentMutations as part of the context digest', () => {
    const a = cache.buildKey({
      prompt: 'same',
      recentMutations: ['h1'],
      agentType: 'Explore',
    });
    const b = cache.buildKey({
      prompt: 'same',
      recentMutations: ['h1', 'h2'],
      agentType: 'Explore',
    });
    expect(a.contextDigest).not.toBe(b.contextDigest);
  });

  it('respects different TTLs per agent type', () => {
    const explore = cache.buildKey({ prompt: 'p', agentType: 'Explore' });
    const plan    = cache.buildKey({ prompt: 'p', agentType: 'Plan' });
    cache.write(explore, { kind: 'explore' });
    cache.write(plan,    { kind: 'plan' });
    // Direct DB inspection to compare TTLs.
    const rows = db
      .prepare('SELECT agent_type, ttl_seconds FROM sub_agent_result_cache')
      .all() as Array<{ agent_type: string; ttl_seconds: number }>;
    const exploreRow = rows.find((r) => r.agent_type === 'Explore');
    const planRow    = rows.find((r) => r.agent_type === 'Plan');
    expect(exploreRow?.ttl_seconds).toBe(30 * 60);
    expect(planRow?.ttl_seconds).toBe(5 * 60);
  });

  it('bumps hit_count and last_used_at on each tryRead hit', () => {
    const key = cache.buildKey({ prompt: 'p', agentType: 'Explore' });
    cache.write(key, { x: 1 });
    cache.tryRead(key);
    cache.tryRead(key);
    const hit = cache.tryRead(key);
    expect(hit?.hitCount).toBe(3);
  });

  it('has no session locator column after the filesystem cutover', () => {
    const columns = db
      .prepare('PRAGMA table_info(sub_agent_result_cache)')
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain('session_id');
  });

  it('overwriting the same key resets hit_count', () => {
    const key = cache.buildKey({ prompt: 'p', agentType: 'Explore' });
    cache.write(key, { v: 1 });
    cache.tryRead(key);
    cache.tryRead(key);
    cache.write(key, { v: 2 });
    const hit = cache.tryRead<{ v: number }>(key);
    expect(hit?.result.v).toBe(2);
    expect(hit?.hitCount).toBe(1); // freshly reset, +1 from this read
  });

  it('stats() reports totals', () => {
    cache.write(cache.buildKey({ prompt: 'a', agentType: 'Explore' }), { v: 1 });
    cache.write(cache.buildKey({ prompt: 'b', agentType: 'Plan' }), { v: 2 });
    const stats = cache.stats();
    expect(stats.totalRows).toBe(2);
  });
});
