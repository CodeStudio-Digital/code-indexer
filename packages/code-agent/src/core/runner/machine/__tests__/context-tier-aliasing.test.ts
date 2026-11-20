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
    // The context aliases the host runner's Set (no copy).
    hostTiers.add('navigate');
    expect(ctx.activeTiers?.has('navigate')).toBe(true);
  });

});
