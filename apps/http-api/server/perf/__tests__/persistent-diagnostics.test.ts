import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PerfSample } from '../perf-sampler.js';
import { PersistentPerfDiagnostics } from '../persistent-diagnostics.js';

const RUN_IDS = {
  first: '11111111-1111-4111-8111-111111111111',
  second: '22222222-2222-4222-8222-222222222222',
  third: '33333333-3333-4333-8333-333333333333',
  fourth: '44444444-4444-4444-8444-444444444444',
} as const;

const roots: string[] = [];
const journals: PersistentPerfDiagnostics[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mcp-perf-diagnostics-'));
  roots.push(root);
  return root;
}

function openJournal(
  rootDir: string,
  runId: string,
  startedAt: number,
  options: {
    segmentBytes?: number;
    maxSegments?: number;
    maxRuns?: number;
    writeBuffer?: (fd: number, buffer: Buffer) => void | Promise<void>;
  } = {},
): PersistentPerfDiagnostics {
  const journal = new PersistentPerfDiagnostics({
    rootDir,
    runId,
    pid: 4242,
    now: () => startedAt,
    ...options,
  });
  journals.push(journal);
  return journal;
}

function sample(at: number, rssMB = 100): PerfSample {
  return {
    at,
    main: {
      pid: 4242,
      uptimeSec: 10,
      rssMB,
      heapUsedMB: 40,
      heapTotalMB: 60,
      heapLimitMB: 4_096,
      externalMB: 2,
      arrayBuffersMB: 1,
      nativeMB: 40,
      loopP50Ms: 1,
      loopP99Ms: 8,
      loopMaxMs: 12,
    },
    processes: null,
    totalWorkingSetMB: null,
    workers: { company: [], coder: [], indexer: null },
    ledger: [],
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const journal of journals.splice(0)) await journal.abandon();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PersistentPerfDiagnostics', () => {
  it('keeps an interrupted run readable after a new run starts', async () => {
    const root = tempRoot();
    const interrupted = openJournal(root, RUN_IDS.first, 1_000);
    interrupted.recordSample(sample(1_010, 321));
    interrupted.recordFreeze({
      at: 1_020,
      source: 'event-loop',
      durationMs: 480,
      detail: 'test freeze',
    });
    await interrupted.abandon();

    const current = openJournal(root, RUN_IDS.second, 2_000);
    const runs = await current.listRunsAsync();
    expect(runs.map((run) => [run.id, run.status])).toEqual([
      [RUN_IDS.second, 'current'],
      [RUN_IDS.first, 'interrupted'],
    ]);

    const recovered = await current.readRunAsync(RUN_IDS.first);
    expect(recovered?.run.status).toBe('interrupted');
    expect(recovered?.samples).toHaveLength(1);
    expect(recovered?.samples[0].main.rssMB).toBe(321);
    expect(recovered?.freezes).toEqual([
      expect.objectContaining({ at: 1_020, durationMs: 480, source: 'event-loop' }),
    ]);
  });

  it('keeps valid records before a partially written JSONL tail', async () => {
    const root = tempRoot();
    const interrupted = openJournal(root, RUN_IDS.first, 1_000);
    interrupted.recordSample(sample(1_010, 222));
    await interrupted.abandon();
    appendFileSync(
      join(interrupted.runDir, 'events-000.jsonl'),
      '{"type":"sample","at":1011,"sample":',
      'utf8',
    );

    const current = openJournal(root, RUN_IDS.second, 2_000);
    const recovered = current.readRun(RUN_IDS.first);
    expect(recovered?.samples.map((row) => row.main.rssMB)).toEqual([222]);
    expect(recovered?.corruptLines).toBe(1);
    expect(recovered?.recordsRead).toBe(2); // segment_start + valid sample
    expect(recovered?.read).toMatchObject({ complete: false, reasons: ['corrupt-lines'] });
    const asyncRecovered = await current.readRunAsync(RUN_IDS.first);
    expect(asyncRecovered?.samples.map((row) => row.main.rssMB)).toEqual([222]);
    expect(asyncRecovered?.corruptLines).toBe(1);
  });

  it('distinguishes closed, interrupted, and current runs', async () => {
    const root = tempRoot();
    const closed = openJournal(root, RUN_IDS.first, 1_000);
    await closed.close('test-complete');

    const interrupted = openJournal(root, RUN_IDS.second, 2_000);
    await interrupted.abandon();

    const current = openJournal(root, RUN_IDS.third, 3_000);
    const byId = new Map((await current.listRunsAsync()).map((run) => [run.id, run]));

    expect(byId.get(RUN_IDS.first)).toMatchObject({
      status: 'closed',
      endedAt: 1_000,
    });
    expect(byId.get(RUN_IDS.second)?.status).toBe('interrupted');
    expect(byId.get(RUN_IDS.second)?.endedAt).toBeNull();
    expect(byId.get(RUN_IDS.third)).toMatchObject({
      status: 'current',
      endedAt: null,
    });
  });

  it('routes retried renderer freezes to their original run and fails closed for an unknown run id', async () => {
    const root = tempRoot();
    const interrupted = openJournal(root, RUN_IDS.first, 1_000);
    await interrupted.abandon();
    const current = openJournal(root, RUN_IDS.second, 2_000);
    const event = {
      id: 'loaf:1010000:420000',
      at: 1_010,
      durationMs: 420,
      name: 'long-animation-frame',
      kind: 'loaf' as const,
    };

    expect(await current.recordRendererFreeze(event)).toBe(true);
    expect(await current.recordRendererFreeze(event)).toBe(true); // retry is reader-idempotent
    expect((await current.readRunAsync(RUN_IDS.first))?.rendererFreezes).toEqual([event]);
    const recoveredText = readdirSync(interrupted.runDir)
      .filter((name) => name.startsWith('renderer-recovered-'))
      .map((name) => readFileSync(join(interrupted.runDir, name), 'utf8'))
      .join('');
    expect(recoveredText.match(/loaf:1010000:420000/g)).toHaveLength(1);
    expect((await current.readRunAsync(RUN_IDS.second))?.rendererFreezes).toEqual([]);

    expect(await current.recordRendererFreeze(
      { ...event, id: 'loaf:2010000:420000', at: 2_010 },
      '99999999-9999-4999-8999-999999999999',
    )).toBe(false);
    expect((await current.readRunAsync(RUN_IDS.second))?.rendererFreezes).toEqual([]);
  });

  it('does not acknowledge a renderer event after the journal handle is gone', async () => {
    const root = tempRoot();
    const journal = openJournal(root, RUN_IDS.first, 1_000);
    await journal.abandon();
    expect(await journal.recordRendererFreeze({
      id: 'loaf:1010000:420000',
      at: 1_010,
      durationMs: 420,
      name: 'long-animation-frame',
      kind: 'loaf',
    })).toBe(false);
  });

  it('writes a current-run renderer batch once per segment and keeps retries idempotent', async () => {
    const root = tempRoot();
    let rendererWrites = 0;
    const journal = openJournal(root, RUN_IDS.first, 1_000, {
      segmentBytes: 500,
      maxSegments: 8,
      writeBuffer: (fd, buffer) => {
        if (buffer.includes('"type":"renderer_freeze"')) rendererWrites++;
        writeSync(fd, buffer);
      },
    });
    const events = [1, 2, 3, 4].map((index) => ({
      id: `loaf:${index}`,
      at: 1_000 + index,
      durationMs: 100 + index,
      name: 'long-animation-frame',
      kind: 'loaf' as const,
    }));

    expect(await journal.recordRendererFreezes(events, RUN_IDS.first)).toBe(4);
    expect(rendererWrites).toBe(2);
    expect(readdirSync(journal.runDir).filter((name) => /^events-\d+\.jsonl$/.test(name))).toHaveLength(2);
    expect((await journal.readRunAsync(RUN_IDS.first))?.rendererFreezes.map((event) => event.id)).toEqual([
      'loaf:1',
      'loaf:2',
      'loaf:3',
      'loaf:4',
    ]);

    expect(await journal.recordRendererFreezes(events, RUN_IDS.first)).toBe(4);
    expect(rendererWrites).toBe(2);
    expect((await journal.readRunAsync(RUN_IDS.first))?.rendererFreezes).toHaveLength(4);
  });

  it('acknowledges only the renderer segments persisted before a batch write fails', async () => {
    const root = tempRoot();
    let rendererWrites = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const journal = openJournal(root, RUN_IDS.first, 1_000, {
      segmentBytes: 500,
      maxSegments: 8,
      writeBuffer: (fd, buffer) => {
        if (buffer.includes('"type":"renderer_freeze"') && ++rendererWrites === 2) {
          throw new Error('simulated second-segment write failure');
        }
        writeSync(fd, buffer);
      },
    });
    const events = [1, 2, 3, 4].map((index) => ({
      id: `loaf:failure:${index}`,
      at: 1_000 + index,
      durationMs: 100 + index,
      name: 'long-animation-frame',
      kind: 'loaf' as const,
    }));

    const acceptedBeforeFailure = await journal.recordRendererFreezes(events, RUN_IDS.first);
    expect(acceptedBeforeFailure).toBeGreaterThan(0);
    expect(acceptedBeforeFailure).toBeLessThan(events.length);
    expect((await journal.readRunAsync(RUN_IDS.first))?.rendererFreezes).toHaveLength(acceptedBeforeFailure);

    expect(await journal.recordRendererFreezes(events, RUN_IDS.first)).toBe(events.length);
    expect((await journal.readRunAsync(RUN_IDS.first))?.rendererFreezes.map((event) => event.id)).toEqual(
      events.map((event) => event.id),
    );
  });

  it('exports renderer aggregates and dropped counts beyond the 120-row detail limit', async () => {
    const root = tempRoot();
    const journal = openJournal(root, RUN_IDS.first, 1_000);
    const events = Array.from({ length: 140 }, (_, index) => ({
      id: `rv1:renderer-session:loaf:${index + 1}`,
      at: 1_001 + index,
      durationMs: 100 + index,
      name: 'long-animation-frame',
      kind: 'loaf' as const,
      blockingDurationMs: 50,
      forcedStyleAndLayoutDurationMs: 2,
    }));
    const totalDurationMs = events.reduce((total, event) => total + event.durationMs, 0) + 1_000;

    expect(await journal.recordRendererFreezes(events, RUN_IDS.first, {
      sessionId: 'renderer-session',
      createdAt: 1_000,
      count: 150,
      dropped: 10,
      totalDurationMs,
      maxDurationMs: 999,
      loafCount: 150,
      longtaskCount: 0,
      blockingDurationTotalMs: 7_500,
      forcedStyleAndLayoutDurationTotalMs: 300,
      firstAt: 1_001,
      lastAt: 1_150,
    })).toBe(140);

    const detail = (await journal.readRunAsync(RUN_IDS.first))!;
    expect(detail.rendererFreezes).toHaveLength(120);
    expect(detail.rendererFreezes[0]?.id).toBe('rv1:renderer-session:loaf:21');
    expect(detail.rendererFreezeSummary).toMatchObject({
      count: 150,
      persisted: 140,
      retained: 120,
      dropped: 30,
      droppedBeforePersist: 10,
      droppedFromDetail: 20,
      unavailable: 0,
      totalDurationMs,
      maxDurationMs: 999,
      blockingDurationTotalMs: 7_500,
      forcedStyleAndLayoutDurationTotalMs: 300,
    });
    expect(detail.read).toMatchObject({ complete: true, filesAvailable: 1, filesRead: 1 });
    expect(detail.read.cutoffAt).toBeGreaterThanOrEqual(detail.read.dataThroughAt!);

    const asyncDetail = await journal.readRunAsync(RUN_IDS.first);
    expect(asyncDetail?.rendererFreezeSummary).toEqual(detail.rendererFreezeSummary);
    expect(asyncDetail?.read.complete).toBe(true);
  });

  it('rotates by size and retains only the newest completed segments', async () => {
    const root = tempRoot();
    const journal = openJournal(root, RUN_IDS.first, 1_000, {
      segmentBytes: 1,
      maxSegments: 2,
    });

    journal.recordSlowCall('first', 101, 1_010);
    journal.recordSlowCall('second', 102, 1_020);
    journal.recordSlowCall('third', 103, 1_030);
    await journal.flush();
    const rotatedDetail = journal.readRun(RUN_IDS.first);

    expect(readdirSync(journal.runDir).filter((name) => name.endsWith('.jsonl')).sort()).toEqual([
      'events-002.jsonl',
      'events-003.jsonl',
    ]);
    expect(rotatedDetail?.slowCalls.map((row) => row.channel).sort()).toEqual([
      'second',
      'third',
    ]);
    expect(rotatedDetail?.read).toMatchObject({
      complete: false,
      reasons: ['segment-retention'],
    });
  });

  it('coalesces slow-call journal writes off the caller turn and flushes before reads', async () => {
    const root = tempRoot();
    let slowWrites = 0;
    const journal = openJournal(root, RUN_IDS.first, 1_000, {
      writeBuffer: (fd, buffer) => {
        if (buffer.includes('"type":"slow_call"')) slowWrites++;
        writeSync(fd, buffer);
      },
    });

    journal.recordSlowCall('first', 101, 1_010);
    journal.recordSlowCall('second', 102, 1_020);
    journal.recordSlowCall('third', 103, 1_030);
    expect(slowWrites).toBe(0);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(slowWrites).toBe(1);
    expect((await journal.readRunAsync(RUN_IDS.first))?.slowCalls).toHaveLength(3);

    journal.recordSlowCall('fourth', 104, 1_040);
    expect((await journal.readRunAsync(RUN_IDS.first))?.slowCalls).toHaveLength(4);
    expect(slowWrites).toBe(2);
  });

  it('keeps the producer event loop responsive while a journal write is pending', async () => {
    const root = tempRoot();
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let sampleWriteStarted = false;
    const journal = openJournal(root, RUN_IDS.first, 1_000, {
      writeBuffer: async (fd, buffer) => {
        if (buffer.includes('"type":"sample"')) {
          sampleWriteStarted = true;
          await writeGate;
        }
        writeSync(fd, buffer);
      },
    });

    journal.recordSample(sample(1_010, 456));
    await Promise.resolve();
    expect(sampleWriteStarted).toBe(true);

    // A pending filesystem operation must not keep Electron's JS turn parked.
    let nextTurnRan = false;
    await new Promise<void>((resolve) => setImmediate(() => {
      nextTurnRan = true;
      resolve();
    }));
    expect(nextTurnRan).toBe(true);

    releaseWrite();
    await journal.flush();
    expect((await journal.readRunAsync(RUN_IDS.first))?.samples[0]?.main.rssMB).toBe(456);
  });

  it('prunes the oldest runs while preserving the configured newest set', async () => {
    const root = tempRoot();
    const first = openJournal(root, RUN_IDS.first, 1_000, { maxRuns: 3 });
    await first.close();
    const second = openJournal(root, RUN_IDS.second, 2_000, { maxRuns: 3 });
    await second.close();
    const third = openJournal(root, RUN_IDS.third, 3_000, { maxRuns: 3 });
    await third.close();

    const current = openJournal(root, RUN_IDS.fourth, 4_000, { maxRuns: 3 });
    expect((await current.listRunsAsync()).map((run) => run.id)).toEqual([
      RUN_IDS.fourth,
      RUN_IDS.third,
      RUN_IDS.second,
    ]);
    expect(existsSync(first.runDir)).toBe(false);
    expect(existsSync(second.runDir)).toBe(true);
    expect(existsSync(third.runDir)).toBe(true);
    expect(existsSync(current.runDir)).toBe(true);
  });

  it('does not prune a marker-less run whose process is still alive', async () => {
    const root = tempRoot();
    const first = new PersistentPerfDiagnostics({
      rootDir: root,
      runId: RUN_IDS.first,
      pid: process.pid,
      now: () => 1_000,
      maxRuns: 1,
    });
    journals.push(first);
    await first.abandon();

    const second = new PersistentPerfDiagnostics({
      rootDir: root,
      runId: RUN_IDS.second,
      pid: process.pid,
      now: () => 2_000,
      maxRuns: 1,
    });
    journals.push(second);

    expect(existsSync(first.runDir)).toBe(true);
    expect((await second.listRunsAsync()).map((run) => run.id)).toEqual([RUN_IDS.second, RUN_IDS.first]);
  });
});
