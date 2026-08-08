/**
 * Regression: `createRunContext` must alias (NOT copy) the caller's tier
 * and pin Sets. The host runner's `promoteTier()` (expand_toolset) and
 * dispatch-time pins mutate those Sets mid-run; with the historical copy in
 * `ensureBootstrap`, promotions silently never reached `buildTools` under
 * the BT — expand_toolset was a no-op for the visible tool list.
 */
import { describe, it, expect } from 'vitest';
import { createRunContext, ensureBootstrap } from '../context.js';
import type { ToolTier } from '../../../../tools/tiers.js';
import type { RunnerOptions } from '../../types.js';

const noopEmit = (() => {}) as never;
const opts = (): RunnerOptions => ({ initialMessages: [], toolContext: {} } as unknown as RunnerOptions);

describe('ensureBootstrap', () => {
  it('mutates and returns the GIVEN Set (by-reference contract)', () => {
    const tiers = new Set<ToolTier>(['navigate']);
    const out = ensureBootstrap(tiers);
    expect(out).toBe(tiers);
    expect(tiers.has('bootstrap')).toBe(true);
  });

  it('null passes through (filtering disabled)', () => {
    expect(ensureBootstrap(null)).toBeNull();
  });
});

describe('createRunContext — shared mutable tool-surface state', () => {
  it('mid-run tier promotion on the host Set is visible to the context', () => {
    const hostTiers = new Set<ToolTier>(['bootstrap']);
    const ctx = createRunContext({
      opts: opts(),
      emit: noopEmit,
      initialTiers: hostTiers,
    });
    // Simulates CoderRunner.promoteTier('navigate') mid-run.
    hostTiers.add('navigate');
    expect(ctx.activeTiers?.has('navigate')).toBe(true);
  });

  it('mid-run pins on the host Set are visible to the context (and vice versa)', () => {
    const hostPins = new Set<string>();
    const ctx = createRunContext({
      opts: opts(),
      emit: noopEmit,
      initialTiers: new Set<ToolTier>(['bootstrap']),
      initialPins: hostPins,
    });
    ctx.pinnedTools.add('write_file'); // dispatch-time pin
    expect(hostPins.has('write_file')).toBe(true);
  });

  it('defaults to an empty pin set when none is provided', () => {
    const ctx = createRunContext({
      opts: opts(),
      emit: noopEmit,
      initialTiers: null,
    });
    expect(ctx.pinnedTools.size).toBe(0);
  });
});
