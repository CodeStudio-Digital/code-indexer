/**
 * PR-A Bug C: `estimated_complexity` is no longer orphan — it now scales
 * the per-kind baseline limits (maxToolCalls, timeoutMs) before they reach
 * the subagent runner.
 *
 *   small  → 0.5x
 *   medium → 1x
 *   large  → 2x
 *
 * stallMs is intentionally NOT scaled — a paused subagent is a paused
 * subagent regardless of how much work was budgeted.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyComplexityToLimits,
  DEFAULT_LIMITS,
  resolveTaskLimit,
} from '../execute-tasks/task-run-budget.js';
import type { CoderTask } from '@mcp/session-storage/session-state-types.js';

function task(overrides: Partial<CoderTask> = {}): CoderTask {
  return {
    id: 'tsk_base',
    title: 'Base',
    description: 'desc',
    files: [],
    references: [],
    depends_on: [],
    suggested_mode: 'subagent',
    estimated_complexity: 'medium',
    kind: 'implement',
    status: 'pending',
    ...overrides,
  };
}

describe('applyComplexityToLimits', () => {
  const base = { maxToolCalls: 80, timeoutMs: 20 * 60_000, stallMs: 120_000 };

  it('small complexity halves maxToolCalls and timeoutMs', () => {
    const out = applyComplexityToLimits('small', base);
    expect(out.maxToolCalls).toBe(40);
    expect(out.timeoutMs).toBe(10 * 60_000);
    expect(out.stallMs).toBe(120_000); // unchanged
  });

  it('medium complexity returns the base unchanged', () => {
    const out = applyComplexityToLimits('medium', base);
    expect(out).toEqual(base);
  });

  it('large complexity doubles maxToolCalls and timeoutMs', () => {
    const out = applyComplexityToLimits('large', base);
    expect(out.maxToolCalls).toBe(160);
    expect(out.timeoutMs).toBe(40 * 60_000);
    expect(out.stallMs).toBe(120_000); // unchanged
  });

  it('missing complexity returns base unchanged (treated as medium)', () => {
    const out = applyComplexityToLimits(undefined, base);
    expect(out).toEqual(base);
  });

  it('clamps maxToolCalls to >= 1 even for tiny baselines', () => {
    const tiny = { maxToolCalls: 1, timeoutMs: 5_000 };
    const out = applyComplexityToLimits('small', tiny);
    expect(out.maxToolCalls).toBeGreaterThanOrEqual(1);
  });

  it('clamps timeoutMs to >= 1000ms even for tiny baselines', () => {
    const tiny = { maxToolCalls: 10, timeoutMs: 1000 };
    const out = applyComplexityToLimits('small', tiny);
    expect(out.timeoutMs).toBeGreaterThanOrEqual(1000);
  });

  it('preserves undefined limit fields without coercing to 0', () => {
    const partial = { maxToolCalls: 100 } as const;
    const out = applyComplexityToLimits('large', partial);
    expect(out.maxToolCalls).toBe(200);
    expect(out.timeoutMs).toBeUndefined();
  });

  it('keeps zero unlimited across complexity multipliers', () => {
    expect(applyComplexityToLimits('small', { maxToolCalls: 0, timeoutMs: 0 }))
      .toEqual({ maxToolCalls: 0, timeoutMs: 0 });
    expect(applyComplexityToLimits('large', { maxToolCalls: 0, timeoutMs: 0 }))
      .toEqual({ maxToolCalls: 0, timeoutMs: 0 });
  });
});

describe('resolveTaskLimit (per-kind + complexity composition)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses implement defaults at medium complexity', () => {
    const out = resolveTaskLimit(task({ kind: 'implement', estimated_complexity: 'medium' }));
    expect(out.maxToolCalls).toBe(DEFAULT_LIMITS.implement.maxToolCalls);
    expect(out.timeoutMs).toBe(DEFAULT_LIMITS.implement.timeoutMs);
  });

  it('halves implement defaults at small complexity', () => {
    const out = resolveTaskLimit(task({ kind: 'implement', estimated_complexity: 'small' }));
    expect(out.maxToolCalls).toBe(DEFAULT_LIMITS.implement.maxToolCalls / 2);
  });

  it('doubles verify defaults at large complexity', () => {
    const out = resolveTaskLimit(task({ kind: 'verify', estimated_complexity: 'large' }));
    expect(out.maxToolCalls).toBe(DEFAULT_LIMITS.verify.maxToolCalls * 2);
    expect(out.timeoutMs).toBe(DEFAULT_LIMITS.verify.timeoutMs * 2);
  });

  it('halves the investigate hard-cap defaults at small complexity', () => {
    const out = resolveTaskLimit(task({ kind: 'investigate', estimated_complexity: 'small' }));
    expect(out.maxToolCalls).toBe(DEFAULT_LIMITS.investigate.maxToolCalls / 2);
    expect(out.timeoutMs).toBe(DEFAULT_LIMITS.investigate.timeoutMs / 2);
  });

  it('lets the admin per-profile override replace defaults before complexity scaling', () => {
    vi.stubEnv('CODER_TASK_INVESTIGATE_MAX_TOOLS', '999');
    const out = resolveTaskLimit(
      task({ kind: 'investigate', estimated_complexity: 'small' }),
      { maxToolCalls: 60, timeoutMs: null },
    );
    expect(out.maxToolCalls).toBe(30); // override 60, then small = 0.5x
    expect(out.timeoutMs).toBe(DEFAULT_LIMITS.investigate.timeoutMs / 2); // null axis falls through
  });

  it('keeps an explicit override 0 unlimited at every complexity', () => {
    const out = resolveTaskLimit(
      task({ kind: 'investigate', estimated_complexity: 'large' }),
      { maxToolCalls: 0, timeoutMs: 0 },
    );
    expect(out.maxToolCalls).toBe(0);
    expect(out.timeoutMs).toBe(0);
  });

  it('ignores retired process-env task limits', () => {
    vi.stubEnv('CODER_TASK_INVESTIGATE_MAX_TOOLS', '40');
    vi.stubEnv('CODER_TASK_INVESTIGATE_TIMEOUT_MS', '600000');
    const out = resolveTaskLimit(task({ kind: 'investigate', estimated_complexity: 'small' }));
    expect(out.maxToolCalls).toBe(DEFAULT_LIMITS.investigate.maxToolCalls / 2);
    expect(out.timeoutMs).toBe(DEFAULT_LIMITS.investigate.timeoutMs / 2);
  });
});
