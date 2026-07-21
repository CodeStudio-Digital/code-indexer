/**
 * Extract-cache façade semantics against a Map-backed fake store — no
 * better-sqlite3 (ABI-free), no tree-sitter. Covers: version-gated key,
 * hit/miss stats, python/rust namespace re-stamp on path change, unsupported
 * results never cached, kill-switch, corrupt-row tolerance.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { TreeSitterResult } from '../tree-sitter/index.js';
import { EXTRACTOR_VERSION } from '../tree-sitter/extractor.js';
import {
  getCachedExtraction,
  cacheExtraction,
  extractCacheStats,
  __setExtractCacheStoreForTests,
  type ExtractCacheStoreLike,
} from '../extract-cache.js';

class FakeStore implements ExtractCacheStoreLike {
  rows = new Map<string, { language: string; analysis_json: string; touched_at: number }>();
  touches = 0;
  private key(h: string, e: string, v: number): string {
    return `${h}|${e}|${v}`;
  }
  get(h: string, e: string, v: number) {
    return this.rows.get(this.key(h, e, v)) ?? null;
  }
  put(h: string, e: string, v: number, language: string, analysisJson: string, touchedAt: number) {
    this.rows.set(this.key(h, e, v), { language, analysis_json: analysisJson, touched_at: touchedAt });
  }
  touch(h: string, e: string, v: number, touchedAt: number) {
    this.touches++;
    const row = this.rows.get(this.key(h, e, v));
    if (row) row.touched_at = touchedAt;
  }
  prune(): number {
    return 0;
  }
}

function tsResult(language: string, symbols: Array<Record<string, unknown>> = []): TreeSitterResult {
  return {
    supported: true,
    language,
    analysis: { language, symbols: symbols as never, dependencies: ['dep-a'] },
  };
}

let fake: FakeStore;

beforeEach(() => {
  fake = new FakeStore();
  __setExtractCacheStoreForTests(fake);
});

afterEach(() => {
  __setExtractCacheStoreForTests(undefined);
});

describe('extract-cache', () => {
  it('round-trips an extraction keyed by (hash, ext, EXTRACTOR_VERSION)', async () => {
    await cacheExtraction('h1', 'src/a.ts', tsResult('typescript', [{ name: 'foo' }]));
    expect(fake.rows.size).toBe(1);
    expect([...fake.rows.keys()][0]).toBe(`h1|ts|${EXTRACTOR_VERSION}`);

    // Same content at ANOTHER path (same ext) hits.
    const hit = await getCachedExtraction('h1', 'other/b.ts');
    expect(hit?.supported).toBe(true);
    expect(hit?.language).toBe('typescript');
    expect(hit?.analysis.symbols?.[0]?.name).toBe('foo');
    expect(hit?.analysis.dependencies).toEqual(['dep-a']);

    // Different hash and different ext both miss.
    expect(await getCachedExtraction('h2', 'src/a.ts')).toBeNull();
    expect(await getCachedExtraction('h1', 'src/a.py')).toBeNull();
    expect(extractCacheStats()).toEqual({ hits: 1, misses: 2 });
  });

  it('returns caller-owned copies — mutating a hit cannot poison later hits', async () => {
    await cacheExtraction('h1', 'src/a.ts', tsResult('typescript', [{ name: 'foo' }]));
    const first = await getCachedExtraction('h1', 'src/a.ts');
    first!.analysis.symbols![0]!.name = 'mutated';
    const second = await getCachedExtraction('h1', 'src/a.ts');
    expect(second?.analysis.symbols?.[0]?.name).toBe('foo');
  });

  it('re-stamps the path-derived namespace (python) for the hit path', async () => {
    await cacheExtraction('h1', 'pkg/mod.py', tsResult('python', [{ name: 'fn', namespace: 'pkg.mod' }]));
    const moved = await getCachedExtraction('h1', 'lib/util.py');
    expect(moved?.analysis.symbols?.[0]?.namespace).toBe('lib.util');
    // A root-level file derives its own module name, never the stale one.
    const root = await getCachedExtraction('h1', 'top.py');
    expect(root?.analysis.symbols?.[0]?.namespace).toBe('top');
  });

  it('keeps the declared (content-true) namespace for non-path-derived languages', async () => {
    await cacheExtraction('h1', 'src/A.php', tsResult('php', [{ name: 'C', namespace: 'App\\Web' }]));
    const hit = await getCachedExtraction('h1', 'moved/B.php');
    expect(hit?.analysis.symbols?.[0]?.namespace).toBe('App\\Web');
  });

  it('never caches unsupported results or extensionless paths', async () => {
    await cacheExtraction('h1', 'src/a.xyz', { supported: false, language: 'xyz', analysis: {} });
    await cacheExtraction('h2', 'Makefile', tsResult('make'));
    expect(fake.rows.size).toBe(0);
    expect(await getCachedExtraction('h2', 'Makefile')).toBeNull();
  });

  it('tolerates a corrupt row as a miss (re-parse overwrites it)', async () => {
    fake.put('h1', 'ts', EXTRACTOR_VERSION, 'typescript', '{not json', Date.now());
    expect(await getCachedExtraction('h1', 'src/a.ts')).toBeNull();
    expect(extractCacheStats().misses).toBe(1);
  });

  it('kill-switch MCP_EXTRACT_CACHE=0 disables reads and writes', async () => {
    __setExtractCacheStoreForTests(undefined); // force re-open decision
    const prev = process.env.MCP_EXTRACT_CACHE;
    process.env.MCP_EXTRACT_CACHE = '0';
    try {
      await cacheExtraction('h1', 'src/a.ts', tsResult('typescript'));
      expect(await getCachedExtraction('h1', 'src/a.ts')).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.MCP_EXTRACT_CACHE;
      else process.env.MCP_EXTRACT_CACHE = prev;
      __setExtractCacheStoreForTests(undefined);
    }
  });

  it('throttles recency touches to once per day', async () => {
    await cacheExtraction('h1', 'src/a.ts', tsResult('typescript'));
    await getCachedExtraction('h1', 'src/a.ts'); // fresh row — no touch
    expect(fake.touches).toBe(0);
    const key = `h1|ts|${EXTRACTOR_VERSION}`;
    fake.rows.get(key)!.touched_at = Date.now() - 2 * 24 * 3600 * 1000;
    await getCachedExtraction('h1', 'src/a.ts'); // stale — touched
    expect(fake.touches).toBe(1);
  });
});
