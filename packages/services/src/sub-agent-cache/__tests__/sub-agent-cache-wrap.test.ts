/**
 * withSubAgentCache tests — verifies cache miss/hit semantics, telemetry
 * callbacks, and bypass options.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import { subAgentResultCache081 } from '@mcp/store/migrations/081_sub_agent_result_cache.js';
import { SubAgentResultCacheStore } from '@mcp/store/sub-agent-result-cache-store.js';
import { SubAgentResultCache } from '../sub-agent-result-cache.js';
import { withSubAgentCache } from '../sub-agent-cache-wrap.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3') as typeof DatabaseConstructor;

describe('withSubAgentCache', () => {
  let db: InstanceType<typeof Database>;
  let cache: SubAgentResultCache;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    subAgentResultCache081.up(db);
    cache = new SubAgentResultCache(new SubAgentResultCacheStore(db));
  });
  afterEach(() => db.close());

  it('first call: miss + write + emits miss/write events', async () => {
    const onEvent = vi.fn();
    const runFn = vi.fn().mockResolvedValue({ summary: 'fresh' });
    const result = await withSubAgentCache(
      cache,
      { prompt: 'explore auth', agentType: 'Explore' },
      runFn,
      { onCacheEvent: onEvent },
    );
    expect(result.cached).toBe(false);
    expect(result.result).toEqual({ summary: 'fresh' });
    expect(runFn).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith('miss', expect.objectContaining({ agentType: 'Explore' }));
    expect(onEvent).toHaveBeenCalledWith('write', expect.objectContaining({ agentType: 'Explore' }));
  });

  it('second call same key: hit + does NOT run runFn', async () => {
    const onEvent = vi.fn();
    const runFn = vi.fn().mockResolvedValue({ summary: 'fresh' });

    await withSubAgentCache(cache, { prompt: 'p', agentType: 'Explore' }, runFn);
    runFn.mockClear();

    const result = await withSubAgentCache(
      cache,
      { prompt: 'p', agentType: 'Explore' },
      runFn,
      { onCacheEvent: onEvent },
    );
    expect(result.cached).toBe(true);
    expect(runFn).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith('hit', expect.objectContaining({ agentType: 'Explore' }));
  });

  it('bypassRead forces a fresh run', async () => {
    const runFn1 = vi.fn().mockResolvedValue({ v: 1 });
    await withSubAgentCache(cache, { prompt: 'p', agentType: 'Plan' }, runFn1);

    const runFn2 = vi.fn().mockResolvedValue({ v: 2 });
    const result = await withSubAgentCache(
      cache,
      { prompt: 'p', agentType: 'Plan' },
      runFn2,
      { bypassRead: true },
    );
    expect(result.cached).toBe(false);
    expect(runFn2).toHaveBeenCalledTimes(1);
    expect(result.result).toEqual({ v: 2 });
  });

  it('bypassWrite runs the function but does not persist', async () => {
    const runFn = vi.fn().mockResolvedValue({ v: 'tmp' });
    const onEvent = vi.fn();
    await withSubAgentCache(
      cache,
      { prompt: 'p', agentType: 'Plan' },
      runFn,
      { bypassWrite: true, onCacheEvent: onEvent },
    );
    expect(onEvent).toHaveBeenCalledWith('miss', expect.anything());
    expect(onEvent).not.toHaveBeenCalledWith('write', expect.anything());

    // Subsequent call should miss again (nothing was persisted).
    const runFn2 = vi.fn().mockResolvedValue({ v: 'tmp2' });
    const second = await withSubAgentCache(cache, { prompt: 'p', agentType: 'Plan' }, runFn2);
    expect(second.cached).toBe(false);
    expect(runFn2).toHaveBeenCalledTimes(1);
  });

  it('different prompts produce different cache keys', async () => {
    const runFn = vi.fn().mockResolvedValue({ v: 'x' });
    await withSubAgentCache(cache, { prompt: 'a', agentType: 'Explore' }, runFn);
    await withSubAgentCache(cache, { prompt: 'b', agentType: 'Explore' }, runFn);
    expect(runFn).toHaveBeenCalledTimes(2);
  });
});
