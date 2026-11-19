import { afterEach, describe, expect, it, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import { GitReadExecutor } from '../git-read-runner.js';
import { isReadOnlyGit } from '../git-read-protocol.js';
import { listTrackedProcessTrees } from '@mcp/shared/utils/process-tree.js';
import type { GitProcessInput } from '../git-process.js';

const readers: GitReadExecutor[] = [];
afterEach(async () => { await Promise.all(readers.splice(0).map(reader => reader.dispose())); });
const input = (overrides: Partial<GitProcessInput> = {}): GitProcessInput => ({
  cwd: process.cwd(), args: ['status'], env: process.env, timeoutMs: 5_000, maxOutputBytes: 1024, ...overrides,
});
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// The fixture deliberately blocks/spawns in the THREAD. The injected factory
// exercises the production host queue, deadline, PID ownership and shutdown.
const fixture = `
const { parentPort, workerData } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const jobs = new Map(); let closing = false;
parentPort.on('message', m => {
  if (m.type === 'dispose') { closing = true; for (const child of jobs.values()) child.kill(); if (!jobs.size) parentPort.close(); return; }
  if (m.type === 'cancel') { jobs.get(m.id)?.kill(); return; }
  if (m.input.args[0] === 'worktree') { parentPort.postMessage({type:'result',id:m.id,result:{code:0,stdout:'inventory',stderr:''}}); return; }
  if (m.input.args[0] === 'check-ref-format') { parentPort.postMessage({type:'result',id:m.id,result:{code:0,stdout:'warm',stderr:''}}); return; }
  if (workerData.busy) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.busy);
  if (!workerData.hold) { parentPort.postMessage({ type:'result', id:m.id, result:{code:0,stdout:'ok',stderr:''} }); return; }
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,stdio:'ignore'});
  jobs.set(m.id, child); const slot = new Int32Array(m.pid); Atomics.store(slot,0,child.pid);
  Atomics.store(new Int32Array(workerData.pid),0,child.pid);
  if (workerData.crash) process.exit(17);
  parentPort.postMessage({type:'spawned',id:m.id,pid:child.pid});
  child.on('exit', () => { jobs.delete(m.id); Atomics.store(slot,0,0);
    parentPort.postMessage({type:'result',id:m.id,result:{code:-1,stdout:'',stderr:'closed'}});
    if(closing && !jobs.size) parentPort.close(); });
});`;

function fake(options: { busy?: number; hold?: boolean; crash?: boolean } = {}) {
  const pid = new Int32Array(new SharedArrayBuffer(4));
  let created = 0, spawned = 0;
  const spawnWaiters: Array<{ count: number; resolve(): void }> = [];
  const reader = new GitReadExecutor(() => {
    created++;
    const worker = new Worker(fixture, { eval: true, workerData: { ...options, pid: pid.buffer } });
    worker.on('message', message => {
      if (message.type === 'spawned') {
        spawned++;
        for (const waiter of spawnWaiters) if (spawned >= waiter.count) waiter.resolve();
      }
    });
    return worker;
  });
  readers.push(reader);
  return { reader, pid, created: () => created, spawned: () => spawned,
    warm: () => reader.run(input({ args: ['check-ref-format', '--branch', 'warm'], timeoutMs: 0 })),
    untilSpawned: (count: number) => spawned >= count ? Promise.resolve()
      : new Promise<void>(resolve => spawnWaiters.push({ count, resolve })),
  };
}

describe('read-only Git transport', () => {
  it.each([
    ['status', '--porcelain=v2'], ['rev-parse', '--git-dir'], ['config', '--file', '.gitmodules', '--get-regexp', 'path'],
    ['remote', 'get-url', 'origin'], ['stash', 'show'], ['symbolic-ref', '--short', 'HEAD'], ['worktree', 'list', '--porcelain', '-z'],
  ])('offloads known read argv %j', (...args) => { expect(isReadOnlyGit(args)).toBe(true); });
  it.each([
    ['commit', '-m', 'message'], ['reset', '--hard'], ['fetch'], ['config', '--local', 'user.name', 'x'],
    ['worktree', 'add', 'new'], ['worktree', 'remove', 'old'], ['worktree', 'prune'],
    ['config', '--get', 'x', '--edit'], ['symbolic-ref', '-d', 'HEAD'], ['symbolic-ref', '--delete', 'HEAD'],
    ['symbolic-ref', 'HEAD', 'refs/heads/new'], ['remote', 'set-url', 'origin', 'x'],
    ['stash', 'pop'], ['stash', 'show', '--output=file'], ['diff', '--output=file'], ['custom-alias'],
  ])('keeps mutation/unknown argv out of the worker: %j', (...args) => { expect(isReadOnlyGit(args, 'read')).toBe(false); });

  it('never overrides an explicit mutation/network profile', () => {
    expect(isReadOnlyGit(['status'], 'mutation')).toBe(false);
    expect(isReadOnlyGit(['status'], 'network')).toBe(false);
  });

  it('keeps the caller event loop responsive while the worker blocks synchronously', async () => {
    const { reader, created } = fake({ busy: 150 });
    let ticks = 0;
    const clock = setInterval(() => ticks++, 5);
    try { expect((await reader.run(input())).code).toBe(0); } finally { clearInterval(clock); }
    expect(ticks).toBeGreaterThan(5);
    expect((await reader.run(input())).code).toBe(0);
    expect(created()).toBe(1);
  });

  it('bounds pending requests and does not start queued reads during shutdown', async () => {
    const { reader, spawned, warm, untilSpawned } = fake({ hold: true });
    await warm();
    const calls = Array.from({ length: 64 }, () => reader.run(input()));
    expect((await reader.run(input())).stderr).toContain('queue is full');
    await untilSpawned(4);
    // Navigation must still complete with four running diffs/statuses and a full queue.
    const location = await reader.run(input({ args: ['worktree', 'list', '--porcelain', '-z'] }));
    expect(location.stdout).toBe('inventory');
    await reader.dispose();
    await Promise.all(calls);
    expect(spawned()).toBe(4);
    expect(listTrackedProcessTrees()).toEqual([]);
  });

  it('returns a bounded timeout and still reaps the owned process before disposal completes', async () => {
    const { reader, pid, warm } = fake({ hold: true });
    await warm();
    const running = reader.run(input({ timeoutMs: 500 }));
    expect(await running).toMatchObject({ timedOut: true, errorCode: 'timeout' });
    await reader.dispose();
    const childPid = Atomics.load(pid, 0);
    expect(childPid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(alive(childPid)).toBe(false));
    expect(listTrackedProcessTrees()).toEqual([]);
  });

  it('recovers PID ownership after a crash before the spawned message arrives', async () => {
    const { reader, pid } = fake({ hold: true, crash: true });
    expect(await reader.run(input())).toMatchObject({ code: -1, errorCode: 'spawn_failed' });
    await reader.dispose();
    const childPid = Atomics.load(pid, 0);
    expect(childPid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(alive(childPid)).toBe(false));
    expect(listTrackedProcessTrees()).toEqual([]);
  });

  it('fails closed on worker creation failure instead of spawning on the caller', async () => {
    const reader = new GitReadExecutor(() => { throw new Error('synthetic worker unavailable'); });
    readers.push(reader);
    expect((await reader.run(input())).stderr).toContain('synthetic worker unavailable');
  });

  it('keeps the idle thread reusable instead of racing an automatic teardown', async () => {
    const { reader, warm, created } = fake();
    vi.useFakeTimers();
    try {
      await warm();
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await reader.run(input({ timeoutMs: 0 }))).code).toBe(0);
      expect(created()).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it('runs real Git with the same result shape and enforces the output cap', async () => {
    const reader = new GitReadExecutor(); readers.push(reader);
    const read = input({ args: ['check-ref-format', '--branch', 'worker-test'] });
    const result = await reader.run(read);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout.trim()).toBe('worker-test');
    expect(await reader.run({ ...read, maxOutputBytes: 4 })).toMatchObject({ code: -1, truncated: true, errorCode: 'output_too_large' });
  });
});
