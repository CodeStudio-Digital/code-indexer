import { expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { NativeLspProcess } from '../workers/native-lsp-process.js';
import type { NativeHostDuplexProcess, NativeDuplexResult } from '@mcp/agent-runtime-host';

function fixture() {
  const chunks: Array<{ bytes: Uint8Array; stderr: boolean } | null> = [];
  let wake: ((part: { bytes: Uint8Array; stderr: boolean } | null) => void) | undefined;
  let exit!: (value: NativeDuplexResult) => void;
  const result = new Promise<NativeDuplexResult>(resolve => { exit = resolve; });
  const child = { processId: 123, write: vi.fn(() => ({ wait: async () => {} })), cancel: vi.fn(),
    wait: () => result, read: async () => null,
    readOutput: () => chunks.length ? Promise.resolve(chunks.shift()!) : new Promise(resolve => { wake = resolve; }),
  } as NativeHostDuplexProcess;
  const send = (text: string | null, stderr = false) => {
    const value = text === null ? null : { bytes: Buffer.from(text), stderr };
    if (wake) { const resolve = wake; wake = undefined; resolve(value); } else chunks.push(value);
  };
  const spawn = vi.fn(() => child);
  const process = new NativeLspProcess('D:/fixture', { spawn, deadline: Date.now() + 60000, workerPath: fileURLToPath(import.meta.url) });
  const finish = (reaped = true) => { send(null); exit({ processId: 123, exitCode: 0, cancelled: true, timedOut: false, reaped,
    stderrHead: new Uint8Array(), stderrTail: new Uint8Array(), stderrTotalBytes: 0 }); };
  return { process, child, send, finish, spawn };
}

it('frames split UTF-8 output, separates stderr and launches only the contained child', async () => {
  const h = fixture(), messages: unknown[] = []; h.process.on('message', frame => messages.push(frame));
  h.send('diagnostic text\n', true); h.send('{"id":1,"encoded":'); h.send('"{}"}\n');
  await vi.waitFor(() => expect(messages).toEqual([{ id: 1, encoded: '{}' }]));
  expect(h.spawn).toHaveBeenCalledWith(expect.objectContaining({ streamStderr: true, environment: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
    arguments: expect.arrayContaining(['--max-old-space-size=768']) }));
  h.process.postMessage({ id: 2 }); expect(h.child.write).toHaveBeenCalledOnce();
  const closed = h.process.terminate(); h.finish(); await closed; expect(h.process.reaped).toBe(true);
});

it('waits for the native reap receipt before settling termination', async () => {
  const h = fixture(); let settled = false;
  const closed = h.process.terminate().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve)); expect(settled).toBe(false);
  h.finish(); await closed; expect(settled).toBe(true);
});

it('rejects cleanup without physical reap confirmation', async () => {
  const h = fixture(), closed = h.process.terminate(); const rejected = expect(closed).rejects.toThrow('reap confirmation');
  h.finish(false); await rejected; expect(h.process.reaped).toBe(false);
});

it('kills malformed/oversized protocols and rejects oversized inputs before writing', async () => {
  const h = fixture();
  expect(() => h.process.postMessage({ text: 'x'.repeat(300000) })).toThrow('256 KiB'); expect(h.child.write).not.toHaveBeenCalled();
  h.send('not json\n'); await vi.waitFor(() => expect(h.child.cancel).toHaveBeenCalled());
  h.finish(); await h.process.terminate();
});
