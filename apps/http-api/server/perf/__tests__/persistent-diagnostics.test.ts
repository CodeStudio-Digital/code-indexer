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
    writeBuffer?: (fd: number, buffer: Buffer) => void;
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

afterEach(() => {
  vi.restoreAllMocks();
  for (const journal of journals.splice(0)) journal.abandon();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PersistentPerfDiagnostics', () => {
  it('keeps an interrupted run readable after a new run starts', () => {
    const root = tempRoot();
    const interrupted = openJournal(root, RUN_IDS.first, 1_000);
    interrupted.recordSample(sample(1_010, 321));
    interrupted.recordFreeze({
      at: 1_020,
      source: 'event-loop',
      durationMs: 480,
      detail: 'test freeze',
    });
    interrupted.abandon();

    const current = openJournal(root, RUN_IDS.second, 2_000);
    const runs = current.listRuns();
    expect(runs.map((run) => [run.id, run.status])).toEqual([
      [RUN_IDS.second, 'current'],
      [RUN_IDS.first, 'interrupted'],
    ]);

    const recovered = current.readRun(RUN_IDS.first);
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
    interrupted.abandon();
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
    const asyncRecovered = await current.readRunAsync(RUN_IDS.first);
    expect(asyncRecovered?.samples.map((row) => row.main.rssMB)).toEqual([222]);
    expect(asyncRecovered?.corruptLines).toBe(1);
  });

  it('distinguishes closed, interrupted, and current runs', () => {
    const root = tempRoot();
    const closed = openJournal(root, RUN_IDS.first, 1_000);
    closed.close('test-complete');

    const interrupted = openJournal(root, RUN_IDS.second, 2_000);
    interrupted.abandon();

    const current = openJournal(root, RUN_IDS.third, 3_000);
    const byId = new Map(current.listRuns().map((run) => [run.id, run]));

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

  it('routes retried renderer freezes to their original run and fails closed for an unknown run id', () => {
    const root = tempRoot();
    const interrupted = openJournal(root, RUN_IDS.first, 1_000);
    interrupted.abandon();
    const current = openJournal(root, RUN_IDS.second, 2_000);
    const event = {
      id: 'loaf:1010000:420000',
      at: 1_010,
      durationMs: 420,
      name: 'long-animation-frame',
      kind: 'loaf' as const,
    };

    expect(current.recordRendererFreeze(event)).toBe(true);
    expect(current.recordRendererFreeze(event)).toBe(true); // retry is reader-idempotent
    expect(current.readRun(RUN_IDS.first)?.rendererFreezes).toEqual([event]);
    const recoveredText = readdirSync(interrupted.runDir)
      .filter((name) => name.startsWith('renderer-recovered-'))
      .map((name) => readFileSync(join(interrupted.runDir, name), 'utf8'))
      .join('');
    expect(recoveredText.match(/loaf:1010000:420000/g)).toHaveLength(1);
    expect(current.readRun(RUN_IDS.second)?.rendererFreezes).toEqual([]);

    expect(current.recordRendererFreeze(
      { ...event, id: 'loaf:2010000:420000', at: 2_010 },
      '99999999-9999-4999-8999-999999999999',
    )).toBe(false);
    expect(current.readRun(RUN_IDS.second)?.rendererFreezes).toEqual([]);
  });

  it('does not acknowledge a renderer event after the journal handle is gone', () => {
    const root = tempRoot();
    const journal = openJournal(root, RUN_IDS.first, 1_000);
    journal.abandon();
    expect(journal.recordRendererFreeze({
      id: 'loaf:1010000:420000',
      at: 1_010,
      durationMs: 420,
      name: 'long-animation-frame',
      kind: 'loaf',
    })).toBe(false);
  });

  it('writes a current-run renderer batch once per segment and keeps retries idempotent', () => {
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

    expect(journal.recordRendererFreezes(events, RUN_IDS.first)).toBe(4);
    expect(rendererWrites).toBe(2);
    expect(readdirSync(journal.runDir).filter((name) => /^events-\d+\.jsonl$/.test(name))).toHaveLength(2);
    expect(journal.readRun(RUN_IDS.first)?.rendererFreezes.map((event) => event.id)).toEqual([
      'loaf:1',
      'loaf:2',
      'loaf:3',
      'loaf:4',
    ]);

    expect(journal.recordRendererFreezes(events, RUN_IDS.first)).toBe(4);
    expect(rendererWrites).toBe(2);
    expect(journal.readRun(RUN_IDS.first)?.rendererFreezes).toHaveLength(4);
  });

  it('acknowledges only the renderer segments persisted before a batch write fails', () => {
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

    const acceptedBeforeFailure = journal.recordRendererFreezes(events, RUN_IDS.first);
    expect(acceptedBeforeFailure).toBeGreaterThan(0);
    expect(acceptedBeforeFailure).toBeLessThan(events.length);
    expect(journal.readRun(RUN_IDS.first)?.rendererFreezes).toHaveLength(acceptedBeforeFailure);

    expect(journal.recordRendererFreezes(events, RUN_IDS.first)).toBe(events.length);
    expect(journal.readRun(RUN_IDS.first)?.rendererFreezes.map((event) => event.id)).toEqual(
      events.map((event) => event.id),
    );
  });

  it('rotates by size and retains only the newest completed segments', () => {
    const root = tempRoot();
    const journal = openJournal(root, RUN_IDS.first, 1_000, {
      segmentBytes: 1,
      maxSegments: 2,
    });

    journal.recordSlowCall('first', 101, 1_010);
    journal.recordSlowCall('second', 102, 1_020);
    journal.recordSlowCall('third', 103, 1_030);

    expect(readdirSync(journal.runDir).filter((name) => name.endsWith('.jsonl')).sort()).toEqual([
      'events-002.jsonl',
      'events-003.jsonl',
    ]);
    expect(journal.readRun(RUN_IDS.first)?.slowCalls.map((row) => row.channel).sort()).toEqual([
      'second',
      'third',
    ]);
  });

  it('prunes the oldest runs while preserving the configured newest set', () => {
    const root = tempRoot();
    const first = openJournal(root, RUN_IDS.first, 1_000, { maxRuns: 3 });
    first.close();
    const second = openJournal(root, RUN_IDS.second, 2_000, { maxRuns: 3 });
    second.close();
    const third = openJournal(root, RUN_IDS.third, 3_000, { maxRuns: 3 });
    third.close();

    const current = openJournal(root, RUN_IDS.fourth, 4_000, { maxRuns: 3 });
    expect(current.listRuns().map((run) => run.id)).toEqual([
      RUN_IDS.fourth,
      RUN_IDS.third,
      RUN_IDS.second,
    ]);
    expect(existsSync(first.runDir)).toBe(false);
    expect(existsSync(second.runDir)).toBe(true);
    expect(existsSync(third.runDir)).toBe(true);
    expect(existsSync(current.runDir)).toBe(true);
  });

  it('does not prune a marker-less run whose process is still alive', () => {
    const root = tempRoot();
    const first = new PersistentPerfDiagnostics({
      rootDir: root,
      runId: RUN_IDS.first,
      pid: process.pid,
      now: () => 1_000,
      maxRuns: 1,
    });
    journals.push(first);
    first.abandon();

    const second = new PersistentPerfDiagnostics({
      rootDir: root,
      runId: RUN_IDS.second,
      pid: process.pid,
      now: () => 2_000,
      maxRuns: 1,
    });
    journals.push(second);

    expect(existsSync(first.runDir)).toBe(true);
    expect(second.listRuns().map((run) => run.id)).toEqual([RUN_IDS.second, RUN_IDS.first]);
  });
});
