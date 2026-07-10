import { describe, expect, it } from 'vitest';
import {
  applySmartReducerDetailed,
  reduceGitDiff,
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
});
