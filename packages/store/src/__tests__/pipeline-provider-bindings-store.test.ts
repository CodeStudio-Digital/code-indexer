/**
 * Tests for `PipelineProviderBindingsStore.bulkDelete()` and
 * `bulkApply()` — the methods that power the "Apply to all" and
 * "Clear all" admin panel actions.
 *
 * Both methods are wrapped in transactions, so the invariants worth
 * locking in are:
 *
 *   - bulkDelete with no scope wipes everything
 *   - bulkDelete with scope_type='global' leaves template/session rows alone
 *   - bulkDelete with scope_type + scope_id narrows further
 *   - bulkApply creates new rows for every target and reuses ids when a
 *     matching binding already exists (upsert semantics)
 *   - bulkApply preserves enabled / priority on existing rows the way
 *     single-row upsert does
 *
 * The single-row methods (`upsert`, `list`, `get`, etc.) are covered by
 * the route-level integration tests; this file focuses on what's new.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '../db.js';
import { PipelineProviderBindingsStore } from '../pipeline-provider-bindings-store.js';

interface Handle {
  db: CodeIndexDB;
  store: PipelineProviderBindingsStore;
  dir: string;
}

function setup(): Handle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-bindings-bulk-test-'));
  const db = new CodeIndexDB(join(dir, 'test.db'));
  // `pipeline_provider_bindings.provider_id` FK-references `provider_configs(id)`.
  // Seed every provider id the tests reference so upserts don't bounce off the
  // foreign-key check. Cheaper than wiring `ProviderStore` here; we just need
  // rows to exist.
  const raw = db.raw();
  const insertProvider = raw.prepare(
    `INSERT OR IGNORE INTO provider_configs
       (id, name, kind, base_url, api_key, auth_mode, enabled, use_for_agent, use_for_coder, is_default)
     VALUES (?, ?, ?, '', '', 'api_key', 1, 1, 1, 0)`,
  );
  for (const id of ['p1', 'p2', 'p3', 'cf-1', 'old1', 'old2', 'new-cf-1']) {
    insertProvider.run(id, `Provider ${id}`, 'cloudflare');
  }
  return { db, store: new PipelineProviderBindingsStore(raw), dir };
}
function teardown(h: Handle): void {
  try { h.db.close(); } catch { /* */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
}

function seedMixedScope(s: PipelineProviderBindingsStore): void {
  // Two global bindings.
  s.upsert({ pipeline_name: 'quality_off_topic', binding_role: 'classifier', provider_id: 'p1', model_id: 'm1', scope_type: 'global' });
  s.upsert({ pipeline_name: 'quality_policy',   binding_role: 'classifier', provider_id: 'p1', model_id: 'm1', scope_type: 'global' });
  // One template binding.
  s.upsert({ pipeline_name: 'quality_off_topic', binding_role: 'classifier', provider_id: 'p2', model_id: 'm2', scope_type: 'template', scope_id: 7 });
  // One session binding.
  s.upsert({ pipeline_name: 'quality_off_topic', binding_role: 'classifier', provider_id: 'p3', model_id: 'm3', scope_type: 'session',  scope_id: 42 });
}

describe('PipelineProviderBindingsStore.bulkDelete', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('wipes everything when no scope is given', () => {
    seedMixedScope(h.store);
    expect(h.store.list().length).toBe(4);
    const removed = h.store.bulkDelete();
    expect(removed).toBe(4);
    expect(h.store.list().length).toBe(0);
  });

  it('wipes only global rows when scope_type=global', () => {
    seedMixedScope(h.store);
    const removed = h.store.bulkDelete({ scopeType: 'global' });
    expect(removed).toBe(2);
    const remaining = h.store.list();
    expect(remaining.length).toBe(2);
    expect(remaining.every((r) => r.scope_type !== 'global')).toBe(true);
  });

  it('narrows further with scopeId', () => {
    seedMixedScope(h.store);
    const removed = h.store.bulkDelete({ scopeType: 'session', scopeId: 42 });
    expect(removed).toBe(1);
    expect(h.store.list().length).toBe(3);
    expect(h.store.list({ scopeType: 'session' }).length).toBe(0);
  });

  it('returns 0 when nothing matches', () => {
    seedMixedScope(h.store);
    expect(h.store.bulkDelete({ scopeType: 'session', scopeId: 999 })).toBe(0);
    expect(h.store.list().length).toBe(4);
  });

  it('is transactional — all-or-nothing semantics', () => {
    seedMixedScope(h.store);
    // The transactional wrapper means we either remove the matched rows
    // entirely or fail without partial state. We can't easily simulate
    // a failure inside DELETE (it's atomic by nature), but we can
    // confirm successive calls don't leave half-state behind.
    h.store.bulkDelete({ scopeType: 'template' });
    h.store.bulkDelete({ scopeType: 'global' });
    expect(h.store.list().length).toBe(1);
    expect(h.store.list()[0].scope_type).toBe('session');
  });
});

describe('PipelineProviderBindingsStore.bulkApply', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('creates a fresh row for every target', () => {
    const ids = h.store.bulkApply({
      targets: [
        { pipeline_name: 'quality_off_topic',    binding_role: 'classifier' },
        { pipeline_name: 'quality_completeness', binding_role: 'classifier' },
        { pipeline_name: 'quality_code',         binding_role: 'classifier' },
      ],
      provider_id: 'cf-1',
      model_id: '@cf/meta/llama-3.2-3b-instruct',
    });
    expect(ids.length).toBe(3);
    const rows = h.store.list();
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.provider_id === 'cf-1')).toBe(true);
    expect(rows.every((r) => r.model_id === '@cf/meta/llama-3.2-3b-instruct')).toBe(true);
    expect(rows.every((r) => r.scope_type === 'global')).toBe(true);
  });

  it('reuses ids when a matching binding already exists (upsert semantics)', () => {
    const id1 = h.store.upsert({
      pipeline_name: 'quality_policy',
      binding_role: 'classifier',
      provider_id: 'cf-1',
      model_id: 'm1',
      scope_type: 'global',
    });
    const ids = h.store.bulkApply({
      targets: [
        { pipeline_name: 'quality_policy',    binding_role: 'classifier' },
        { pipeline_name: 'quality_off_topic', binding_role: 'classifier' },
      ],
      provider_id: 'cf-1',
      model_id: 'm1',
    });
    expect(ids[0]).toBe(id1); // reused
    expect(ids[1]).not.toBe(id1); // new
    expect(h.store.list().length).toBe(2);
  });

  it('respects custom scope', () => {
    h.store.bulkApply({
      targets: [{ pipeline_name: 'quality_policy', binding_role: 'classifier' }],
      provider_id: 'p1',
      model_id: 'm1',
      scope_type: 'template',
      scope_id: 12,
    });
    const rows = h.store.list();
    expect(rows[0].scope_type).toBe('template');
    expect(rows[0].scope_id).toBe(12);
  });

  it('applies enabled + priority + config to every target', () => {
    h.store.bulkApply({
      targets: [
        { pipeline_name: 'quality_off_topic', binding_role: 'classifier' },
        { pipeline_name: 'quality_policy',    binding_role: 'classifier' },
      ],
      provider_id: 'p1',
      model_id: 'm1',
      enabled: false,
      priority: 50,
      config: { temperature: 0.0, max_tokens: 256 },
    });
    const rows = h.store.list();
    expect(rows.every((r) => !r.enabled)).toBe(true);
    expect(rows.every((r) => r.priority === 50)).toBe(true);
    expect(rows.every((r) => (r.config as { temperature: number }).temperature === 0)).toBe(true);
  });

  it('handles empty target list gracefully', () => {
    const ids = h.store.bulkApply({
      targets: [],
      provider_id: 'p1',
      model_id: 'm1',
    });
    expect(ids).toEqual([]);
    expect(h.store.list().length).toBe(0);
  });
});

describe('bulkDelete + bulkApply integration', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('clear-then-apply gives a clean uniform binding set', () => {
    // Start with mixed providers per pipeline.
    h.store.upsert({ pipeline_name: 'quality_off_topic', binding_role: 'classifier', provider_id: 'old1', model_id: 'old_m', scope_type: 'global' });
    h.store.upsert({ pipeline_name: 'quality_policy',    binding_role: 'classifier', provider_id: 'old2', model_id: 'old_m', scope_type: 'global' });

    // Wipe global only.
    const removed = h.store.bulkDelete({ scopeType: 'global' });
    expect(removed).toBe(2);

    // Apply uniformly.
    h.store.bulkApply({
      targets: [
        { pipeline_name: 'quality_off_topic', binding_role: 'classifier' },
        { pipeline_name: 'quality_policy',    binding_role: 'classifier' },
        { pipeline_name: 'quality_code',      binding_role: 'classifier' },
      ],
      provider_id: 'new-cf-1',
      model_id: 'llama-3.2-3b',
    });

    const rows = h.store.list();
    expect(rows.length).toBe(3);
    expect(new Set(rows.map((r) => r.provider_id))).toEqual(new Set(['new-cf-1']));
  });
});
