import { describe, it, expect } from 'vitest';
import { attributeStall } from '../freeze-log.js';

// Defaults (env unset): BUSY_FRACTION=0.35, WATCHDOG_INTERVAL_MS=250.
// attributeStall(monoLate, activeMs, windowMs, now, inFlight, lastExit).
// windowMs ≈ monoLate + 250 (the real inter-tick gap the ELU delta spans).
const NOW = 100_000;

describe('attributeStall', () => {
  it('idle loop across the window → starved, never pins a handler (the /current await false-positive)', () => {
    // /current awaited worker RPCs ~2s: loop idle the whole window.
    const r = attributeStall(2000, 40, 2250, NOW, { channel: 'mcp:GET /api/admin/perf/current', at: NOW - 300 }, null);
    expect(r).toEqual({ source: 'starved' });
  });

  it('REGRESSION: pre-stall busy + idle overshoot → starved (active/window, not active/monoLate)', () => {
    // 180ms of handler work in the pre-stall slice, then a 300ms idle await.
    // Buggy active/monoLate = 180/300 = 0.6 → would mis-classify as a block.
    // Correct active/windowMs = 180/550 = 0.33 < 0.35 → starved.
    const r = attributeStall(300, 180, 550, NOW, { channel: 'api:projects:get', at: NOW - 280 }, null);
    expect(r).toEqual({ source: 'starved' });
  });

  it('busy loop with a fresh in-flight handler → handler', () => {
    const r = attributeStall(300, 520, 550, NOW, { channel: 'api:projects:get', at: NOW - 280 }, null);
    expect(r).toEqual({ source: 'handler', channel: 'api:projects:get' });
  });

  it('busy loop with a registered background activity → background', () => {
    const r = attributeStall(300, 520, 550, NOW, {
      channel: 'coder-worker:spawn:42',
      at: NOW - 280,
      kind: 'background',
    }, null);
    expect(r).toEqual({ source: 'background', channel: 'coder-worker:spawn:42' });
  });

  it('busy loop but the in-flight channel is the observer (perf panel) → not blamed → event-loop', () => {
    const r = attributeStall(300, 520, 550, NOW, { channel: 'mcp:GET /api/admin/perf/current', at: NOW - 280 }, null);
    expect(r).toEqual({ source: 'event-loop' });
  });

  it('busy loop, nothing in-flight, but a heavy non-observer handler just exited → handler via lastExit', () => {
    const r = attributeStall(300, 520, 550, NOW, undefined, { channel: 'api:files:read', at: NOW - 100, durationMs: 310 });
    expect(r).toEqual({ source: 'handler', channel: 'api:files:read' });
  });

  it('attributes a just-finished background activity on the post-block tick', () => {
    const r = attributeStall(300, 520, 550, NOW, undefined, {
      channel: 'coder-worker:evict:42',
      at: NOW - 100,
      durationMs: 310,
      kind: 'background',
    });
    expect(r).toEqual({ source: 'background', channel: 'coder-worker:evict:42' });
  });

  it('busy loop, in-flight handler entered far earlier (parked in await) → not the blocker → event-loop', () => {
    const r = attributeStall(300, 520, 550, NOW, { channel: 'api:projectGit:status', at: NOW - 2000 }, null);
    expect(r).toEqual({ source: 'event-loop' });
  });

  it('busy loop, no suspects → event-loop', () => {
    expect(attributeStall(300, 520, 550, NOW, undefined, null)).toEqual({ source: 'event-loop' });
  });

  it('non-positive monoLate → starved (guard, no divide-by-zero)', () => {
    expect(attributeStall(0, 0, 250, NOW, { channel: 'api:x', at: NOW }, null)).toEqual({ source: 'starved' });
  });

  it('lastExit duration far from the stall → not a match → event-loop', () => {
    const r = attributeStall(200, 450, 450, NOW, undefined, { channel: 'api:projectGit:log', at: NOW - 50, durationMs: 600 });
    expect(r).toEqual({ source: 'event-loop' });
  });
});
