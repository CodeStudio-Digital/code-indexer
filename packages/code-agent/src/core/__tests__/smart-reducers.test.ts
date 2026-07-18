import { describe, expect, it } from 'vitest';
import {
  applySmartReducerDetailed,
  reduceGitDiff,
  reduceDbRows,
  reduceGrep,
  reduceRunCommand,
} from '../smart-reducers.js';

describe('smart reducer invariants', () => {
  it('keeps every git diff file represented and never exceeds cap', () => {
    const diff = [
      `diff --git a/first.ts b/first.ts\n--- a/first.ts\n+++ b/first.ts\n@@ -1 +1 @@\n${'-old\n+new\n'.repeat(300)}`,
      `diff --git a/second.ts b/second.ts\n--- a/second.ts\n+++ b/second.ts\n@@ -1 +1 @@\n-old\n+new`,
    ].join('\n');
    const out = reduceGitDiff({ content: diff, cap: 1000 });
    expect(out.applied).toBe(true);
    expect(out.content.length).toBeLessThanOrEqual(1000);
    expect(out.content).toContain('first.ts');
    expect(out.content).toContain('second.ts');
  });

  it('groups Windows grep paths by the full drive-qualified path', () => {
    const content = Array.from({ length: 20 }, (_, i) => `C:\\src\\foo.ts:${i + 1}: hit ${i}`).join('\n');
    const out = reduceGrep({ content, cap: 80 });
    expect(out.applied).toBe(true);
    expect(out.content.length).toBeLessThanOrEqual(80);
  });

  it('keeps run_command head/tail within the exact cap', () => {
    const content = `$ pnpm test\nexit code: 1\n--- stdout ---\n${'noise\n'.repeat(500)}FAIL final`;
    const out = reduceRunCommand({ content, cap: 300 });
    expect(out.applied).toBe(true);
    expect(out.content.length).toBeLessThanOrEqual(300);
    expect(out.content).toContain('FAIL final');
  });

  it('reports semantic versus hard-cap-neutral shaping explicitly', () => {
    const content = Array.from({ length: 30 }, (_, i) => `src/a.ts:${i + 1}: hit`).join('\n');
    const out = applySmartReducerDetailed('mcp__grep_code', content, 120);
    expect(out.report).toMatchObject({ kind: 'semantic', technique: 'mcp__grep_code', rawChars: content.length, cap: 120 });
    expect(out.report.shapedChars).toBe(out.content.length);
  });

  it('continues to json-crush when a registered reducer is a no-op', () => {
    const content = JSON.stringify({
      results: Array.from({ length: 20 }, (_, i) => ({ id: i, pad: 'x'.repeat(80) })),
      total: 20,
    });
    const out = applySmartReducerDetailed('mcp__grep_code', content, 900, {
      contentFormat: 'application/json',
    });
    expect(out.report.kind).toBe('json_crush');
    expect(out.content.length).toBeLessThanOrEqual(900);
    expect(JSON.parse(out.content)).toMatchObject({ total: 20 });
  });

  it('reduces database output only at row boundaries and rewrites a truthful footer', () => {
    const content = [
      'id | value',
      '--- | ---',
      ...Array.from({ length: 40 }, (_, i) => `${i} | ${'x'.repeat(80)}`),
      'rows=40 truncated=false',
    ].join('\n');
    const out = reduceDbRows({ content, cap: 600 });
    expect(out.applied).toBe(true);
    expect(out.content.length).toBeLessThanOrEqual(600);
    expect(out.content).toContain('id | value\n--- | ---');
    expect(out.content).toContain('complete row(s)');
    expect(out.content).toMatch(/rows=\d+ truncated=true/);
    expect(out.content).toContain('source_rows=40 source_truncated=false');
    const keptRows = out.content.split('\n').filter((line) => /^\d+ \| /.test(line));
    expect(keptRows.length).toBeGreaterThan(0);
    expect(keptRows.every((line) => line.endsWith('x'.repeat(80)))).toBe(true);
    expect(out.content).toContain(`rows=${keptRows.length} truncated=true`);
  });

  it('uses the real final database footer and never a footer-shaped cell value', () => {
    const content = [
      'id | value',
      '--- | ---',
      '1 | rows=999 truncated=false',
      `2 | ${'x'.repeat(500)}`,
      'rows=2 truncated=false',
    ].join('\n');
    const out = reduceDbRows({ content, cap: 260 });
    expect(out.applied).toBe(true);
    expect(out.content).toContain('source_rows=2 source_truncated=false');
    expect(out.content).not.toContain('source_rows=999');
  });
});
