import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __flushRendererVitalsForTests,
  __resetRendererVitalsForTests,
  ensureRendererVitals,
  getLongTasks,
  loafToRow,
  rendererEntryEpochMs,
} from '../renderer-vitals.js';

type Entry = Parameters<typeof loafToRow>[0];

const mk = (
  duration: number,
  name: string,
  scripts?: Array<{
    sourceURL?: string;
    invoker?: string;
    duration: number;
    forcedStyleAndLayoutDuration?: number;
  }>,
  startTime = 0,
): Entry => ({ duration, name, scripts, startTime } as unknown as Entry);

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

class MockPerformanceObserver {
  static supportedEntryTypes = ['long-animation-frame'];
  static instances: MockPerformanceObserver[] = [];

  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(private readonly callback: PerformanceObserverCallback) {
    MockPerformanceObserver.instances.push(this);
  }

  emit(entries: PerformanceEntry[]): void {
    this.callback({ getEntries: () => entries } as PerformanceObserverEntryList, this as unknown as PerformanceObserver);
  }
}

function acceptedResponse(count: number): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, accepted: count }),
  } as Response;
}

function postedEvents(call: unknown[]): Array<{ id: string; at: number }> {
  const init = call[1] as RequestInit;
  const body = JSON.parse(String(init.body)) as { events: Array<{ id: string; at: number }>; runId?: string };
  expect(body.runId).toBeUndefined();
  return body.events;
}

describe('loafToRow', () => {
  it('picks the longest-duration blocking script as the culprit', () => {
    const row = loafToRow(
      mk(300, 'frame', [
        { sourceURL: 'a.js', invoker: 'a', duration: 50 },
        { sourceURL: 'b.js', invoker: 'b', duration: 200 },
        { sourceURL: 'c.js', invoker: 'c', duration: 100 },
      ]),
      1_000,
    );
    expect(row).toEqual({ at: 1_000, durationMs: 300, name: 'b', script: 'b.js', kind: 'loaf' });
  });

  it('invoker wins over sourceURL and the persisted script drops query/hash data', () => {
    const row = loafToRow(
      mk(120, 'frame', [{ sourceURL: 'http://localhost/app.js?token=secret#chunk', invoker: 'render(MessageList)', duration: 120 }]),
      1_000,
    );
    expect(row.name).toBe('render(MessageList)');
    expect(row.script).toBe('http://localhost/app.js');
  });

  it('falls back to sourceURL when there is no invoker', () => {
    const row = loafToRow(mk(120, 'frame', [{ sourceURL: 'x.js', duration: 120 }]), 1_000);
    expect(row.name).toBe('x.js');
    expect(row.script).toBe('x.js');
  });

  it('falls back to the entry name when scripts are unavailable', () => {
    expect(loafToRow(mk(80, 'long-animation-frame'), 1_000)).toEqual({
      at: 1_000,
      durationMs: 80,
      name: 'long-animation-frame',
      script: undefined,
      kind: 'loaf',
    });
  });

  it('rounds the duration', () => {
    expect(loafToRow(mk(99.7, 'frame', []), 1_000).durationMs).toBe(100);
  });

  it('captures LoAF blocking and forced layout timing when Chromium provides it', () => {
    const entry = mk(125, 'frame', [
      { sourceURL: 'a.js', duration: 75, forcedStyleAndLayoutDuration: 2.24 },
      { sourceURL: 'b.js', duration: 50, forcedStyleAndLayoutDuration: 3.31 },
    ]) as Entry & { blockingDuration: number };
    entry.blockingDuration = 80.26;
    expect(loafToRow(entry, 1_000)).toMatchObject({
      blockingDurationMs: 80.3,
      forcedStyleAndLayoutDurationMs: 5.6,
    });
  });

  it('uses performance.timeOrigin + entry.startTime for the epoch', () => {
    expect(rendererEntryEpochMs(mk(80, 'frame', [], 432.6), 1_700_000_000_000)).toBe(1_700_000_000_433);
  });
});

describe('global renderer freeze collection', () => {
  let local: MemoryStorage;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    local = new MemoryStorage();
    MockPerformanceObserver.instances = [];
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('performance', { timeOrigin: 1_700_000_000_000 });
    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver);
    fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { events: unknown[] };
      return acceptedResponse(body.events.length);
    });
    vi.stubGlobal('fetch', fetchMock);
    __resetRendererVitalsForTests();
  });

  afterEach(() => {
    __resetRendererVitalsForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts one HMR-safe observer and persists the correct epoch before POST', async () => {
    ensureRendererVitals();
    ensureRendererVitals();
    expect(MockPerformanceObserver.instances).toHaveLength(1);
    expect(MockPerformanceObserver.instances[0]?.observe).toHaveBeenCalledWith({
      type: 'long-animation-frame',
      buffered: true,
    });

    MockPerformanceObserver.instances[0]?.emit([
      mk(84, 'frame', [{ sourceURL: 'react-dom_client.js?v=dev', duration: 84 }], 512.4),
    ]);
    expect(getLongTasks()[0]).toMatchObject({ at: 1_700_000_000_512, durationMs: 84 });
    expect(local.length).toBe(1);

    await __flushRendererVitalsForTests();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(postedEvents(fetchMock.mock.calls[0] as unknown[])[0]).toMatchObject({ at: 1_700_000_000_512 });
    expect(local.length).toBe(0);
  });

  it('recovers a previous renderer session without assigning it to the current run', async () => {
    ensureRendererVitals();
    MockPerformanceObserver.instances[0]?.emit([mk(120, 'frame', [], 25)]);
    const storedKey = local.key(0)!;
    const stored = JSON.parse(local.getItem(storedKey)!) as { events: Array<{ id: string }> };
    const originalId = stored.events[0]!.id;

    __resetRendererVitalsForTests({ preserveStorage: true });
    MockPerformanceObserver.instances = [];
    ensureRendererVitals();
    await __flushRendererVitalsForTests();

    const events = postedEvents(fetchMock.mock.calls[0] as unknown[]);
    expect(events[0]?.id).toBe(originalId);
    expect(local.length).toBe(0);
  });

  it('keeps cumulative report totals after a successful outbox drain', async () => {
    ensureRendererVitals();
    const observer = MockPerformanceObserver.instances[0]!;
    observer.emit([mk(100, 'first', [], 10)]);
    await __flushRendererVitalsForTests();
    expect(local.length).toBe(0);

    observer.emit([mk(110, 'second', [], 20)]);
    const stored = JSON.parse(local.getItem(local.key(0)!)!) as {
      events: unknown[];
      report: { count: number; totalDurationMs: number };
    };
    expect(stored.events).toHaveLength(1);
    expect(stored.report).toMatchObject({ count: 2, totalDurationMs: 210 });
  });

  it('retries the same deterministic event id when the first response is lost', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connection reset'));
    ensureRendererVitals();
    MockPerformanceObserver.instances[0]?.emit([mk(160, 'frame', [], 90)]);

    await __flushRendererVitalsForTests();
    expect(local.length).toBe(1);
    await __flushRendererVitalsForTests();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(postedEvents(fetchMock.mock.calls[0] as unknown[])[0]?.id)
      .toBe(postedEvents(fetchMock.mock.calls[1] as unknown[])[0]?.id);
    expect(local.length).toBe(0);
  });

  it('keeps the outbox when the backend could not persist the whole batch', async () => {
    fetchMock.mockResolvedValueOnce(acceptedResponse(0));
    ensureRendererVitals();
    MockPerformanceObserver.instances[0]?.emit([mk(140, 'frame', [], 75)]);

    await __flushRendererVitalsForTests();
    expect(local.length).toBe(1);
    await __flushRendererVitalsForTests();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(local.length).toBe(0);
  });

  it('does not acknowledge an event captured while an earlier batch is in flight', async () => {
    let resolveFirst!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }));
    ensureRendererVitals();
    const observer = MockPerformanceObserver.instances[0]!;
    observer.emit([mk(100, 'first', [], 10)]);

    const firstFlush = __flushRendererVitalsForTests();
    observer.emit([mk(110, 'second', [], 20)]);
    resolveFirst(acceptedResponse(1));
    await firstFlush;

    const queued = JSON.parse(local.getItem(local.key(0)!)!) as { events: Array<{ name: string }> };
    expect(queued.events.map((event) => event.name)).toEqual(['second']);
    await __flushRendererVitalsForTests();
    expect(local.length).toBe(0);
  });

  it('keeps batches within the server limit', async () => {
    ensureRendererVitals();
    MockPerformanceObserver.instances[0]?.emit(
      Array.from({ length: 51 }, (_, index) => mk(60 + index, 'frame', [], index + 1)),
    );

    await __flushRendererVitalsForTests();
    await __flushRendererVitalsForTests();

    expect(postedEvents(fetchMock.mock.calls[0] as unknown[])).toHaveLength(50);
    expect(postedEvents(fetchMock.mock.calls[1] as unknown[])).toHaveLength(1);
    expect(local.length).toBe(0);
  });

  it('preserves cumulative count and dropped totals when the outbox retains only 120 rows', () => {
    ensureRendererVitals();
    MockPerformanceObserver.instances[0]?.emit(
      Array.from({ length: 121 }, (_, index) => mk(60 + index, 'frame', [], index + 1)),
    );

    const stored = JSON.parse(local.getItem(local.key(0)!)!) as {
      events: unknown[];
      report: { count: number; dropped: number; loafCount: number; totalDurationMs: number };
    };
    expect(stored.events).toHaveLength(120);
    expect(stored.report).toMatchObject({ count: 121, dropped: 1, loafCount: 121 });
    expect(stored.report.totalDurationMs).toBe(
      Array.from({ length: 121 }, (_, index) => 60 + index).reduce((sum, value) => sum + value, 0),
    );
  });
});
