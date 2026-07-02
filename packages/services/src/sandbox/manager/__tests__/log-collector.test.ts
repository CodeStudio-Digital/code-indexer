/**
 * ServiceLogCollector tests (company B4) — pure core + exec-driven
 * collector against an in-memory fake driver. Covers the contract the
 * supervisor relies on: incremental byte offsets, truncation reset,
 * partial-line carry, 2KB line cap, container-channel timestamp dedup,
 * and cursor reset on container recreation.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_LINE_CHARS,
  parseContainerLogs,
  planIncrementalRead,
  seedOffset,
  splitWithCarry,
  truncateLine,
} from '../log-collector-core.js';
import { ServiceLogCollector, type LogTarget } from '../log-collector.js';

class FakeDriver {
  /** Content of /tmp/dev-server.log inside the "container". */
  file = '';
  containerLog = '';
  execCalls: string[] = [];

  async exec(_cid: string, command: string): Promise<{ stdout: string; exitCode: number | null }> {
    this.execCalls.push(command);
    if (command.startsWith('wc -c')) {
      return { stdout: `${Buffer.byteLength(this.file, 'utf8')}\n`, exitCode: 0 };
    }
    const m = /tail -c \+(\d+) \S+ .* head -c (\d+)/.exec(command);
    if (m) {
      const start = Number(m[1]) - 1;
      const take = Number(m[2]);
      const chunk = Buffer.from(this.file, 'utf8').subarray(start, start + take).toString('utf8');
      return { stdout: chunk, exitCode: 0 };
    }
    return { stdout: '', exitCode: 0 };
  }

  async getContainerLogs(): Promise<string> {
    return this.containerLog;
  }
}

const dev = (serviceId: string, containerId = 'c1'): LogTarget => ({
  serviceId,
  containerId,
  channel: 'devserver',
});
const cont = (serviceId: string, containerId = 'c1'): LogTarget => ({
  serviceId,
  containerId,
  channel: 'container',
});

describe('log-collector-core (pure)', () => {
  it('plans incremental reads and flags truncation resets', () => {
    expect(planIncrementalRead(10, 40, 100)).toEqual({ start: 10, take: 30, reset: false });
    expect(planIncrementalRead(10, 10, 100)).toEqual({ start: 10, take: 0, reset: false });
    // File shrank under the cursor → restart from 0.
    expect(planIncrementalRead(50, 20, 100)).toEqual({ start: 0, take: 20, reset: true });
    // Chunk cap respected.
    expect(planIncrementalRead(0, 1000, 64).take).toBe(64);
  });

  it('seeds first-sight cursors with a bounded tail', () => {
    expect(seedOffset(100, 8192)).toBe(0);
    expect(seedOffset(10_000, 8192)).toBe(10_000 - 8192);
  });

  it('carries partial lines across chunks and strips CR/blank lines', () => {
    const first = splitWithCarry('', 'one\r\ntwo\npar');
    expect(first.lines).toEqual(['one', 'two']);
    expect(first.carry).toBe('par');
    const second = splitWithCarry(first.carry, 'tial\n\n');
    expect(second.lines).toEqual(['partial']);
    expect(second.carry).toBe('');
  });

  it('caps lines at 2KB with an ellipsis marker', () => {
    const long = 'x'.repeat(5_000);
    const cut = truncateLine(long);
    expect(cut.length).toBe(MAX_LINE_CHARS);
    expect(cut.endsWith('…')).toBe(true);
    expect(truncateLine('short')).toBe('short');
  });

  it('dedups container logs by timestamp floor and skips the stderr marker', () => {
    const raw = [
      '2026-07-02T10:00:00.000Z hello',
      '--- stderr ---',
      '2026-07-02T10:00:01.000Z oops',
      'garbage without timestamp',
    ].join('\n');
    const first = parseContainerLogs(raw, 0, 999);
    // First pass (lastTs=0): timestamped lines + the un-timestamped one.
    expect(first.entries.map((e) => e.line)).toEqual(['hello', 'oops', 'garbage without timestamp']);
    expect(first.lastTs).toBe(Date.parse('2026-07-02T10:00:01.000Z'));
    // Second pass: only strictly-newer lines survive; garbage is dropped.
    const second = parseContainerLogs(`${raw}\n2026-07-02T10:00:02.000Z newer`, first.lastTs, 999);
    expect(second.entries.map((e) => e.line)).toEqual(['newer']);
    expect(second.entries[0].atMs).toBe(Date.parse('2026-07-02T10:00:02.000Z'));
  });
});

describe('ServiceLogCollector (devserver channel)', () => {
  it('tails incrementally by byte offset', async () => {
    const driver = new FakeDriver();
    const collector = new ServiceLogCollector();
    driver.file = 'one\ntwo\n';
    const first = await collector.collect(driver, [dev('api')], 111);
    expect(first.map((r) => r.line)).toEqual(['one', 'two']);
    expect(first[0]).toMatchObject({ serviceId: 'api', stream: 'devserver', atMs: 111 });

    driver.file += 'three\n';
    const second = await collector.collect(driver, [dev('api')], 222);
    expect(second.map((r) => r.line)).toEqual(['three']);
    expect(second[0].atMs).toBe(222);

    // Nothing new → nothing collected.
    expect(await collector.collect(driver, [dev('api')])).toEqual([]);
  });

  it('resets the cursor when the file shrank (dev-server restart)', async () => {
    const driver = new FakeDriver();
    const collector = new ServiceLogCollector();
    driver.file = 'aaaa\nbbbb\ncccc\n';
    await collector.collect(driver, [dev('api')]);
    driver.file = 'fresh\n'; // truncated + rewritten, smaller than the old offset
    const rows = await collector.collect(driver, [dev('api')]);
    expect(rows.map((r) => r.line)).toEqual(['fresh']);
  });

  it('holds partial lines in the carry until the newline lands', async () => {
    const driver = new FakeDriver();
    const collector = new ServiceLogCollector();
    driver.file = 'par';
    expect(await collector.collect(driver, [dev('api')])).toEqual([]);
    driver.file = 'partial\n';
    const rows = await collector.collect(driver, [dev('api')]);
    expect(rows.map((r) => r.line)).toEqual(['partial']);
  });

  it('truncates oversized lines to 2KB', async () => {
    const driver = new FakeDriver();
    const collector = new ServiceLogCollector();
    driver.file = `${'x'.repeat(5_000)}\n`;
    const rows = await collector.collect(driver, [dev('api')]);
    expect(rows).toHaveLength(1);
    expect(rows[0].line.length).toBe(MAX_LINE_CHARS);
  });

  it('starts a fresh cursor when the container was recreated', async () => {
    const driver = new FakeDriver();
    const collector = new ServiceLogCollector();
    driver.file = 'boot\n';
    await collector.collect(driver, [dev('api', 'c1')]);
    expect(await collector.collect(driver, [dev('api', 'c1')])).toEqual([]);
    // Same service id, new container → replay from the (seeded) start.
    const rows = await collector.collect(driver, [dev('api', 'c2')]);
    expect(rows.map((r) => r.line)).toEqual(['boot']);
  });

  it('never throws when one service breaks — siblings still collect', async () => {
    const driver = new FakeDriver();
    const collector = new ServiceLogCollector();
    driver.file = 'ok\n';
    const flaky = {
      exec: async (cid: string, cmd: string): Promise<{ stdout: string; exitCode: number | null }> => {
        if (cid === 'bad') throw new Error('exec exploded');
        return driver.exec(cid, cmd);
      },
      getContainerLogs: async (): Promise<string> => driver.getContainerLogs(),
    };
    const mixed = await collector.collect(flaky, [
      { serviceId: 'bad', containerId: 'bad', channel: 'devserver' },
      dev('api'),
    ]);
    expect(mixed.map((r) => r.line)).toEqual(['ok']);
  });
});

describe('ServiceLogCollector (container channel)', () => {
  it('collects docker-logs lines with parsed timestamps and dedups next tick', async () => {
    const driver = new FakeDriver();
    const collector = new ServiceLogCollector();
    driver.containerLog = '2026-07-02T10:00:00.000Z started\n2026-07-02T10:00:01.000Z listening';
    const first = await collector.collect(driver, [cont('db')], 999);
    expect(first.map((r) => r.line)).toEqual(['started', 'listening']);
    expect(first[0]).toMatchObject({ stream: 'container', atMs: Date.parse('2026-07-02T10:00:00.000Z') });

    driver.containerLog += '\n2026-07-02T10:00:05.000Z ready';
    const second = await collector.collect(driver, [cont('db')], 999);
    expect(second.map((r) => r.line)).toEqual(['ready']);
  });

  it('prune drops cursors of dead services', async () => {
    const driver = new FakeDriver();
    const collector = new ServiceLogCollector();
    driver.file = 'a\n';
    await collector.collect(driver, [dev('api')]);
    collector.prune(new Set<string>()); // api is gone
    // Cursor was dropped → same container re-collects from the seed.
    const rows = await collector.collect(driver, [dev('api')]);
    expect(rows.map((r) => r.line)).toEqual(['a']);
  });
});
