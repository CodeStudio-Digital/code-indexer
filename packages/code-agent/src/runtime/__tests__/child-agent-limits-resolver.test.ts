/**
 * The Admin per-profile limits a child-agent run uses, read from a real
 * ProviderStore: the configured cap reaches the run, and every case that
 * falls back to product defaults says so in the log instead of silently.
 *
 * Opens SQLite: runs under the Electron runtime (scripts/test-harness-tools.mjs).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import { profileLimitsFromProviderStore, profileTargetsFromProviderStore } from '../child-agent-session-run.js';
import { loadChildAgentRun } from '../child-agent-run.js';

let dir: string, dbPath: string;
let warn: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'child-agent-limits-'));
  dbPath = join(dir, 'index.db');
  const db = new CodeIndexDB(dbPath);
  const providers = new ProviderStore(db.raw());
  providers.upsertProvider({ id: 'main', name: 'Main', kind: 'openai', enabled: true, use_for_coder: true });
  providers.setSubagentProfileLimits('main', 'explore', { maxToolCalls: 3, timeoutMs: 60_000 });
  db.close();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  // Set up last in beforeEach: absent when the database setup itself failed.
  warn?.mockRestore();
  warn = undefined;
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('child-agent Admin limits resolver', () => {
  it('returns the configured per-profile cap of an available provider', () => {
    const resolve = profileLimitsFromProviderStore(dbPath, 'main')!;
    expect(resolve('explore')).toEqual({ maxToolCalls: 3, timeoutMs: 60_000 });
    expect(resolve('implement')).toEqual({ maxToolCalls: null, timeoutMs: null });
    expect(warn!).not.toHaveBeenCalled();
  });

  it('feeds the cap into the child run configuration', async () => {
    const run = await loadChildAgentRun({ getChildAgentSession: async () => ({
      id: 'c' as never, parent_session_id: 'p' as never, depth: 1, status: 'idle', is_archived: false, updated_at: '',
      created_at: '', profile: 'explore', read_only: false, creation_fingerprint: 'f', conclusion: null }) },
    'c', (profileId) => profileLimitsFromProviderStore(dbPath, 'main')?.(profileId));
    expect(run!.limits).toMatchObject({ maxToolCalls: 3, timeoutMs: 60_000 });
  });

  // This edition exposes every stored provider kind, so only an unknown id is unavailable.
  it.each([
    ['an unknown provider', 'missing', /not configured or not available/],
  ])('logs and falls back for %s', (_case, providerId, message) => {
    expect(profileLimitsFromProviderStore(dbPath, providerId)).toBeUndefined();
    expect(String(warn!.mock.calls[0]?.[0])).toMatch(message);
    expect(profileTargetsFromProviderStore(dbPath)(providerId, 'explore')).toBeUndefined();
    expect(warn!).toHaveBeenCalledTimes(2);
  });

  it('logs and falls back when the database cannot be read', () => {
    expect(profileLimitsFromProviderStore(join(dir, 'missing', 'index.db'), 'main')).toBeUndefined();
    expect(String(warn!.mock.calls[0]?.[0])).toMatch(/could not be read/);
  });
});
