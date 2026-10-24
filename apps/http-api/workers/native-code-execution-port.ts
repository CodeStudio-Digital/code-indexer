import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import type { NativeDuplexOptions, NativeHostDuplexProcess } from '@mcp/agent-runtime-host';
import type { CodeExecutionInput, CodeExecutionPort, CodeExecutionSession } from '@mcp/code-agent/ports/code-execution-port.js';
import { cleanProcessEnv } from '@mcp/code-agent/ports/shell-port.js';
import { CODE_EXEC_FRAME_BYTES, CODE_EXEC_MAX_REQUESTS, encodeCodeExecError, decodeCodeExecError,
  type CodeExecBootstrap } from '@mcp/code-agent/tools/code-exec-protocol.js';

interface Options {
  spawn(input: NativeDuplexOptions): NativeHostDuplexProcess;
  root: string;
  deadline: number;
  signal: AbortSignal;
  assertOwner(): void;
  outcomeUnknown(): void;
  executable?: string;
  workerPath?: string;
}
type Callable = (...args: unknown[]) => unknown;
function callable(binding: unknown, name: string): Callable {
  if (!binding || !Object.hasOwn(binding, name) || typeof (binding as Record<string, unknown>)[name] !== 'function') {
    throw new Error(`Evaluator requested an unavailable binding: ${name}`);
  }
  return (binding as Record<string, Callable>)[name];
}

/** Disposable VM process owned by the same bounded Rust Job resources as the
 * attempt. Capability policy/receipts remain in the Host, never in the VM. */
export class NativeCodeExecutionPort implements CodeExecutionPort {
  constructor(private readonly options: Options) {}
  start(input: CodeExecutionInput): CodeExecutionSession {
    const options = this.options;
    const signal = AbortSignal.any([options.signal, ...(input.signal ? [input.signal] : [])]);
    signal.throwIfAborted(); options.assertOwner();
    const remaining = options.deadline - Date.now();
    if (remaining <= 0) throw new Error('Code evaluator authority expired');
    const stash = input.sandbox.stash;
    const initial: CodeExecBootstrap = {
      code: input.code, timeoutMs: input.timeoutMs, maxOutputBytes: input.maxOutputBytes, priorityErrorBytes: input.priorityErrorBytes,
      tools: input.toolNames, schemas: input.allToolNames.map(name => callable(input.sandbox, 'tool_schema')(name) as CodeExecBootstrap['schemas'][number]),
      listing: callable(input.sandbox, 'list_tools')(), changes: Object.keys(input.sandbox.change ?? {}),
      stash: (callable(stash, 'keys')() as string[]).map(key => [key, callable(stash, 'get')(key)]),
    };
    const encode = (frame: unknown): Buffer => {
      const bytes = Buffer.from(JSON.stringify(frame) + '\n');
      if (bytes.byteLength > CODE_EXEC_FRAME_BYTES) throw new Error('Code evaluator frame exceeds 16 MiB');
      return bytes;
    };
    // Serialize before launch so an oversized bootstrap cannot leak a child.
    const bootstrap = encode({ type: 'start', input: initial });
    const environment = Object.fromEntries(Object.entries(cleanProcessEnv()).filter((e): e is [string, string] => typeof e[1] === 'string'));
    environment.ELECTRON_RUN_AS_NODE = '1';
    let owner: NativeHostDuplexProcess;
    try {
      owner = options.spawn({ executable: options.executable ?? process.execPath,
        arguments: ['--max-old-space-size=256', options.workerPath ?? fileURLToPath(new URL('./native-code-exec-worker.js', import.meta.url))],
        cwd: options.root, environment, timeoutMs: Math.min(remaining, input.wallTimeoutMs), streamStderr: true });
    } catch (error) { options.outcomeUnknown(); throw error; }
    let closing = false, settled = false, failure: unknown, reapFailure = false, lastRequest = 0, receivedBytes = 0;
    let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
    const result = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
    void result.catch(() => undefined);
    const fail = (error: unknown) => { failure ??= error; if (!settled) { settled = true; reject(error); } owner.cancel(); };
    const cancel = () => fail(signal.reason ?? new Error('Code evaluator cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    const writes = new Set<Promise<unknown>>();
    const write = (frame: unknown): void => {
      if (closing || settled) return;
      let bytes: Buffer;
      try { bytes = encode(frame); }
      catch (error) { bytes = encode({ type: 'reply', id: (frame as { id: number }).id, error: encodeCodeExecError(error) }); }
      const operation = owner.write(bytes).wait(); writes.add(operation);
      void operation.catch(error => { if (!closing && !settled) fail(error); }).finally(() => writes.delete(operation));
    };
    const drain = async () => {
      if (!owner.readOutput) throw new Error('Code evaluator requires tagged native output');
      const decoder = new StringDecoder('utf8'); let fragments: string[] = [], size = 0, sinceYield = performance.now();
      for (;;) {
        const part = await owner.readOutput(); if (!part) break;
        receivedBytes += part.bytes.byteLength;
        if (receivedBytes > 64 * 1024 * 1024) throw new Error('Evaluator output transport budget exceeded');
        if (part.stderr) continue;
        const segments = decoder.write(Buffer.from(part.bytes)).split('\n');
        for (let index = 0; index < segments.length; index++) {
          const segment = segments[index]; size += Buffer.byteLength(segment);
          if (size > CODE_EXEC_FRAME_BYTES) throw new Error('Evaluator response exceeds 16 MiB');
          if (segment) fragments.push(segment);
          if (index === segments.length - 1) break;
          const frame = JSON.parse(fragments.join('')); fragments = []; size = 0;
          if (closing || settled) continue;
          options.assertOwner(); signal.throwIfAborted();
          if (frame.type === 'call') {
            if (frame.id !== ++lastRequest || lastRequest > CODE_EXEC_MAX_REQUESTS || !Array.isArray(frame.args)
              || !['tool', 'change'].includes(frame.target) || typeof frame.name !== 'string') throw new Error('Invalid evaluator capability request');
            if (frame.target === 'tool' && (!input.toolNames.includes(frame.name) || frame.args.length !== 1)) throw new Error('Unadmitted evaluator capability');
            const fn = callable(input.sandbox[frame.target === 'tool' ? 'tools' : 'change'], frame.name);
            // Do not block pipe draining on a tool: independent reads must overlap.
            let invocation: Promise<unknown>;
            try { invocation = Promise.resolve(fn(...frame.args)); }
            catch (error) { invocation = Promise.reject(error); }
            void invocation.then(value => write({ type: 'reply', id: frame.id, result: value }), error =>
              write({ type: 'reply', id: frame.id, error: encodeCodeExecError(error) })).catch(fail);
          } else if (frame.type === 'stash') {
            if (typeof frame.key !== 'string' || !['set', 'delete'].includes(frame.op)) throw new Error('Invalid evaluator stash operation');
            callable(stash, frame.op)(frame.key, frame.value);
          } else if (frame.type === 'logs') {
            if (!Array.isArray(frame.logs) || frame.logs.length > 128) throw new Error('Invalid evaluator log batch');
            for (const entry of frame.logs) {
              if (!['log', 'warn', 'error'].includes(entry.level) || typeof entry.line !== 'string') throw new Error('Invalid evaluator log');
              callable(input.sandbox.console, entry.level)(entry.line);
            }
          } else if (frame.type === 'omitted') {
            if (![frame.lines, frame.bytes].every(n => Number.isSafeInteger(n) && n >= 0)
              || !Array.isArray(frame.errorTail) || frame.errorTail.some((s: unknown) => typeof s !== 'string')
              || Buffer.byteLength(JSON.stringify(frame.errorTail)) > 128 * 1024) throw new Error('Invalid evaluator log accounting');
            input.onOmittedLogs(frame.lines, frame.bytes, frame.errorTail);
          } else if (frame.type === 'result') {
            settled = true;
            if (frame.error) reject(decodeCodeExecError(frame.error)); else resolve(frame.result);
          } else throw new Error('Unknown evaluator response');
        }
        if (performance.now() - sinceYield >= 4) { await yieldEventLoop(); sinceYield = performance.now(); }
      }
      if (!closing && (size || decoder.end())) throw new Error('Evaluator exited with an incomplete response');
    };
    const done = (async () => {
      const [read, exit] = await Promise.allSettled([drain().catch(error => { fail(error); throw error; }), owner.wait()]);
      if (exit.status === 'rejected' || !exit.value.reaped || exit.value.processId !== owner.processId) {
        reapFailure = true; options.outcomeUnknown();
      }
      signal.removeEventListener('abort', cancel);
      if (read.status === 'rejected') failure ??= read.reason;
      if (!settled) { settled = true; reject(failure ?? new Error('Code evaluator exited before confirming its result')); }
    })();
    void owner.write(bootstrap).wait().catch(fail);
    if (signal.aborted) cancel();
    return { result, async close() {
      closing = true; owner.cancel(); await done; await Promise.allSettled([...writes]);
      if (reapFailure) throw new Error('Code evaluator physical cleanup is unconfirmed');
    } };
  }
}
