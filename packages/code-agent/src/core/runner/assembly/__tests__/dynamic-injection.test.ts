/**
 * PR-F dynamic-injection tests.
 *
 * Pins the Kimi-style injection provider:
 *   - returns null when there's nothing new (no skills, no edits, no compact)
 *   - includes newly-registered skills exactly once
 *   - caps active files at maxActiveFiles (default 6)
 *   - mentions compaction when within 2 turns
 *   - testMode forces null (snapshot tests stay deterministic)
 */
import { describe, expect, it } from 'vitest';
import {
  computeDynamicInjection,
  formatDynamicInjection,
  type DynamicInjectionContext,
} from '../dynamic-injection.js';

function baseCtx(over: Partial<DynamicInjectionContext> = {}): DynamicInjectionContext {
  return {
    turn: 10,
    newlyRegisteredSkillIds: [],
    lastInjectedSkillIds: new Set(),
    recentlyEditedFiles: [],
    lastInjectedFiles: new Set(),
    recentCompactionAt: null,
    ...over,
  };
}

describe('computeDynamicInjection', () => {
  it('returns null when nothing new (no skills, no edits, no compact)', () => {
    expect(computeDynamicInjection(baseCtx())).toBeNull();
  });

  it('testMode short-circuits to null regardless of state', () => {
    const ctx = baseCtx({
      newlyRegisteredSkillIds: ['s1'],
      recentlyEditedFiles: ['a.ts'],
      recentCompactionAt: 9,
      testMode: true,
    });
    expect(computeDynamicInjection(ctx)).toBeNull();
  });

  it('includes newly registered skills exactly once', () => {
    const out = computeDynamicInjection(baseCtx({
      newlyRegisteredSkillIds: ['skill_a', 'skill_b'],
    }));
    expect(out).not.toBeNull();
    expect(out!.includedSkillIds).toEqual(['skill_a', 'skill_b']);
    expect(out!.reminder).toContain('skill_a');
    expect(out!.reminder).toContain('skill_b');
  });

  it('skips skills already in lastInjectedSkillIds', () => {
    const out = computeDynamicInjection(baseCtx({
      newlyRegisteredSkillIds: ['skill_a', 'skill_b'],
      lastInjectedSkillIds: new Set(['skill_a']),
    }));
    expect(out!.includedSkillIds).toEqual(['skill_b']);
    expect(out!.reminder).not.toContain('skill_a');
  });

  it('returns null when ALL newly-registered skills were already injected and no other signal', () => {
    expect(
      computeDynamicInjection(baseCtx({
        newlyRegisteredSkillIds: ['s1', 's2'],
        lastInjectedSkillIds: new Set(['s1', 's2']),
      })),
    ).toBeNull();
  });

  it('includes recently edited files up to maxActiveFiles', () => {
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts'];
    const out = computeDynamicInjection(baseCtx({
      recentlyEditedFiles: files,
      maxActiveFiles: 3,
    }));
    expect(out!.includedFiles).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(out!.reminder).toContain('+5 more truncated');
  });

  it('defaults maxActiveFiles to 6', () => {
    const files = Array.from({ length: 10 }, (_, i) => `f${i}.ts`);
    const out = computeDynamicInjection(baseCtx({ recentlyEditedFiles: files }));
    expect(out!.includedFiles.length).toBe(6);
  });

  it('skips files already in lastInjectedFiles', () => {
    const out = computeDynamicInjection(baseCtx({
      recentlyEditedFiles: ['a.ts', 'b.ts'],
      lastInjectedFiles: new Set(['a.ts']),
    }));
    expect(out!.includedFiles).toEqual(['b.ts']);
  });

  it('mentions compaction when within 2 turns', () => {
    const out = computeDynamicInjection(baseCtx({
      turn: 10,
      recentCompactionAt: 9, // 1 turn ago
    }));
    expect(out).not.toBeNull();
    expect(out!.reminder).toContain('compaction occurred');
    expect(out!.reminder).toContain('turn 9');
  });

  it('does NOT mention compaction once it is >2 turns old', () => {
    expect(
      computeDynamicInjection(baseCtx({
        turn: 10,
        recentCompactionAt: 7, // 3 turns ago
      })),
    ).toBeNull();
  });

  it('combines multiple signals into one reminder block', () => {
    const out = computeDynamicInjection(baseCtx({
      turn: 5,
      newlyRegisteredSkillIds: ['s1'],
      recentlyEditedFiles: ['a.ts'],
      recentCompactionAt: 4,
    }));
    expect(out!.reminder).toContain('compaction occurred');
    expect(out!.reminder).toContain('s1');
    expect(out!.reminder).toContain('a.ts');
  });

  it('result is deterministic given identical inputs', () => {
    const ctx = baseCtx({ newlyRegisteredSkillIds: ['s1'], recentlyEditedFiles: ['a.ts'] });
    expect(computeDynamicInjection(ctx)).toEqual(computeDynamicInjection(ctx));
  });
});

describe('formatDynamicInjection', () => {
  it('wraps body in <system-reminder> tags', () => {
    expect(formatDynamicInjection('hello world')).toBe(
      '<system-reminder>\nhello world\n</system-reminder>',
    );
  });
});
