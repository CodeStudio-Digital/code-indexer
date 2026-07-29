/**
 * The snapshot-review prompt is a hard contract with `parseFindings` in
 * snapshot-review-pipeline.ts. These tests pin the JSON field names and shape
 * so a future prompt edit can't silently break the parser.
 */
import { describe, it, expect } from 'vitest';
import { buildMessages } from '../snapshot-review-prompt.js';

const REQUIRED_KEYS = [
  'severity',
  'filePath',
  'baselineId',
  'hunkFingerprint',
  'oldLine',
  'newLine',
  'body',
  'suggestedFix',
  'diffExcerpt',
];

describe('buildMessages (snapshot-review prompt)', () => {
  it('emits a system + user message', () => {
    const msgs = buildMessages('file=src/a.ts baselineId=1 ...');
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
  });

  it('keeps the exact JSON contract field names the parser depends on', () => {
    const user = buildMessages('diff').find((m) => m.role === 'user')!.content;
    expect(user).toContain('"findings"');
    for (const key of REQUIRED_KEYS) {
      expect(user).toContain(key);
    }
    expect(user).toContain('"baselineId":"00000000-0000-4000-8000-000000000000"');
    expect(user).not.toContain('"baselineId":123');
  });

  it('appends the diff text to the user message', () => {
    const marker = 'file=src/unique-marker.ts baselineId=99';
    const user = buildMessages(marker).find((m) => m.role === 'user')!.content;
    expect(user).toContain(marker);
  });

  it('instructs strict JSON / no markdown', () => {
    const system = buildMessages('d').find((m) => m.role === 'system')!.content;
    expect(system.toLowerCase()).toContain('json');
  });

  it('is byte-identical with and without an empty context', () => {
    const plain = buildMessages('diff-text');
    expect(buildMessages('diff-text', undefined)).toEqual(plain);
    expect(buildMessages('diff-text', null)).toEqual(plain);
    expect(buildMessages('diff-text', '   ')).toEqual(plain);
    expect(plain.find((m) => m.role === 'user')!.content).not.toContain('Context (read-only');
  });

  it('prepends the context block between the rules and the diffs', () => {
    const user = buildMessages('DIFF-MARKER', '## Task context\nfix the bug').find(
      (m) => m.role === 'user',
    )!.content;
    const iCtx = user.indexOf('## Task context');
    const iDiffs = user.indexOf('Diffs:');
    const iDiff = user.indexOf('DIFF-MARKER');
    expect(iCtx).toBeGreaterThanOrEqual(0);
    expect(iCtx).toBeLessThan(iDiffs);
    expect(iDiffs).toBeLessThan(iDiff);
    // The preface pins the context as advisory, untrusted data.
    expect(user).toContain('untrusted data');
  });

  it('tells the reviewer (system) to never flag context-only lines', () => {
    const system = buildMessages('d').find((m) => m.role === 'system')!.content;
    expect(system).toContain('Context section');
    expect(system.toLowerCase()).toContain('untrusted');
  });
});
