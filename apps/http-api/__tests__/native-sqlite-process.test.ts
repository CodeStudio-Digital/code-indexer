import { expect, it, vi } from 'vitest';
import type { NativeHostDuplexProcess, NativeDuplexResult } from '@mcp/agent-runtime-host';
import { NativeSqliteProcess } from '../workers/native-sqlite-process.js';

function fixture() {
  type Chunk = { bytes: Buffer; stderr: boolean } | null;
  const chunks: Chunk[] = []; let reader: ((part: Chunk) => void) | undefined;
  let end!: (result: NativeDuplexResult) => void;
  const exited = new Promise<NativeDuplexResult>(resolve => { end = resolve; });
  const push = (bytes: Buffer | string | null) => {
    const part = bytes === null ? null : { bytes: Buffer.from(bytes), stderr: false };
    if (reader) { const receive = reader; reader = undefined; receive(part); } else chunks.push(part);
  };
  const finish = (reaped = true) => { push(null); end({ processId: 42, exitCode: 0, reaped, cancelled: true, timedOut: false,
    stderrHead: Buffer.alloc(0), stderrTail: Buffer.alloc(0), stderrTotalBytes: 0 }); };
  const owner = { processId: 42, read: vi.fn(), cancel: vi.fn(), wait: () => exited,
    readOutput: () => chunks.length ? Promise.resolve(chunks.shift()!) : new Promise<Chunk>(resolve => { reader = resolve; }),
    write: vi.fn((buffer: Uint8Array) => {
      const request = JSON.parse(Buffer.from(buffer).toString());
      if (request.method === 'init') push(JSON.stringify({ id: request.id, result: null }) + '\n');
      return { wait: async () => {} };
    }),
  } as NativeHostDuplexProcess;
  const controller = new AbortController(), unknown = vi.fn();
  const process = new NativeSqliteProcess({ spawn: () => owner, root: '.', deadline: Date.now() + 60000,
    signal: controller.signal, assertOwner: () => {}, outcomeUnknown: unknown });
  return { process, owner, controller, unknown, push, finish };
}
it('preserves fragmented UTF-8 replies and leaves ordinary SQL errors recoverable', async () => {
  const f = fixture(), driver = await f.process.initialize({ engine: 'sqlite', filePath: ':memory:' });
  try {
    const pending = driver.runQuery('SELECT value');
    const data = Buffer.from(JSON.stringify({ id: 2, result: { rows: [{ value: 'ação €' }], fields: [], rowCount: 1 } }) + '\n');
    for (let index = 0; index < data.length; index++) f.push(data.subarray(index, index + 1));
    expect((await pending).rows).toEqual([{ value: 'ação €' }]);
    const failed = driver.runQuery('invalid'); f.push('{"id":3,"error":"SQL syntax error"}\n');
    await expect(failed).rejects.toThrow('syntax error'); expect(f.owner.cancel).not.toHaveBeenCalled();
  } finally { f.finish(); await f.process.close(); }
});
it('does not drop a cancelled query lifetime until the native process is physically reaped', async () => {
  const f = fixture(), driver = await f.process.initialize({ engine: 'sqlite', filePath: ':memory:' });
  let settled = false;
  const pending = driver.runQuery('long scan').finally(() => { settled = true; });
  const rejected = expect(pending).rejects.toThrow('exited');
  f.controller.abort(); await Promise.resolve();
  expect(f.owner.cancel).toHaveBeenCalled(); expect(settled).toBe(false);
  f.finish(); await rejected; await f.process.close(); expect(f.unknown).not.toHaveBeenCalled();
});
it('retains failed physical cleanup as an uncertain effect', async () => {
  const f = fixture(); await f.process.initialize({ engine: 'sqlite', filePath: ':memory:' });
  f.finish(false); await expect(f.process.close()).rejects.toThrow('cleanup is unconfirmed');
  expect(f.unknown).toHaveBeenCalledTimes(1);
});
it('refuses an uncorrelated response and stops the worker', async () => {
  const f = fixture(), driver = await f.process.initialize({ engine: 'sqlite', filePath: ':memory:' });
  const pending = driver.runQuery('SELECT 1'); const rejected = expect(pending).rejects.toThrow('matching request');
  f.push('{"id":999,"result":{}}\n');
  await vi.waitFor(() => expect(f.owner.cancel).toHaveBeenCalled());
  f.finish(); await rejected; await f.process.close();
});
