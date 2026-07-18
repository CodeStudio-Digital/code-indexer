/**
 * Tests for json-crush — the content-type reducer for generic JSON-array /
 * NDJSON tool outputs. Properties under test:
 *
 *   - detection: only fires on JSON arrays / NDJSON above MIN_ROWS
 *   - dedup of exact-duplicate rows
 *   - head/tail anchors always survive
 *   - query relevance changes WHICH middle rows survive (with vs without query)
 *   - idempotent (re-running on shaped output is a no-op) + deterministic
 *   - no-op when content fits the cap or exceeds MAX_ROWS
 */
import { describe, it, expect } from 'vitest';
import { jsonCrush } from '../json-crush.js';

const jsonArray = (n: number, f: (i: number) => unknown): string =>
  JSON.stringify(Array.from({ length: n }, (_, i) => f(i)));

describe('jsonCrush', () => {
  it('no-ops when content already fits the cap', () => {
    const content = jsonArray(10, (i) => ({ i }));
    expect(jsonCrush({ content, cap: content.length + 10 })).toEqual({ content, applied: false });
  });

  it('no-ops on plain (non-JSON) text', () => {
    const content = 'just some plain log line\n'.repeat(50);
    const r = jsonCrush({ content, cap: 50 });
    expect(r.applied).toBe(false);
    expect(r.content).toBe(content);
  });

  it('no-ops on a JSON array below MIN_ROWS', () => {
    const content = jsonArray(5, (i) => ({ i, pad: 'x'.repeat(50) }));
    expect(jsonCrush({ content, cap: 50 }).applied).toBe(false);
  });

  it('no-ops on a top-level JSON object (not an array)', () => {
    const content = JSON.stringify({ a: 'x'.repeat(500) });
    expect(jsonCrush({ content, cap: 50 }).applied).toBe(false);
  });

  it.each(['data', 'results', 'items'] as const)(
    'reduces a %s envelope while preserving its shape and sibling metadata',
    (key) => {
      const content = JSON.stringify({
        requestId: 'req-123',
        total: 20,
        [key]: Array.from({ length: 20 }, (_, i) => ({ id: i, pad: 'e'.repeat(80) })),
      });
      const r = jsonCrush({ content, cap: 1_000, contentFormat: 'application/json' });
      expect(r.applied).toBe(true);
      expect(r.content.length).toBeLessThanOrEqual(1_000);
      const parsed = JSON.parse(r.content) as Record<string, unknown>;
      expect(parsed.requestId).toBe('req-123');
      expect(parsed.total).toBe(20);
      expect(Array.isArray(parsed[key])).toBe(true);
      expect((parsed[key] as unknown[]).length).toBeLessThan(20);
      expect(parsed._smart_reducer).toMatchObject({ source_key: key, total: 20 });
    },
  );

  it('uses contentFormat to unwrap a fenced JSON payload', () => {
    const value = Array.from({ length: 20 }, (_, i) => ({ id: i, pad: 'x'.repeat(80) }));
    const content = `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
    const r = jsonCrush({ content, cap: 700, contentFormat: 'application/json' });
    expect(r.applied).toBe(true);
    expect(JSON.parse(r.content)).toHaveProperty('_smart_reducer');
  });

  it('dedups exact-duplicate rows', () => {
    const content = JSON.stringify(Array.from({ length: 20 }, () => ({ v: 'same' })));
    const r = jsonCrush({ content, cap: 100 });
    expect(r.applied).toBe(true);
    const parsed = JSON.parse(r.content) as { _smart_reducer: { kept: number; total: number; duplicates: number } };
    expect(parsed._smart_reducer).toMatchObject({ kept: 1, total: 20, duplicates: 19 });
    expect(r.content.length).toBeLessThanOrEqual(100);
  });

  it('always keeps head and tail anchors, elides the middle', () => {
    const content = jsonArray(30, (i) => ({ id: i, pad: 'p'.repeat(20) }));
    const r = jsonCrush({ content, cap: 200 });
    expect(r.applied).toBe(true);
    const parsed = JSON.parse(r.content) as { first?: string; last?: string };
    expect(parsed.first).toContain('"id":0'); // head anchor
    expect(parsed.last).toContain('"id":29'); // tail anchor
    expect(r.content).not.toContain('"id":15'); // middle elided
    expect(r.content.length).toBeLessThanOrEqual(200);
  });

  it('uses the query to decide which middle rows survive', () => {
    const PAD = 'x'.repeat(300);
    // 'needle' sits in a MIDDLE row (idx 5 of 12) — never an anchor.
    const content = JSON.stringify(
      Array.from({ length: 12 }, (_, i) => ({ id: i, body: i === 5 ? 'needle' : `f${i}`, pad: PAD })),
    );
    expect(content.length).toBeGreaterThan(2600);

    const withQuery = jsonCrush({ content, cap: 2600, query: 'needle' });
    const noQuery = jsonCrush({ content, cap: 2600 });

    expect(withQuery.applied).toBe(true);
    expect(noQuery.applied).toBe(true);
    // The query promotes the matching middle row past the in-order fillers.
    expect(withQuery.content).toContain('needle');
    expect(noQuery.content).not.toContain('needle');
  });

  it('uses tool args as stable relevance terms', () => {
    const content = jsonArray(20, (i) => ({
      id: i,
      body: i === 10 ? 'customer-needle' : `ordinary-${i}`,
      pad: 'a'.repeat(100),
    }));
    const r = jsonCrush({ content, cap: 1_300, args: { search: 'customer-needle' } });
    expect(r.applied).toBe(true);
    expect(r.content).toContain('customer-needle');
  });

  it('prioritizes failure rows for error results', () => {
    const content = jsonArray(20, (i) => ({
      id: i,
      body: i === 10 ? 'FATAL exception: decisive failure' : `debug-${i}`,
      pad: 'b'.repeat(100),
    }));
    const r = jsonCrush({ content, cap: 1_300, isError: true });
    expect(r.applied).toBe(true);
    expect(r.content).toContain('decisive failure');
  });

  it('compresses NDJSON (one JSON object per line)', () => {
    const content = Array.from({ length: 20 }, (_, i) => JSON.stringify({ id: i % 2, msg: 'dup' })).join('\n');
    const r = jsonCrush({ content, cap: 60 });
    expect(r.applied).toBe(true);
    expect(r.content).toContain('json-crush');
  });

  it('is deterministic — same input yields byte-identical output', () => {
    const content = jsonArray(40, (i) => ({ id: i, body: `row-${i}`, pad: 'z'.repeat(30) }));
    const a = jsonCrush({ content, cap: 300, query: 'row-7 row-33' });
    const b = jsonCrush({ content, cap: 300, query: 'row-7 row-33' });
    expect(a).toEqual(b);
  });

  it('is idempotent — re-running on shaped output is a no-op', () => {
    const content = jsonArray(40, (i) => ({ id: i, pad: 'q'.repeat(30) }));
    const once = jsonCrush({ content, cap: 300 });
    expect(once.applied).toBe(true);
    const twice = jsonCrush({ content: once.content, cap: 300 });
    expect(twice.applied).toBe(false);
    expect(twice.content).toBe(once.content);
  });

  it('bails (no-op) on arrays beyond MAX_ROWS to avoid pathological latency', () => {
    const content = JSON.stringify(Array.from({ length: 50_001 }, (_, i) => i));
    expect(content.length).toBeGreaterThan(300);
    expect(jsonCrush({ content, cap: 300 }).applied).toBe(false);
  });
});
