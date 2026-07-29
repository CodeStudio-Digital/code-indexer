import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CensusFrame } from '@mcp/shared/utils/process-census/types.js';
import {
  censusSnapshot,
  disposeCensus,
  setCensusSourceFactory,
} from '../census-service.js';
import type { CensusSource, CensusStatus } from '../census-source.js';

class FakeSource implements CensusSource {
  starts: number[] = [];
  stops = 0;
  state: CensusStatus = 'warming';
  frame: CensusFrame | null = null;

  start(intervalMs: number): void {
    this.starts.push(intervalMs);
  }

  stop(): void {
    this.stops += 1;
  }

  latest(): CensusFrame | null {
    return this.frame;
  }

  previous(): CensusFrame | null {
    return null;
  }

  status(): CensusStatus {
    return this.state;
  }
}

let made: FakeSource[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  made = [];
  setCensusSourceFactory(() => {
    const source = new FakeSource();
    made.push(source);
    return source;
  });
});

afterEach(() => {
  disposeCensus();
  vi.useRealTimers();
});

describe('censusSnapshot', () => {
  it('starts a collector on first access and reuses it afterwards', () => {
    censusSnapshot(2_000);
    censusSnapshot(2_000);
    expect(made).toHaveLength(1);
    expect(made[0]!.starts).toEqual([2_000]);
  });

  it('clamps the requested interval into the supported range', () => {
    censusSnapshot(10);
    expect(made[0]!.starts).toEqual([500]);
  });

  it('restarts the collector when the refresh rate changes', () => {
    censusSnapshot(2_000);
    censusSnapshot(1_000);
    expect(made).toHaveLength(2);
    expect(made[0]!.stops).toBe(1);
    expect(made[1]!.starts).toEqual([1_000]);
  });

  it('leaves the active rate alone when no interval is given', () => {
    // The kill endpoint re-reads the census; it must not fight the rate the
    // polling loop chose (which would respawn PowerShell on every kill).
    censusSnapshot(1_000);
    censusSnapshot();
    censusSnapshot();
    expect(made).toHaveLength(1);
    expect(made[0]!.stops).toBe(0);
  });

  it('still starts a collector when the first read passes no interval', () => {
    censusSnapshot();
    expect(made[0]!.starts).toEqual([2_000]);
  });

  it('surfaces the collector status and frames verbatim', () => {
    censusSnapshot(2_000);
    made[0]!.state = 'live';
    made[0]!.frame = { at: 5, rows: [], commandLines: new Map() };
    expect(censusSnapshot(2_000)).toMatchObject({ status: 'live', frame: { at: 5 } });
  });
});

describe('idle janitor', () => {
  it('stops the collector once nobody has polled for ~20s', () => {
    censusSnapshot(2_000);
    vi.advanceTimersByTime(15_000);
    expect(made[0]!.stops).toBe(0);
    vi.advanceTimersByTime(20_000);
    expect(made[0]!.stops).toBe(1);
  });

  it('keeps collecting while polls keep arriving', () => {
    censusSnapshot(2_000);
    for (let i = 0; i < 6; i += 1) {
      vi.advanceTimersByTime(9_000);
      censusSnapshot(2_000);
    }
    expect(made).toHaveLength(1);
    expect(made[0]!.stops).toBe(0);
  });

  it('starts a fresh collector after an idle stop', () => {
    censusSnapshot(2_000);
    vi.advanceTimersByTime(35_000);
    censusSnapshot(2_000);
    expect(made).toHaveLength(2);
  });
});

describe('disposeCensus', () => {
  it('stops the collector and is idempotent', () => {
    censusSnapshot(2_000);
    disposeCensus();
    disposeCensus();
    expect(made[0]!.stops).toBe(1);
  });

  it('leaves no timer able to resurrect work after disposal', () => {
    censusSnapshot(2_000);
    disposeCensus();
    vi.advanceTimersByTime(60_000);
    expect(made).toHaveLength(1);
    expect(made[0]!.stops).toBe(1);
  });
});
