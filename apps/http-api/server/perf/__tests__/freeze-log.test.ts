import { describe, it, expect } from 'vitest';
import { attributeStall, type StallEvidence } from '../freeze-log.js';

// Defaults (env unset): BUSY_FRACTION=0.35, WATCHDOG_INTERVAL_MS=250.
// windowMs ≈ monoLate + 250 (the real inter-tick gap the measurements span).
const NOW = 100_000;

/**
 * Evidence with ELU AVAILABLE — the plain-Node case (http-api over HTTP, CLI,
 * tests). `busyMs` mirrors what instrumentation would have reported, since in
 * this runtime both signals agree.
 */
function ev(over: Partial<StallEvidence> & Pick<StallEvidence, 'monoLate' | 'windowMs'>): StallEvidence {
  return {
    busyMs: 0,
    gcMs: 0,
    eluActiveMs: 0,
    coverage: 'observed',
    ...over,
  };
}

/** Evidence as seen in the Electron main process: ELU cannot be trusted. */
function electron(over: Partial<StallEvidence> & Pick<StallEvidence, 'monoLate' | 'windowMs'>): StallEvidence {
  return ev({ ...over, eluActiveMs: null });
}

describe('attributeStall', () => {
  it('idle loop across the window → starved, never pins a handler (the /current await false-positive)', () => {
    // /current awaited worker RPCs ~2s: loop idle the whole window.
    const r = attributeStall(
      ev({ monoLate: 2000, windowMs: 2250, eluActiveMs: 40 }),
      NOW,
      { channel: 'mcp:GET /api/admin/perf/current', at: NOW - 300 },
      null,
    );
    expect(r).toEqual({ source: 'starved' });
  });

  it('REGRESSION: pre-stall busy + idle overshoot → starved (active/window, not active/monoLate)', () => {
    // 180ms of handler work in the pre-stall slice, then a 300ms idle await.
    // Buggy active/monoLate = 180/300 = 0.6 → would mis-classify as a block.
    // Correct active/windowMs = 180/550 = 0.33 < 0.35 → starved.
    const r = attributeStall(
      ev({ monoLate: 300, windowMs: 550, eluActiveMs: 180, busyMs: 180 }),
      NOW,
      { channel: 'api:projects:get', at: NOW - 280 },
      null,
    );
    expect(r).toEqual({ source: 'starved' });
  });

  it('busy loop with a fresh in-flight handler → handler', () => {
    const r = attributeStall(
      ev({ monoLate: 300, windowMs: 550, busyMs: 520, eluActiveMs: 520 }),
      NOW,
      { channel: 'api:projects:get', at: NOW - 280 },
      null,
    );
    expect(r).toEqual({ source: 'handler', channel: 'api:projects:get' });
  });

  it('busy loop with a registered background activity → background', () => {
    const r = attributeStall(
      ev({ monoLate: 300, windowMs: 550, busyMs: 520, eluActiveMs: 520 }),
      NOW,
      { channel: 'coder-worker:spawn:42', at: NOW - 280, kind: 'background' },
      null,
    );
    expect(r).toEqual({ source: 'background', channel: 'coder-worker:spawn:42' });
  });

  it('busy loop but the in-flight channel is the observer (perf panel) → not blamed → event-loop', () => {
    const r = attributeStall(
      ev({ monoLate: 300, windowMs: 550, busyMs: 520, eluActiveMs: 520 }),
      NOW,
      { channel: 'mcp:GET /api/admin/perf/current', at: NOW - 280 },
      null,
    );
    expect(r).toEqual({ source: 'event-loop' });
  });

  it('busy loop, nothing in-flight, but a heavy non-observer handler just exited → handler via lastExit', () => {
    const r = attributeStall(
      ev({ monoLate: 300, windowMs: 550, busyMs: 520, eluActiveMs: 520 }),
      NOW,
      undefined,
      { channel: 'api:files:read', at: NOW - 100, durationMs: 310 },
    );
    expect(r).toEqual({ source: 'handler', channel: 'api:files:read' });
  });

  it('attributes a just-finished background activity on the post-block tick', () => {
    const r = attributeStall(
      ev({ monoLate: 300, windowMs: 550, busyMs: 520, eluActiveMs: 520 }),
      NOW,
      undefined,
      { channel: 'coder-worker:evict:42', at: NOW - 100, durationMs: 310, kind: 'background' },
    );
    expect(r).toEqual({ source: 'background', channel: 'coder-worker:evict:42' });
  });

  it('busy loop, in-flight handler entered far earlier (parked in await) → not the blocker → event-loop', () => {
    const r = attributeStall(
      ev({ monoLate: 300, windowMs: 550, busyMs: 520, eluActiveMs: 520 }),
      NOW,
      { channel: 'api:projectGit:status', at: NOW - 2000 },
      null,
    );
    expect(r).toEqual({ source: 'event-loop' });
  });

  it('busy loop, no suspects → event-loop', () => {
    const r = attributeStall(ev({ monoLate: 300, windowMs: 550, busyMs: 520, eluActiveMs: 520 }), NOW, undefined, null);
    expect(r).toEqual({ source: 'event-loop' });
  });

  it('non-positive monoLate → starved (guard, no divide-by-zero)', () => {
    const r = attributeStall(ev({ monoLate: 0, windowMs: 250 }), NOW, { channel: 'api:x', at: NOW }, null);
    expect(r).toEqual({ source: 'starved' });
  });

  it('lastExit duration far from the stall → not a match → event-loop', () => {
    const r = attributeStall(
      ev({ monoLate: 200, windowMs: 450, busyMs: 450, eluActiveMs: 450 }),
      NOW,
      undefined,
      { channel: 'api:projectGit:log', at: NOW - 50, durationMs: 600 },
    );
    expect(r).toEqual({ source: 'event-loop' });
  });

  // ─── Electron main: ELU unavailable ────────────────────────────────────
  // The bug this replaced: ELU returns active:0 unconditionally here, so
  // `activeMs / windowMs < 0.35` was always true and EVERY stall came back
  // `starved` — 185 journal records, 100% one label, with the handler /
  // background / event-loop branches unreachable.

  it('REGRESSION: never claims `starved` when ELU is untrustworthy', () => {
    // Sweep the shapes that used to collapse onto `starved`.
    const cases: StallEvidence[] = [
      electron({ monoLate: 300, windowMs: 550 }),
      electron({ monoLate: 6518, windowMs: 6768 }),
      electron({ monoLate: 31_740, windowMs: 31_990, coverage: 'silent' }),
      electron({ monoLate: 300, windowMs: 550, busyMs: 520 }),
      electron({ monoLate: 300, windowMs: 550, gcMs: 280 }),
    ];
    for (const c of cases) {
      const r = attributeStall(c, NOW, { channel: 'worker-rpc:memoryExtract', at: NOW - 27_000 }, null);
      expect(r.source).not.toBe('starved');
    }
  });

  it('no instrumented work, no GC, no ELU → unattributed (not starved)', () => {
    const r = attributeStall(electron({ monoLate: 6518, windowMs: 6768, coverage: 'silent' }), NOW, undefined, null);
    expect(r).toEqual({ source: 'unattributed' });
  });

  it('a long-lived async handler is not blamed just for being in flight', () => {
    // memoryExtract wraps an LLM round-trip: in flight ~27s, blocking nothing.
    const r = attributeStall(
      electron({ monoLate: 6518, windowMs: 6768 }),
      NOW,
      { channel: 'worker-rpc:memoryExtract', at: NOW - 27_000 },
      null,
    );
    expect(r).toEqual({ source: 'unattributed' });
  });

  it('instrumented sync section covering the stall → sync, named', () => {
    const r = attributeStall(
      electron({
        monoLate: 4800,
        windowMs: 5050,
        busyMs: 4900,
        topSync: { label: 'sql:INSERT INTO coder_messages (session_id, role, content) VALUES (?, ?, ?)', ms: 4850 },
      }),
      NOW,
      undefined,
      null,
    );
    expect(r).toEqual({
      source: 'sync',
      channel: 'sql:INSERT INTO coder_messages (session_id, role, content) VALUES (?, ?, ?)',
    });
  });

  it('sync busy but no single dominant section → falls through to handler attribution', () => {
    const r = attributeStall(
      electron({ monoLate: 300, windowMs: 550, busyMs: 520, topSync: { label: 'sql:SELECT 1', ms: 20 } }),
      NOW,
      { channel: 'api:projects:get', at: NOW - 280 },
      null,
    );
    expect(r).toEqual({ source: 'handler', channel: 'api:projects:get' });
  });

  it('the observer is never blamed, even as the top sync section', () => {
    const r = attributeStall(
      electron({
        monoLate: 300,
        windowMs: 550,
        busyMs: 520,
        topSync: { label: 'mcp:GET /api/admin/perf/freezes', ms: 500 },
      }),
      NOW,
      undefined,
      null,
    );
    expect(r).toEqual({ source: 'event-loop' });
  });

  it('GC pause covering the stall → gc', () => {
    const r = attributeStall(electron({ monoLate: 400, windowMs: 650, gcMs: 380 }), NOW, undefined, null);
    expect(r).toEqual({ source: 'gc' });
  });

  it('GC wins over a busy in-flight handler (the pause is observed, not inferred)', () => {
    const r = attributeStall(
      electron({ monoLate: 400, windowMs: 650, busyMs: 600, gcMs: 380 }),
      NOW,
      { channel: 'api:projects:get', at: NOW - 380 },
      null,
    );
    expect(r).toEqual({ source: 'gc' });
  });

  it('a trivial GC inside a long stall does not explain it', () => {
    const r = attributeStall(electron({ monoLate: 6000, windowMs: 6250, gcMs: 12 }), NOW, undefined, null);
    expect(r).toEqual({ source: 'unattributed' });
  });

  it('ELU available and busy but nothing instrumented → event-loop, still not starved', () => {
    const r = attributeStall(
      ev({ monoLate: 300, windowMs: 550, eluActiveMs: 520, busyMs: 0 }),
      NOW,
      undefined,
      null,
    );
    expect(r).toEqual({ source: 'event-loop' });
  });
});
