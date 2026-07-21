/**
 * Per-profile subagent hard caps (`extra.subagent_profiles[P].max_tool_calls`
 * / `.timeout_ms`). The invariants that matter:
 *   - explicit 0 round-trips (unlimited, not "unset");
 *   - the partial-patch semantics never clobber the other axis;
 *   - a budget-only entry SURVIVES clearing the provider/model/effort keys
 *     (the delete-guard regression: the old guard only looked at the three
 *     string keys and dropped budget-only entries on the next write).
 *
 * Requires Node-ABI better-sqlite3 (`pnpm node:rebuild` after an
 * electron-rebuild) — same constraint as every store suite.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '../../db.js';
import { ProviderStore } from '../../provider-store.js';

interface Handle {
  db: CodeIndexDB;
  store: ProviderStore;
  dir: string;
}

function setup(): Handle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-subagent-limits-test-'));
  const db = new CodeIndexDB(join(dir, 'test.db'));
  const raw = db.raw();
  raw
    .prepare(
      `INSERT OR IGNORE INTO provider_configs
         (id, name, kind, base_url, api_key, auth_mode, enabled, use_for_agent, use_for_coder, is_default)
       VALUES ('zai', 'ZAI', 'zai', '', '', 'api_key', 1, 1, 1, 0)`,
    )
    .run();
  return { db, store: new ProviderStore(raw), dir };
}

function teardown(h: Handle): void {
  try { h.db.close(); } catch { /* */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
}

function extraProfiles(h: Handle): Record<string, unknown> | undefined {
  return (h.store.getProvider('zai')?.extra as { subagent_profiles?: Record<string, unknown> } | undefined)
    ?.subagent_profiles;
}

describe('subagent per-profile limits', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('round-trips values including explicit 0 (unlimited)', () => {
    h.store.setSubagentProfileLimits('zai', 'explore', { maxToolCalls: 40, timeoutMs: 600_000 });
    expect(h.store.getSubagentProfileLimits('zai', 'explore')).toEqual({
      maxToolCalls: 40,
      timeoutMs: 600_000,
    });

    h.store.setSubagentProfileLimits('zai', 'explore', { maxToolCalls: 0 });
    expect(h.store.getSubagentProfileLimits('zai', 'explore')).toEqual({
      maxToolCalls: 0,
      timeoutMs: 600_000,
    });
  });

  it('patches one axis without clobbering the other, and null clears', () => {
    h.store.setSubagentProfileLimits('zai', 'implement', { maxToolCalls: 120 });
    h.store.setSubagentProfileLimits('zai', 'implement', { timeoutMs: 1_200_000 });
    expect(h.store.getSubagentProfileLimits('zai', 'implement')).toEqual({
      maxToolCalls: 120,
      timeoutMs: 1_200_000,
    });

    h.store.setSubagentProfileLimits('zai', 'implement', { maxToolCalls: null });
    expect(h.store.getSubagentProfileLimits('zai', 'implement')).toEqual({
      maxToolCalls: null,
      timeoutMs: 1_200_000,
    });
  });

  it('returns nulls for an unset profile or unknown provider', () => {
    expect(h.store.getSubagentProfileLimits('zai', 'verify'))
      .toEqual({ maxToolCalls: null, timeoutMs: null });
    expect(h.store.getSubagentProfileLimits('nope', 'verify'))
      .toEqual({ maxToolCalls: null, timeoutMs: null });
  });

  it('keeps a budget-only entry alive when target/effort are cleared (delete-guard regression)', () => {
    h.store.setSubagentProfileTarget('zai', 'explore', 'zai', 'glm-4.5-flash');
    h.store.setSubagentProfileLimits('zai', 'explore', { maxToolCalls: 40 });

    // "Use default" in the UI: clears provider/model — must NOT drop the budget.
    h.store.setSubagentProfileTarget('zai', 'explore', null, null);
    expect(h.store.getSubagentProfileLimits('zai', 'explore')).toEqual({
      maxToolCalls: 40,
      timeoutMs: null,
    });

    // And the effort setter must merge, not clobber.
    h.store.setSubagentProfileEffort('zai', 'explore', 'low');
    expect(h.store.getSubagentProfileLimits('zai', 'explore').maxToolCalls).toBe(40);
    expect(h.store.getSubagentProfileEffort('zai', 'explore')).toBe('low');
  });

  it('removes the entry (and the map) only when every key is cleared', () => {
    h.store.setSubagentProfileLimits('zai', 'explore', { maxToolCalls: 40, timeoutMs: 600_000 });
    h.store.setSubagentProfileLimits('zai', 'explore', { maxToolCalls: null, timeoutMs: null });
    expect(extraProfiles(h)).toBeUndefined();
  });
});
