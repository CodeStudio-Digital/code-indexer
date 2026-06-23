import { describe, it, expect } from 'vitest';
import { createRespawnPolicy } from '../respawn-policy.js';

describe('createRespawnPolicy', () => {
  it('backs off exponentially up to the ceiling', () => {
    const p = createRespawnPolicy({ baseDelayMs: 250, maxDelayMs: 1000, maxConsecutiveFailures: 10 });
    expect(p.onCrash()).toEqual({ kind: 'respawn', delayMs: 250 });
    expect(p.onCrash()).toEqual({ kind: 'respawn', delayMs: 500 });
    expect(p.onCrash()).toEqual({ kind: 'respawn', delayMs: 1000 });
    expect(p.onCrash()).toEqual({ kind: 'respawn', delayMs: 1000 }); // capped
    expect(p.consecutiveFailures()).toBe(4);
  });

  it('a healthy response resets the streak', () => {
    const p = createRespawnPolicy({ baseDelayMs: 100 });
    p.onCrash();
    p.onCrash();
    p.onHealthy();
    expect(p.consecutiveFailures()).toBe(0);
    expect(p.onCrash()).toEqual({ kind: 'respawn', delayMs: 100 }); // back to base
  });

  it('degrades at the consecutive-failure cap and stays degraded', () => {
    const p = createRespawnPolicy({ baseDelayMs: 1, maxConsecutiveFailures: 3 });
    expect(p.onCrash().kind).toBe('respawn');
    expect(p.onCrash().kind).toBe('respawn');
    expect(p.onCrash().kind).toBe('degraded');
    expect(p.isDegraded()).toBe(true);
    p.onHealthy(); // ignored once degraded
    expect(p.isDegraded()).toBe(true);
    expect(p.onCrash().kind).toBe('degraded');
  });

  it('defaults: 250ms base, 10s cap, 5 failures', () => {
    const p = createRespawnPolicy();
    const delays = [p.onCrash(), p.onCrash(), p.onCrash(), p.onCrash()];
    expect(delays.map((d) => d.kind === 'respawn' ? d.delayMs : -1)).toEqual([250, 500, 1000, 2000]);
    expect(p.onCrash().kind).toBe('degraded');
  });
});
