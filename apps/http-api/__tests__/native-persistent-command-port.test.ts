import { expect, it, vi } from 'vitest';
import type { NativeDuplexOptions, NativeDuplexResult, NativeHostDuplexProcess } from '@mcp/agent-runtime-host';
import { NativePersistentCommandPort } from '../workers/native-persistent-command-port.js';

function fixture(supportsPty = false) {
  let resolveExit!: (value: NativeDuplexResult) => void;
  const exited = new Promise<NativeDuplexResult>(resolve => { resolveExit = resolve; });
  type Chunk = { bytes: Buffer; stderr: boolean } | null;
  const chunks: Chunk[] = [];
  let reader: ((chunk: Chunk) => void) | undefined;
  const push = (bytes: string | Buffer | null, stderr = false) => {
    const value = bytes === null ? null : { bytes: Buffer.from(bytes), stderr };
    if (reader) { const resolve = reader; reader = undefined; resolve(value); } else chunks.push(value);
  };
  const finish = (reaped = true) => { push(null); resolveExit({ processId: 1234, exitCode: 0, cancelled: false, timedOut: false,
    reaped, stderrHead: Buffer.alloc(0), stderrTail: Buffer.alloc(0), stderrTotalBytes: 0 }); };
  const owner: NativeHostDuplexProcess = { processId: 1234, read: vi.fn(),
    readOutput: vi.fn(() => chunks.length ? Promise.resolve(chunks.shift()!) : new Promise<Chunk>(resolve => { reader = resolve; })),
    write: vi.fn(() => ({ wait: vi.fn(async () => undefined) })), cancel: vi.fn(), wait: vi.fn(() => exited) };
  const spawn = vi.fn((_options: NativeDuplexOptions) => owner);
  const unknown = vi.fn();
  const controller = new AbortController();
  const port = new NativePersistentCommandPort(spawn, Date.now() + 60_000, controller.signal, unknown, supportsPty);
  const input = { command: 'node -i', cwd: process.cwd(), tty: false, maxOutputBytes: 2000, yieldMs: 0, assertFence: vi.fn() };
  const id = (content: string) => /session_id=([^ ]+)/.exec(content)![1];
  return { port, owner, controller, unknown, input, push, finish, spawn, id };
}

it('keeps the process across calls and returns only newly drained output, including stderr', async () => {
  const f = fixture(); f.push('prompt> ', true);
  const first = await f.port.start(f.input); const sessionId = f.id(first.content);
  expect(first.content).toContain('running\n\nprompt> ');
  expect(f.input.assertFence).toHaveBeenCalledOnce();
  expect(f.spawn).toHaveBeenCalledWith(expect.objectContaining({ streamStderr: true }));
  expect(f.port.list().content).toContain(sessionId);
  f.push('reply\n');
  const next = await f.port.write({ sessionId, chars: 'answer\n', yieldMs: 0, assertFence: f.input.assertFence });
  expect(next.content).toContain('reply'); expect(next.content).not.toContain('prompt>');
  expect(f.owner.write).toHaveBeenCalledOnce();
  f.finish();
  const last = await f.port.write({ sessionId, chars: '', yieldMs: 10, assertFence: f.input.assertFence });
  expect(last.content).toContain('status=exited exit=0');
  expect(f.port.list().content).toContain('no active'); await f.port.close();
});

it('preserves split UTF-8 independently for stdout and stderr and bounds flood capture', async () => {
  const f = fixture(); const euro = Buffer.from('€');
  f.push(euro.subarray(0, 1)); f.push('stderr\n', true); f.push(euro.subarray(1));
  const first = await f.port.start(f.input); expect(first.content).toContain('stderr\n€');
  const sessionId = f.id(first.content);
  f.push('HEAD' + 'x'.repeat(80_000) + 'TAIL');
  const next = await f.port.write({ sessionId, chars: '', yieldMs: 5, assertFence() {} });
  expect(next.content).toContain('HEAD'); expect(next.content).toContain('TAIL');
  expect(next.content.length).toBeLessThan(2100);
  expect(next.sourceTruncations?.[0]).toMatchObject({ inputSize: 80008, unit: 'bytes', recoverable: false });
  f.finish(); await f.port.close();
});

it('does not resolve close until the tree is physically reaped', async () => {
  const f = fixture(); await f.port.start(f.input);
  let closed = false; const done = f.port.close().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false); expect(f.owner.cancel).toHaveBeenCalledOnce();
  f.finish(); await done; expect(closed).toBe(true);
  await expect(f.port.start(f.input)).rejects.toThrow('closed');
});

it('retains uncertainty on an unconfirmed stdin receipt and never retries bytes', async () => {
  const f = fixture(); const first = await f.port.start(f.input);
  vi.mocked(f.owner.write).mockReturnValue({ wait: async () => { throw new Error('ACK lost'); } });
  const result = await f.port.write({ sessionId: f.id(first.content), chars: 'mutate\n', yieldMs: 0, assertFence() {} });
  expect(result.effectOutcome).toBe('unknown'); expect(f.unknown).toHaveBeenCalledOnce();
  expect(f.owner.write).toHaveBeenCalledOnce(); expect(f.owner.cancel).toHaveBeenCalledOnce();
  expect((await f.port.write({ sessionId: f.id(first.content), chars: 'mutate\n', yieldMs: 0, assertFence() {} })).effectOutcome).toBe('unknown');
  expect(f.owner.write).toHaveBeenCalledOnce();
  f.finish(); await f.port.close();
});

it('refuses missing physical cleanup even after the JS wait resolves', async () => {
  const f = fixture(); await f.port.start(f.input); f.finish(false);
  await expect(f.port.close()).rejects.toThrow('unproven cleanup'); expect(f.unknown).toHaveBeenCalledOnce();
});

it('rejects unavailable PTY and revoked fences before spawning', async () => {
  const f = fixture(); expect((await f.port.start({ ...f.input, tty: true })).isError).toBe(true);
  await expect(f.port.start({ ...f.input, assertFence() { throw new Error('revoked'); } })).rejects.toThrow('revoked');
  expect(f.spawn).not.toHaveBeenCalled(); await f.port.close();
});

it('validates terminal geometry before admission and forwards the requested console size', async () => {
  const f = fixture(true);
  for (const geometry of [{ columns: 0 }, { columns: 501 }, { rows: 301 }, { rows: 1.5 }]) {
    expect((await f.port.start({ ...f.input, tty: true, ...geometry })).isError).toBe(true);
  }
  expect(f.spawn).not.toHaveBeenCalled(); expect(f.input.assertFence).not.toHaveBeenCalled();
  await f.port.start({ ...f.input, tty: true, columns: 90, rows: 25 });
  expect(f.spawn).toHaveBeenCalledWith(expect.objectContaining({ tty: true, columns: 90, rows: 25 }));
  expect(f.port.list().content).toContain(' | pty | ');
  f.finish(); await f.port.close();
});

it('rejects sessions from another attempt and fences writes immediately before queue admission', async () => {
  const f = fixture(); const first = await f.port.start(f.input);
  const other = fixture();
  expect((await other.port.write({ sessionId: f.id(first.content), chars: 'x', yieldMs: 0, assertFence() {} })).isError).toBe(true);
  await expect(f.port.write({ sessionId: f.id(first.content), chars: 'x', yieldMs: 0, assertFence() { throw new Error('revoked'); } }))
    .rejects.toThrow('revoked');
  expect(f.owner.write).not.toHaveBeenCalled(); f.finish(); await f.port.close(); await other.port.close();
});

it('aborts the Job during an outstanding stdin receipt without blocking the JS loop', async () => {
  const f = fixture(); const first = await f.port.start(f.input);
  let reject!: (reason: Error) => void;
  vi.mocked(f.owner.write).mockReturnValue({ wait: () => new Promise((_resolve, rejectWrite) => { reject = rejectWrite; }) });
  const signal = new AbortController();
  const writing = f.port.write({ sessionId: f.id(first.content), chars: 'x', yieldMs: 0, assertFence() {}, signal: signal.signal });
  signal.abort(); expect(f.owner.cancel).toHaveBeenCalled(); reject(new Error('cancelled write'));
  expect((await writing).effectOutcome).toBe('unknown'); f.finish(); await f.port.close();
});
