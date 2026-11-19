import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { atomicWriteJson } from '../atomic-file.js';
import { traceStorageOperation, measureStorage, storageTimingSnapshot } from '../storage-timing.js';

it('attributes injected fsync delay and queue wait separately, without weakening atomic durability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'storage-timing-'));
  const target = join(root, 'record.json');
  try {
    await traceStorageOperation({ sessionId: 'timing-test', operationId: 'commit-1' }, async () => {
      await measureStorage('test.queue', () => delay(25));
      await atomicWriteJson(target, { saved: true }, { faultInjector: async ({point}) => {
        if (point === 'atomic:after-temp-write-before-fsync') await delay(40);
      } });
    });
    const trace = [...storageTimingSnapshot()].reverse().find(row => row.sessionId === 'timing-test')!;
    expect(trace.failed).toBe(false);
    expect(trace.stages.find(s => s.name === 'test.queue')?.totalMs).toBeGreaterThanOrEqual(20);
    expect(trace.stages.find(s => s.name === 'atomic.fsync')?.totalMs).toBeGreaterThanOrEqual(35);
    expect(trace.stages.find(s => s.name === 'atomic.fsync')?.slowestFile).toBe('record.json');
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({saved:true});
  } finally {
    if (dirname(root) !== resolve(tmpdir())) throw new Error('Unexpected fixture root');
    await rm(root, {recursive:true, force:true});
  }
});

it('preserves rejection and does not mix concurrent session traces', async () => {
  const failing = traceStorageOperation({ sessionId:'one', operationId:'a' }, () => measureStorage('failed-stage', async () => { throw new Error('durability failed'); }));
  const healthy = traceStorageOperation({ sessionId:'two', operationId:'b' }, () => measureStorage('healthy-stage', async () => 42));
  await expect(failing).rejects.toThrow('durability failed');
  await expect(healthy).resolves.toBe(42);
  expect([...storageTimingSnapshot()].reverse().find(row => row.sessionId==='one')).toMatchObject({failed:true,stages:[{name:'failed-stage'}]});
  expect([...storageTimingSnapshot()].reverse().find(row => row.sessionId==='two')).toMatchObject({failed:false,stages:[{name:'healthy-stage'}]});
});
