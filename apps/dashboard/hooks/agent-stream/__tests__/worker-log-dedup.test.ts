import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetWorkerLogForTests,
  noteWorkerLogBus,
  peekWorkerLog,
  pushWorkerLog,
} from '../worker-log-store.js';
import { MAX_SESSIONS } from '../prune-sessions.js';
import type { WorkerLogEntry } from '../types.js';

function entry(message: string): WorkerLogEntry {
  return { ts: 1, event: message, level: 'info', category: 'runner', message, data: {} };
}

const sid = (id: number) =>
  `20000000-0000-4000-8000-${String(id).padStart(12, '0')}`;

/** Drive the commit via the store's 120ms timeout fallback (rAF never fires). */
function flush(): void {
  vi.advanceTimersByTime(150);
}

describe('worker-log-store seq dedup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Node test env has no rAF. Stub one that never fires so the store's
    // setTimeout fallback (120ms) is the single commit path under fake timers.
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    __resetWorkerLogForTests();
  });
  afterEach(() => {
    __resetWorkerLogForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('drops a second delivery of the same seq', () => {
    noteWorkerLogBus(sid(1), 'bus-a');
    pushWorkerLog(sid(1), entry('e0'), 0);
    pushWorkerLog(sid(1), entry('e0-dup'), 0);
    flush();
    expect(peekWorkerLog(sid(1)).map((e) => e.message)).toEqual(['e0']);
  });

  it('drops a replayed batch at or below the high-water mark', () => {
    noteWorkerLogBus(sid(1), 'bus-a');
    for (let seq = 0; seq <= 2; seq++) pushWorkerLog(sid(1), entry(`e${seq}`), seq);
    flush();
    // Reconnect on the same bus: server replays the buffered tail.
    expect(noteWorkerLogBus(sid(1), 'bus-a')).toBe(false);
    for (let seq = 0; seq <= 2; seq++) pushWorkerLog(sid(1), entry(`replay${seq}`), seq);
    pushWorkerLog(sid(1), entry('e3'), 3);
    flush();
    expect(peekWorkerLog(sid(1)).map((e) => e.message)).toEqual(['e0', 'e1', 'e2', 'e3']);
  });

  it('accepts the same seqs again after the bus changes (new run)', () => {
    noteWorkerLogBus(sid(1), 'bus-a');
    pushWorkerLog(sid(1), entry('runA-0'), 0);
    // New run → new bus → seq restarts at 0 and must NOT be treated as dup.
    expect(noteWorkerLogBus(sid(1), 'bus-b')).toBe(true);
    pushWorkerLog(sid(1), entry('runB-0'), 0);
    flush();
    expect(peekWorkerLog(sid(1)).map((e) => e.message)).toEqual(['runA-0', 'runB-0']);
  });

  it('always accepts entries without a seq', () => {
    noteWorkerLogBus(sid(1), 'bus-a');
    pushWorkerLog(sid(1), entry('no-seq'));
    pushWorkerLog(sid(1), entry('no-seq'));
    flush();
    expect(peekWorkerLog(sid(1))).toHaveLength(2);
  });

  it('keeps the mark across a remount-style full replay (since=-1)', () => {
    noteWorkerLogBus(sid(1), 'bus-a');
    for (let seq = 0; seq <= 4; seq++) pushWorkerLog(sid(1), entry(`e${seq}`), seq);
    flush();
    // Remount: a fresh openStream reattaches with since=-1 on the SAME bus —
    // the module-level mark (not the instance) must swallow the full replay.
    noteWorkerLogBus(sid(1), 'bus-a');
    for (let seq = 0; seq <= 4; seq++) pushWorkerLog(sid(1), entry(`replay${seq}`), seq);
    flush();
    expect(peekWorkerLog(sid(1))).toHaveLength(5);
  });

  it('starts a monotonic mark even without a bus_info preamble', () => {
    pushWorkerLog(sid(1), entry('e5'), 5);
    pushWorkerLog(sid(1), entry('e5-dup'), 5);
    pushWorkerLog(sid(1), entry('e6'), 6);
    flush();
    expect(peekWorkerLog(sid(1)).map((e) => e.message)).toEqual(['e5', 'e6']);
  });

  it('clears the dedup mark when an idle sid is evicted', () => {
    // Fill MAX_SESSIONS + 1 sids; sid 1 is touched first → evicted on commit.
    for (let index = 1; index <= MAX_SESSIONS + 1; index++) {
      noteWorkerLogBus(sid(index), 'bus-x');
      pushWorkerLog(sid(index), entry('seed'), 10);
    }
    flush();
    expect(peekWorkerLog(sid(1))).toHaveLength(0);
    // Mark was cleared with the slot: an old low seq is accepted again.
    pushWorkerLog(sid(1), entry('after-evict'), 0);
    flush();
    expect(peekWorkerLog(sid(1)).map((e) => e.message)).toEqual(['after-evict']);
  });
});
