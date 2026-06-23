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

  it('dedups exact-duplicate rows', () => {
    const content = JSON.stringify(Array.from({ length: 20 }, () => ({ v: 'same' })));
    const r = jsonCrush({ content, cap: 100 });
    expect(r.applied).toBe(true);
    expect(r.content).toContain('kept 1/20 rows');
    expect(r.content).toContain('dropped 19 duplicate(s)');
  });

  it('always keeps head and tail anchors, elides the middle', () => {
    const content = jsonArray(30, (i) => ({ id: i, pad: 'p'.repeat(20) }));
    const r = jsonCrush({ content, cap: 200 });
    expect(r.applied).toBe(true);
    expect(r.content).toContain('"id":0'); // head anchor
    expect(r.content).toContain('"id":29'); // tail anchor
    expect(r.content).not.toContain('"id":15'); // middle elided
    expect(r.content).toMatch(/elided \d+ lower-relevance/);
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
