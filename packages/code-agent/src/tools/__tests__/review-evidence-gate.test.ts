/**
 * Onda 3 (PoC-or-Demote + pull-based prompt): evidence parsing, the
 * deterministic demotion gate, and the pull-based diff summary.
 */
import { describe, it, expect } from 'vitest';
import {
  parseReviewBlock,
  enforceEvidenceGate,
  summarizeDiffText,
  type ReviewFinding,
} from '../review-subagent.js';

describe('parseReviewBlock — evidence + verdict', () => {
  it('parses evidence probes and verdict', () => {
    const text = `<review>{"findings": [
      {"severity": "high", "verdict": "CONFIRMED",
       "code_location": {"file": "src/a.ts", "line_range": {"start": 4, "end": 4}},
       "issue": "throws on empty input",
       "evidence": [{"cmd": "node probe.mjs", "output_excerpt": "TypeError", "exit": 1}]}
    ]}</review>`;
    const parsed = parseReviewBlock(text)!;
    expect(parsed.findings[0].verdict).toBe('CONFIRMED');
    expect(parsed.findings[0].evidence).toEqual([
      { cmd: 'node probe.mjs', output_excerpt: 'TypeError', exit: 1 },
    ]);
  });

  it('drops malformed evidence entries but keeps the finding', () => {
    const text = `<review>{"findings": [
      {"severity": "low", "code_location": {"file": "a.ts"}, "issue": "x",
       "evidence": [{"output_excerpt": "no cmd"}, "garbage"]}
    ]}</review>`;
    const parsed = parseReviewBlock(text)!;
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0].evidence).toBeUndefined();
  });
});

describe('enforceEvidenceGate', () => {
  const finding = (over: Partial<ReviewFinding>): ReviewFinding => ({
    severity: 'high',
    file: 'src/a.ts',
    issue: 'null deref',
    ...over,
  });

  it('demotes evidence-less high/critical to medium PLAUSIBLE, with a visible note', () => {
    const [high, critical] = enforceEvidenceGate([
      finding({ severity: 'high' }),
      finding({ severity: 'critical' }),
    ]);
    for (const f of [high, critical]) {
      expect(f.severity).toBe('medium');
      expect(f.verdict).toBe('PLAUSIBLE');
      expect(f.issue).toMatch(/^\[demoted from (high|critical): no executed evidence\]/);
    }
  });

  it('keeps evidenced high findings and defaults their verdict to CONFIRMED', () => {
    const [f] = enforceEvidenceGate([
      finding({ evidence: [{ cmd: 'pnpm vitest run x', exit: 1 }] }),
    ]);
    expect(f.severity).toBe('high');
    expect(f.verdict).toBe('CONFIRMED');
    expect(f.issue).toBe('null deref');
  });

  it('leaves medium/low untouched apart from a PLAUSIBLE default', () => {
    const [f] = enforceEvidenceGate([finding({ severity: 'low' })]);
    expect(f.severity).toBe('low');
    expect(f.verdict).toBe('PLAUSIBLE');
  });
});

describe('summarizeDiffText', () => {
  it('summarizes per-file added/removed counts', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      ' context',
      '-old line',
      '+new line',
      '+another new line',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');
    const summary = summarizeDiffText(diff);
    expect(summary).toContain('- src/a.ts (+2/-1)');
    expect(summary).toContain('- src/b.ts (+1/-1)');
  });

  it('degrades gracefully on non-diff input', () => {
    expect(summarizeDiffText('not a diff at all')).toContain('could not summarize');
  });
});
