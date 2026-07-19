import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
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

afterEach(async () => {
  await stopOffloopWatchdog();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('off-loop watchdog', () => {
  it('persists the in-flight handler when main heartbeats stop', async () => {
    const runDir = tempRun();
    startOffloopWatchdog(runDir, { thresholdMs: 100, pollMs: 25, repeatMs: 1_000 });
    enterOffloopHandler(7, '/api/projects/slow-handler', Date.now());

    await wait(220);
    await stopOffloopWatchdog();

    const rows = readFileSync(join(runDir, 'offloop-watchdog.jsonl'), 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string; event: { source: string; channel?: string; detectedBy?: string } });
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
});
