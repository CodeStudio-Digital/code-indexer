import { expect, it, vi } from 'vitest';
import type { NativeHostDuplexProcess, NativeDuplexResult } from '@mcp/agent-runtime-host';
import { NativeCodeExecutionPort } from '../workers/native-code-execution-port.js';
import { buildStashSandboxApi, createCodeExecStash } from '@mcp/code-agent/tools/code-exec-stash.js';

function fixture() {
  type Chunk = { bytes: Uint8Array; stderr: boolean } | null;
  const chunks: Chunk[] = []; let reader: ((chunk: Chunk) => void) | undefined;
  let exit!: (result: NativeDuplexResult) => void;
  const ended = new Promise<NativeDuplexResult>(resolve => { exit = resolve; });
  const owner: NativeHostDuplexProcess = { processId: 51, cancel: vi.fn(), read: async () => null,
    wait: () => ended, readOutput: () => chunks.length ? Promise.resolve(chunks.shift()!) : new Promise(resolve => { reader = resolve; }),
    write: vi.fn(() => ({ wait: async () => {} })),
  };
  const push = (chunk: Chunk) => { if (reader) { const read = reader; reader = undefined; read(chunk); } else chunks.push(chunk); };
  const send = (frame: unknown) => push({ bytes: Buffer.from(JSON.stringify(frame) + '\n'), stderr: false });
  const finish = (reaped = true) => { push(null); exit({ processId: 51, exitCode: 0, reaped, cancelled: false, timedOut: false,
    stderrHead: new Uint8Array(), stderrTail: new Uint8Array(), stderrTotalBytes: 0 }); };
  const unknown = vi.fn(), controller = new AbortController(), tool = vi.fn(async (_args: unknown) => 'ação'), stash = createCodeExecStash();
  const log = vi.fn(), changes = vi.fn(async () => ['edited']), omitted = vi.fn();
  const port = new NativeCodeExecutionPort({ spawn: () => owner, root: '.', deadline: Date.now() + 60000, signal: controller.signal,
    assertOwner() {}, outcomeUnknown: unknown });
  const session = port.start({ code: 'return 1', timeoutMs: 1000, wallTimeoutMs: 2000, maxOutputBytes: 50000, priorityErrorBytes: 1000,
    toolNames: ['read_file'], allToolNames: ['read_file', 'ask_user'], onOmittedLogs: omitted,
    sandbox: { tools: { read_file: tool }, list_tools: () => [{ name: 'read_file' }], tool_schema: (name: string) => ({ name }),
      console: { log, warn: log, error: log }, stash: buildStashSandboxApi(stash), change: { files: changes } } });
  return { owner, send, push, finish, unknown, controller, tool, stash, log, changes, omitted, session };
}

it('keeps independent calls concurrent and applies ordered stash/log frames before the result', async () => {
  const f = fixture(); let release!: () => void;
  f.tool.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve('first'); }));
  f.send({ type: 'call', id: 1, target: 'tool', name: 'read_file', args: [{ path: 'a' }] });
  f.send({ type: 'call', id: 2, target: 'tool', name: 'read_file', args: [{ path: 'b' }] });
  await vi.waitFor(() => expect(f.tool).toHaveBeenCalledTimes(2));
  expect(f.owner.write).toHaveBeenCalledTimes(2); // bootstrap plus the fast second reply
  release();
  f.send({ type: 'call', id: 3, target: 'change', name: 'files', args: [] });
  f.send({ type: 'stash', op: 'set', key: 'a', value: 'ação' });
  f.send({ type: 'logs', logs: [{ level: 'error', line: 'retained' }] });
  f.send({ type: 'omitted', lines: 4, bytes: 90, errorTail: ['tail'] });
  f.send({ type: 'result', result: 'done' });
  expect(await f.session.result).toBe('done'); expect(f.stash.get('a')).toBe('ação');
  expect(f.changes).toHaveBeenCalledOnce(); expect(f.log).toHaveBeenCalledWith('retained');
  expect(f.omitted).toHaveBeenCalledWith(4, 90, ['tail']);
  f.finish(); await f.session.close(); expect(f.unknown).not.toHaveBeenCalled();
});

it.each([
  { type: 'call', id: 1, target: 'tool', name: 'ask_user', args: [{}] },
  { type: 'call', id: 1, target: 'change', name: 'constructor', args: [] },
  { type: 'call', id: 2, target: 'tool', name: 'read_file', args: [{}] },
])('refuses unadmitted or unmatched evaluator calls: $name', async frame => {
  const f = fixture(); f.send(frame); await expect(f.session.result).rejects.toThrow();
  expect(f.tool).not.toHaveBeenCalled(); expect(f.owner.cancel).toHaveBeenCalled();
  f.finish(); await f.session.close();
});

it('requires the physical reap receipt even after cancellation is acknowledged', async () => {
  const f = fixture(); f.controller.abort(new Error('cancel fixture'));
  await expect(f.session.result).rejects.toThrow('cancel fixture');
  let closed = false; const done = f.session.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); expect(closed).toBe(false);
  f.finish(); await done; expect(f.unknown).not.toHaveBeenCalled();
});

it('never accepts missing reap as successful cleanup', async () => {
  const f = fixture(); f.send({ type: 'result', result: 'done' }); await f.session.result;
  f.finish(false); await expect(f.session.close()).rejects.toThrow('cleanup is unconfirmed'); expect(f.unknown).toHaveBeenCalledOnce();
});

it('rejects truncated replies and preserves the tool error classification across the pipe', async () => {
  const f = fixture();
  f.send({ type: 'result', error: { name: 'NestedToolExecutionError', message: 'failed', tool: 'read_file', kind: 'permission', code: 'DENIED', retryable: false } });
  await expect(f.session.result).rejects.toMatchObject({ tool: 'read_file', kind: 'permission', code: 'DENIED', retryable: false });
  f.finish(); await f.session.close();
  const g = fixture(); g.push({ bytes: Buffer.from('{"type":'), stderr: false }); g.finish();
  await expect(g.session.result).rejects.toThrow('incomplete response'); await g.session.close();
});

it('does not dispatch a late capability after the final result', async () => {
  const f = fixture(); f.send({ type: 'result', result: 'done' });
  f.send({ type: 'call', id: 1, target: 'tool', name: 'read_file', args: [{}] });
  await f.session.result; f.finish(); await f.session.close(); expect(f.tool).not.toHaveBeenCalled();
});
