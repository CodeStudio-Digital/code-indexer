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

  it('correction hint alone produces a reminder and flags the result', () => {
    const out = computeDynamicInjection(baseCtx({
      correctionHint: 'the user corrected you — remember() it',
    }));
    expect(out).not.toBeNull();
    expect(out!.reminder).toContain('remember() it');
    expect(out!.includedCorrectionHint).toBe(true);
  });

  it('null correction hint neither renders nor flags', () => {
    const out = computeDynamicInjection(baseCtx({
      correctionHint: null,
      newlyRegisteredSkillIds: ['s1'],
    }));
    expect(out).not.toBeNull();
    expect(out!.includedCorrectionHint).toBe(false);
    expect(out!.reminder).not.toContain('remember()');
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

  it('includes relevant memory up to maxMemoryItems and triggers a reminder alone', () => {
    const out = computeDynamicInjection(baseCtx({
      relevantMemory: [
        { id: 'm1', title: 'AuthDecision', content: 'JWT refresh tokens rotate.' },
        { id: 'm2', title: 'CacheNote', content: 'Redis L2.' },
        { id: 'm3', title: 'DbNote', content: 'better-sqlite3.' },
        { id: 'm4', title: 'DroppedItem', content: 'beyond the cap' },
      ],
      maxMemoryItems: 3,
    }));
    expect(out).not.toBeNull();
    expect(out!.includedMemoryIds).toEqual(['m1', 'm2', 'm3']);
    expect(out!.reminder).toContain('relevant project memory');
    expect(out!.reminder).toContain('AuthDecision');
    expect(out!.reminder).not.toContain('DroppedItem');
  });

  it('skips memory already injected (lastInjectedMemoryIds)', () => {
    const out = computeDynamicInjection(baseCtx({
      relevantMemory: [
        { id: 'm1', title: 'AlphaMemory', content: 'a' },
        { id: 'm2', title: 'BetaMemory', content: 'b' },
      ],
      lastInjectedMemoryIds: new Set(['m1']),
    }));
    expect(out!.includedMemoryIds).toEqual(['m2']);
    expect(out!.reminder).not.toContain('AlphaMemory');
    expect(out!.reminder).toContain('BetaMemory');
  });

  it('truncates long memory content with an ellipsis', () => {
    const out = computeDynamicInjection(baseCtx({
      relevantMemory: [{ id: 'm1', title: 'LongOne', content: 'x'.repeat(500) }],
    }));
    expect(out!.reminder).toContain('…');
  });

  it('marks a stale memory in the reminder', () => {
    const out = computeDynamicInjection(baseCtx({
      relevantMemory: [
        { id: 'm1', title: 'PricingRule', content: 'rounding logic', staleNote: 'src/x.ts changed since recorded' },
      ],
    }));
    expect(out!.reminder).toContain('(may be stale: src/x.ts changed since recorded)');
  });

  it('returns null when the only memory was already injected', () => {
    expect(computeDynamicInjection(baseCtx({
      relevantMemory: [{ id: 'm1', title: 'Solo', content: 'a' }],
      lastInjectedMemoryIds: new Set(['m1']),
    }))).toBeNull();
  });

  it('auto-recalls at most two conversation excerpts capped to 400 chars each', () => {
    const out = computeDynamicInjection(baseCtx({
      relevantConversationChapters: [
        { id: 'c1', title: 'First', content: 'a'.repeat(900) },
        { id: 'c2', title: 'Second', content: 'b'.repeat(900) },
        { id: 'c3', title: 'Third', content: 'must not be injected' },
      ],
    }))!;
    expect(out.includedConversationChapterIds).toEqual(['c1', 'c2']);
    expect(out.reminder).not.toContain('Third');
    expect(out.reminder).not.toContain('must not be injected');
    const excerptPayload = out.reminder.slice(out.reminder.indexOf('- First:'));
    expect((excerptPayload.match(/a/g) ?? []).length).toBeLessThanOrEqual(400);
    expect((excerptPayload.match(/b/g) ?? []).length).toBeLessThanOrEqual(400);
  });

  it('G3 — reminds not to re-run setup for already-executed skills after compaction', () => {
    const out = computeDynamicInjection(baseCtx({
      turn: 10,
      recentCompactionAt: 9,
      skillsAlreadyExecuted: ['turnstile-spin', 'docx'],
    }));
    expect(out).not.toBeNull();
    expect(out!.reminder).toContain('do NOT re-run their one-time setup');
    expect(out!.reminder).toContain('turnstile-spin, docx');
  });

  it('G3 — does NOT emit the skill marker without a recent compaction', () => {
    expect(
      computeDynamicInjection(baseCtx({
        turn: 10,
        recentCompactionAt: null,
        skillsAlreadyExecuted: ['turnstile-spin'],
      })),
    ).toBeNull();
  });

  it('G3 — post-compaction with no repeated skills shows the generic line only', () => {
    const out = computeDynamicInjection(baseCtx({
      turn: 10,
      recentCompactionAt: 9,
      skillsAlreadyExecuted: [],
    }));
    expect(out!.reminder).toContain('compaction occurred');
    expect(out!.reminder).not.toContain('do NOT re-run their one-time setup');
  });
});

describe('computeDynamicInjection — session state block', () => {
  const state = { block: '<session-state>\nplan [approved]: my plan\n</session-state>', hash: 'h1' };

  it('injects the block on turn 1 (resume) and reports its hash', () => {
    const out = computeDynamicInjection(baseCtx({ turn: 1, sessionState: state }));
    expect(out).not.toBeNull();
    expect(out!.reminder).toContain('<session-state>');
    expect(out!.reminder).toContain('my plan');
    expect(out!.includedSessionStateHash).toBe('h1');
  });

  it('injects the block right after a compaction even when hash unchanged', () => {
    const out = computeDynamicInjection(baseCtx({
      recentCompactionAt: 9,
      sessionState: state,
      lastInjectedSessionStateHash: 'h1',
    }));
    expect(out!.reminder).toContain('<session-state>');
  });

  it('does NOT re-inject an unchanged block on a steady mid-session turn', () => {
    expect(computeDynamicInjection(baseCtx({
      sessionState: state,
      lastInjectedSessionStateHash: 'h1',
    }))).toBeNull();
  });

  it('re-injects when the block hash changed (note added, todo moved…)', () => {
    const out = computeDynamicInjection(baseCtx({
      sessionState: { ...state, hash: 'h2' },
      lastInjectedSessionStateHash: 'h1',
    }));
    expect(out!.reminder).toContain('<session-state>');
    expect(out!.includedSessionStateHash).toBe('h2');
  });

  it('injects EVERY turn in short-window mode (sessionStateEveryTurn)', () => {
    const out = computeDynamicInjection(baseCtx({
      sessionState: state,
      sessionStateEveryTurn: true,
      lastInjectedSessionStateHash: 'h1', // unchanged — still injected
    }));
    expect(out!.reminder).toContain('<session-state>');
  });

  it('injects the project memory index on milestones with hash dedup', () => {
    const index = { text: 'project memory index:\n- [gotcha] ABI mismatch', hash: 'i1' };
    const onMilestone = computeDynamicInjection(baseCtx({ turn: 1, projectMemoryIndex: index }));
    expect(onMilestone!.reminder).toContain('memory index');
    expect(onMilestone!.includedProjectIndexHash).toBe('i1');
    // Steady turn, unchanged index → nothing.
    expect(computeDynamicInjection(baseCtx({
      projectMemoryIndex: index,
      lastInjectedProjectIndexHash: 'i1',
    }))).toBeNull();
  });

  it('orders the index BEFORE the state block in the reminder', () => {
    const out = computeDynamicInjection(baseCtx({
      turn: 1,
      sessionState: state,
      projectMemoryIndex: { text: 'project memory index:\n- [note] X', hash: 'i1' },
    }));
    const idx = out!.reminder.indexOf('memory index');
    const st = out!.reminder.indexOf('<session-state>');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(st).toBeGreaterThan(idx);
  });
});

describe('computeDynamicInjection — user preferences', () => {
  const userMem = { text: '<user-preferences>\n- keep files under 200 LOC', hash: 'u1' };

  it('injects on milestones (turn 1) and dedups on unchanged hash', () => {
    const onMilestone = computeDynamicInjection(baseCtx({ turn: 1, userMemoryIndex: userMem }));
    expect(onMilestone!.reminder).toContain('<user-preferences>');
    expect(onMilestone!.includedUserMemoryHash).toBe('u1');
    // Steady turn, unchanged block → nothing.
    expect(computeDynamicInjection(baseCtx({
      userMemoryIndex: userMem,
      lastInjectedUserMemoryHash: 'u1',
    }))).toBeNull();
  });

  it('re-injects when the user-preferences hash changes', () => {
    const out = computeDynamicInjection(baseCtx({
      userMemoryIndex: { text: '<user-preferences>\n- new pref', hash: 'u2' },
      lastInjectedUserMemoryHash: 'u1',
    }));
    expect(out!.reminder).toContain('<user-preferences>');
    expect(out!.includedUserMemoryHash).toBe('u2');
  });

  it('orders user preferences ABOVE the project memory index', () => {
    const out = computeDynamicInjection(baseCtx({
      turn: 1,
      userMemoryIndex: userMem,
      projectMemoryIndex: { text: 'project memory index:\n- [note] X', hash: 'i1' },
    }));
    const user = out!.reminder.indexOf('<user-preferences>');
    const proj = out!.reminder.indexOf('memory index');
    expect(user).toBeGreaterThanOrEqual(0);
    expect(proj).toBeGreaterThan(user);
  });
});

describe('computeDynamicInjection — preflight hint', () => {
  const hint = { text: '<preflight>\ntask_kind: bugfix\n</preflight>', hash: 'p1' };

  it('injects on turn 1 and reports the hash', () => {
    const out = computeDynamicInjection(baseCtx({ turn: 1, preflightHint: hint }));
    expect(out).not.toBeNull();
    expect(out!.reminder).toContain('<preflight>');
    expect(out!.includedPreflightHash).toBe('p1');
  });

  it('re-injects ≤2 turns after a compaction even when already injected', () => {
    const out = computeDynamicInjection(baseCtx({
      turn: 10,
      recentCompactionAt: 9,
      preflightHint: hint,
      lastInjectedPreflightHash: 'p1',
    }));
    expect(out!.reminder).toContain('<preflight>');
    expect(out!.includedPreflightHash).toBe('p1');
  });

  it('preserves Agent Decision guidance carried inside the preflight block', () => {
    const withGuidance = {
      text: '<preflight>\nagent decision guidance: agent_decision: intent=edit; agent=build\n</preflight>',
      hash: 'p2',
    };
    const out = computeDynamicInjection(baseCtx({ turn: 1, preflightHint: withGuidance }));
    expect(out!.reminder).toContain('agent decision guidance: agent_decision: intent=edit; agent=build');
    expect(out!.includedPreflightHash).toBe('p2');
  });

  it('does NOT re-inject on a steady mid-session turn once injected', () => {
    expect(computeDynamicInjection(baseCtx({
      preflightHint: hint,
      lastInjectedPreflightHash: 'p1',
    }))).toBeNull();
  });

  it('injects on any turn while never injected yet (hash mismatch)', () => {
    const out = computeDynamicInjection(baseCtx({ turn: 5, preflightHint: hint }));
    expect(out!.reminder).toContain('<preflight>');
  });

  it('renders the preflight block before skill/file/memory lines', () => {
    const out = computeDynamicInjection(baseCtx({
      turn: 1,
      preflightHint: hint,
      newlyRegisteredSkillIds: ['s1'],
      recentlyEditedFiles: ['a.ts'],
    }));
    const pf = out!.reminder.indexOf('<preflight>');
    const skills = out!.reminder.indexOf('skills registered');
    expect(pf).toBeGreaterThanOrEqual(0);
    expect(skills).toBeGreaterThan(pf);
  });
});

describe('formatDynamicInjection', () => {
  it('wraps body in <system-reminder> tags', () => {
    expect(formatDynamicInjection('hello world')).toBe(
      '<system-reminder>\nhello world\n</system-reminder>',
    );
  });
});
