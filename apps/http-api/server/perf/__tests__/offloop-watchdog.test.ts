import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  enterOffloopActivity,
  enterOffloopHandler,
  heartbeatOffloopWatchdog,
  startOffloopWatchdog,
  stopOffloopWatchdog,
} from '../offloop-watchdog.js';

const roots: string[] = [];

function tempRun(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-offloop-watchdog-'));
  roots.push(dir);
  return dir;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFreezeRows(
  path: string,
  predicate: (row: { type?: string; event?: Record<string, unknown> }) => boolean,
  timeoutMs = 2_000,
): Promise<Array<{ type?: string; event?: Record<string, unknown> }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const rows = readFileSync(path, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          try { return [JSON.parse(line) as { type?: string; event?: Record<string, unknown> }]; }
          catch { return []; } // The worker may be between writeSync calls on this poll.
        });
      if (rows.some(predicate)) return rows;
    }
    await wait(25);
  }
  throw new Error(`timed out waiting for watchdog record in ${path}`);
}

afterEach(async () => {
  await stopOffloopWatchdog();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('off-loop watchdog', () => {
  it('persists the in-flight handler when main heartbeats stop', async () => {
    const runDir = tempRun();
    const path = join(runDir, 'offloop-watchdog.jsonl');
    startOffloopWatchdog(runDir, { thresholdMs: 100, pollMs: 25, repeatMs: 1_000 });
    enterOffloopHandler(7, '/api/projects/slow-handler', Date.now());

    const rows = await waitForFreezeRows(path, (row) => row.event?.channel === '/api/projects/slow-handler');
    await stopOffloopWatchdog();

    expect(rows).toContainEqual(expect.objectContaining({
      type: 'freeze',
      event: expect.objectContaining({
        source: 'offloop',
        channel: '/api/projects/slow-handler',
        detectedBy: 'worker-thread',
      }),
    }));
  });

  it('does not emit a freeze while heartbeats continue', async () => {
    const runDir = tempRun();
    const path = join(runDir, 'offloop-watchdog.jsonl');
    startOffloopWatchdog(runDir, { thresholdMs: 100, pollMs: 25 });
    for (let index = 0; index < 6; index++) {
      heartbeatOffloopWatchdog();
      await wait(30);
    }
    await stopOffloopWatchdog();

    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('');
  });

  it('persists the kind of a registered background activity', async () => {
    const runDir = tempRun();
    const path = join(runDir, 'offloop-watchdog.jsonl');
    startOffloopWatchdog(runDir, { thresholdMs: 100, pollMs: 25, repeatMs: 1_000 });
    enterOffloopActivity(9, 'coder-worker:spawn:42', Date.now(), 'background');

    const rows = await waitForFreezeRows(path, (row) => row.event?.channel === 'coder-worker:spawn:42');
    await stopOffloopWatchdog();

    expect(rows).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        channel: 'coder-worker:spawn:42',
        suspects: expect.arrayContaining([
          expect.objectContaining({ channel: 'coder-worker:spawn:42', kind: 'background' }),
        ]),
      }),
    }));
  });
});
