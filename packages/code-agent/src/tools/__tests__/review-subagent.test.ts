/**
 * Onda 2b (Codex-parity): target-aware review prompt + structured
 * `code_location`. Contract:
 *   - reviewSystemPrompt varies its framing per target
 *   - parseReviewBlock accepts the new code_location shape AND legacy file/line,
 *     always populating both `file`/`line` (compat) and `code_location`
 */
import { describe, it, expect, vi } from 'vitest';
vi.mock('../implement-subagent.js', () => ({ runSubagent: vi.fn() }));
import { runSubagent } from '../implement-subagent.js';
import { reviewSystemPrompt, parseReviewBlock, runReviewSubagent } from '../review-subagent.js';
import type { SubagentParent, SubagentRunResult } from '../implement-subagent.js';

it.each(['completed', 'aborted', 'max_turns', 'error'] as const)('requires a completed review before accepting findings: %s', async reason => {
  const result: SubagentRunResult = { reason, finalText: '<review>{"findings":[]}</review>', usage: { input_tokens: 1, output_tokens: 1 }, sandboxViolations: [] };
  vi.mocked(runSubagent).mockResolvedValueOnce(result);
  const parent = { provider: {}, tools: [], ctx: { cwd: '/fixture' } } as unknown as SubagentParent;
  expect((await runReviewSubagent(parent, { spec: 'Review', diff: 'diff --git a/a b/a' })).parsed).toBe(reason === 'completed');
});

describe('reviewSystemPrompt — target framing', () => {
  it('frames uncommitted / base / commit differently', () => {
    expect(reviewSystemPrompt('uncommitted')).toContain('UNCOMMITTED working-tree');
    expect(reviewSystemPrompt('base')).toContain('against its base (merge-base)');
    expect(reviewSystemPrompt('commit')).toContain('SINGLE COMMIT');
  });
  it('defaults to uncommitted', () => {
    expect(reviewSystemPrompt()).toContain('UNCOMMITTED working-tree');
  });
});

describe('parseReviewBlock — code_location', () => {
  it('parses the clean-review response exactly as instructed', () => {
    const example = /For a clean review return exactly (.*?<\/review>)/.exec(reviewSystemPrompt())?.[1];
    expect(parseReviewBlock(example ?? '')).toEqual({ findings: [] });
  });
  it('parses the new code_location shape and mirrors file/line', () => {
    const text = `<review>{"findings":[{"severity":"high","code_location":{"file":"src/a.ts","line_range":{"start":42,"end":48}},"issue":"bug","suggested_fix":"fix it"}]}</review>`;
    const out = parseReviewBlock(text)!;
    expect(out.findings).toHaveLength(1);
    const f = out.findings[0];
    expect(f.file).toBe('src/a.ts');
    expect(f.line).toBe(42);
    expect(f.code_location).toEqual({ file: 'src/a.ts', line_range: { start: 42, end: 48 } });
  });

  it('still parses the legacy flat file/line shape and synthesizes code_location', () => {
    const text = `<review>{"findings":[{"severity":"low","file":"src/b.ts","line":7,"issue":"nit"}]}</review>`;
    const f = parseReviewBlock(text)!.findings[0];
    expect(f.file).toBe('src/b.ts');
    expect(f.line).toBe(7);
    expect(f.code_location).toEqual({ file: 'src/b.ts', line_range: { start: 7, end: 7 } });
  });

  it('accepts flat start_line/end_line inside code_location', () => {
    const text = `<review>{"findings":[{"severity":"medium","code_location":{"file":"c.ts","start_line":3,"end_line":9},"issue":"x"}]}</review>`;
    const f = parseReviewBlock(text)!.findings[0];
    expect(f.code_location?.line_range).toEqual({ start: 3, end: 9 });
    expect(f.line).toBe(3);
  });

  it('returns [] for an empty findings block and null for a missing block', () => {
    expect(parseReviewBlock('<review>{"findings":[]}</review>')!.findings).toEqual([]);
    expect(parseReviewBlock('no block here')).toBeNull();
  });
});
