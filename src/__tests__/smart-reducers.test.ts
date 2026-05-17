import { describe, it, expect } from 'vitest';
import {
  applySmartReducer,
  reduceGitLog,
  reduceGitDiff,
  reduceGrep,
  reduceRunCommand,
} from '@mcp/code-agent/core/smart-reducers.js';

/**
 * Smart reducers shape tool_result content for high-volume tools BEFORE the
 * generic head-cut. They must be deterministic (same input → same output) so
 * server-side prompt caches stay stable across turns.
 */

describe('reduceGitLog — keep newest + oldest, elide the middle', () => {
  it('passes through when content fits in cap', () => {
    const content = 'commit abc1234\nshort log\n';
    const r = reduceGitLog({ content, cap: 10_000 });
    expect(r.applied).toBe(false);
    expect(r.content).toBe(content);
  });

  it('keeps the head + tail and elides the middle when over cap', () => {
    const commits = Array.from({ length: 50 }, (_, i) =>
      `commit ${i.toString().padStart(7, '0')}aaaa\nAuthor: x\n\n    commit message ${i} ${'x'.repeat(200)}`,
    );
    const content = commits.join('\n');
    const r = reduceGitLog({ content, cap: 10_000 });
    expect(r.applied).toBe(true);
    expect(r.content.length).toBeLessThan(content.length);
    // Both ends preserved
    expect(r.content).toContain('commit message 0 ');
    expect(r.content).toContain(`commit message 49 `);
    // Some middle commit elided
    expect(r.content).toContain('elided');
  });

  it('is deterministic across calls', () => {
    const commits = Array.from({ length: 20 }, (_, i) =>
      `commit ${'a'.repeat(40)}\n    msg ${i} ${'x'.repeat(300)}`,
    ).join('\n');
    const r1 = reduceGitLog({ content: commits, cap: 2_000 });
    const r2 = reduceGitLog({ content: commits, cap: 2_000 });
    expect(r1.content).toBe(r2.content);
  });
});

describe('reduceGitDiff — preserve file headers, trim hunks per file', () => {
  it('passes through when content fits in cap', () => {
    const small = 'diff --git a/x.ts b/x.ts\nindex 1..2 100644\n@@ -1 +1 @@\n-x\n+y\n';
    const r = reduceGitDiff({ content: small, cap: 10_000 });
    expect(r.applied).toBe(false);
  });

  it('keeps every file header but trims long hunks', () => {
    const fileWithManyHunks = (name: string) =>
      `diff --git a/${name} b/${name}\nindex aaa..bbb 100644\n--- a/${name}\n+++ b/${name}\n` +
      Array.from({ length: 50 }, (_, i) => `@@ -${i * 10},5 +${i * 10},5 @@\n-old line ${i} ${'x'.repeat(40)}\n+new line ${i} ${'y'.repeat(40)}\n`).join('');
    const big = ['a.ts', 'b.ts', 'c.ts'].map(fileWithManyHunks).join('\n');
    const r = reduceGitDiff({ content: big, cap: 2_000 });
    expect(r.applied).toBe(true);
    // First file header kept
    expect(r.content).toContain('a/a.ts');
    // Marker indicating elision
    expect(r.content).toContain('hunk(s) elided');
  });
});

describe('reduceGrep — cap matches per file', () => {
  it('passes through when content fits in cap', () => {
    const small = 'foo.ts:1: hit one\nfoo.ts:2: hit two\n';
    const r = reduceGrep({ content: small, cap: 10_000 });
    expect(r.applied).toBe(false);
  });

  it('limits matches per file when over cap', () => {
    // 30 matches in one file, 1 match in another
    const dominant = Array.from({ length: 30 }, (_, i) => `dominant.ts:${i + 1}: hit ${'x'.repeat(50)}`);
    const tiny = ['other.ts:1: hello'];
    const content = [...dominant, ...tiny].join('\n');
    const r = reduceGrep({ content, cap: 1_000 });
    expect(r.applied).toBe(true);
    // The single match in `other.ts` survives — diversity preserved
    expect(r.content).toContain('other.ts:1: hello');
    // Lots of `dominant.ts` matches are elided
    expect(r.content).toContain('elided');
    // We still see at least the first few `dominant.ts` matches
    expect(r.content).toContain('dominant.ts:1:');
  });

  it('passes through lines without a path:line: prefix', () => {
    const content = 'header line\nfoo.ts:1: a\nfoo.ts:2: b\nfooter line';
    const r = reduceGrep({ content, cap: 10_000 });
    expect(r.applied).toBe(false);
    expect(r.content).toBe(content);
  });
});

describe('reduceRunCommand — keep head + tail (errors usually at the end)', () => {
  it('passes through when content fits in cap', () => {
    const r = reduceRunCommand({ content: 'short output', cap: 10_000 });
    expect(r.applied).toBe(false);
  });

  it('keeps a long output\'s head + tail', () => {
    const head = 'starting build...\n' + 'x'.repeat(2_000) + '\n';
    const middle = 'm'.repeat(20_000) + '\n';
    const tail = 'ERROR: build failed\n' + 'y'.repeat(1_000);
    const content = head + middle + tail;
    const r = reduceRunCommand({ content, cap: 5_000 });
    expect(r.applied).toBe(true);
    expect(r.content.length).toBeLessThan(content.length);
    expect(r.content).toContain('starting build');
    expect(r.content).toContain('ERROR: build failed');
    expect(r.content).toContain('elided');
  });
});

describe('applySmartReducer — registry dispatch', () => {
  it('returns content unchanged for unregistered tools', () => {
    const content = 'x'.repeat(50_000);
    expect(applySmartReducer('write_file', content, 1_000)).toBe(content);
  });

  it('routes git_log / git_diff / grep_code / run_command to their reducers', () => {
    const log = Array.from({ length: 20 }, (_, i) => `commit ${'a'.repeat(40)}\n${'msg ' + i + ' ' + 'x'.repeat(200)}`).join('\n');
    expect(applySmartReducer('git_log', log, 2_000).length).toBeLessThan(log.length);

    const grep = Array.from({ length: 30 }, (_, i) => `f.ts:${i}: hit ${'x'.repeat(60)}`).join('\n');
    expect(applySmartReducer('grep_code', grep, 500).length).toBeLessThan(grep.length);
    // mcp__grep_code routes to the same reducer
    expect(applySmartReducer('mcp__grep_code', grep, 500).length).toBeLessThan(grep.length);
  });

  it('is idempotent — applying twice == applying once', () => {
    const content = Array.from({ length: 30 }, (_, i) => `f.ts:${i}: hit ${'x'.repeat(80)}`).join('\n');
    const once = applySmartReducer('grep_code', content, 1_000);
    const twice = applySmartReducer('grep_code', once, 1_000);
    expect(twice).toBe(once);
  });
});
