import { runInNewContext } from 'node:vm';
import { createInterface } from 'node:readline';
import { wrapToolsBinding } from '@mcp/code-agent/tools/code-exec-hints.js';
import { suggestToolName } from '@mcp/code-agent/core/tool-name-suggest.js';
import { createCodeExecStash } from '@mcp/code-agent/tools/code-exec-stash.js';
import { CODE_EXEC_FRAME_BYTES, CODE_EXEC_MAX_REQUESTS, encodeCodeExecError, decodeCodeExecError,
  type CodeExecBootstrap, type CodeExecWireError } from '@mcp/code-agent/tools/code-exec-protocol.js';

const observe = <T>(promise: Promise<T>): Promise<T> => { void promise.catch(() => undefined); return promise; };
let outputBytes = 0;
function send(frame: unknown): void {
  const encoded = JSON.stringify(frame) + '\n';
  const bytes = Buffer.byteLength(encoded);
  if (bytes > CODE_EXEC_FRAME_BYTES || (outputBytes += bytes) > 64 * 1024 * 1024) {
    throw new Error('code_exec evaluator output exceeds its transport budget');
  }
  process.stdout.write(encoded);
}
const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
let nextRequest = 0, started = false, finished = false;
let flushLogs = () => {};
function call(target: 'tool' | 'change', name: string, args: unknown[]): Promise<unknown> {
  return observe(new Promise((resolve, reject) => {
    if (finished || ++nextRequest > CODE_EXEC_MAX_REQUESTS) throw new Error('code_exec evaluator call limit exceeded');
    flushLogs();
    const id = nextRequest;
    pending.set(id, { resolve, reject });
    try { send({ type: 'call', id, target, name, args }); }
    catch (error) { pending.delete(id); reject(error); }
  }));
}

async function run(input: CodeExecBootstrap): Promise<void> {
  const stash = createCodeExecStash();
  for (const [key, value] of input.stash) stash.set(key, value);
  let stashBytes = 0;
  const stashMutation = (frame: unknown) => {
    if ((stashBytes += Buffer.byteLength(JSON.stringify(frame))) > 16 * 1024 * 1024) throw new Error('stash mutation transport budget exceeded');
    send(frame);
  };
  let logBytes = 0, bufferedBytes = 0, omittedLines = 0, omittedBytes = 0, tailBytes = 0;
  let logs: Array<{ level: string; line: string }> = [];
  const tail: string[] = [];
  flushLogs = () => { if (logs.length) { send({ type: 'logs', logs }); logs = []; bufferedBytes = 0; } };
  const log = (level: string, parts: unknown[]) => {
    const line = parts.map(p => { if (typeof p === 'string') return p; try { return JSON.stringify(p); } catch { return String(p); } }).join(' ');
    const bytes = Buffer.byteLength(line + '\n');
    if (logBytes + bytes <= input.maxOutputBytes) {
      logBytes += bytes; bufferedBytes += bytes; logs.push({ level, line });
      if (bufferedBytes >= 16_384 || logs.length >= 128) flushLogs();
    } else {
      omittedLines++; omittedBytes += bytes;
      if (level === 'error') {
        const raw = Buffer.from(line); let start = Math.max(0, raw.length - Math.max(1, input.priorityErrorBytes - 64));
        while (start < raw.length && (raw[start] & 0xc0) === 0x80) start++;
        const entry = start ? '[tail preserved] ' + raw.subarray(start).toString('utf8') : line;
        tail.push(entry); tailBytes += Buffer.byteLength(entry + '\n') + 16;
        while (tail.length > 1 && tailBytes > input.priorityErrorBytes) tailBytes -= Buffer.byteLength(tail.shift()! + '\n') + 16;
      }
    }
  };
  const tools = Object.fromEntries(input.tools.map(name => [name, (args: unknown) => call('tool', name, [args])]));
  const reserved = new Set(['JSON','Math','Number','String','Boolean','Array','Object','Promise','Set','Map','Date','RegExp','Error',
    'console','log','tools','list_tools','tool_schema','attempt','stash','change']);
  const schemas = new Map(input.schemas.map(schema => [schema.name, schema]));
  const aliases = Object.fromEntries(input.schemas.filter(s => !reserved.has(s.name) && /^[A-Za-z_$][\w$]*$/.test(s.name)).map(s =>
    [s.name, tools[s.name] ?? (() => observe(Promise.reject(new ReferenceError(`${s.name} is not defined`))))]));
  const sandbox = {
    ...aliases, tools: wrapToolsBinding(tools, input.tools),
    list_tools: () => structuredClone(input.listing),
    tool_schema: (name: unknown) => {
      const key = String(name ?? ''), schema = schemas.get(key); if (schema) return structuredClone(schema);
      const close = suggestToolName(key, [...schemas.keys()]);
      throw new Error(`tool_schema: unknown tool "${key}"${close ? ` — did you mean "${close}"?` : ''}. Call list_tools() or find_tools({query}).`);
    },
    attempt: (operation: unknown) => observe((async () => {
      try { return { ok: true, value: await operation }; }
      catch (error) {
        const e = error as CodeExecWireError;
        if (e?.name !== 'NestedToolExecutionError' || e.code === 'TOOL_CALL_REFUSED'
          || ['refusal', 'permission', 'timeout', 'cancelled'].includes(String(e.kind))) throw error;
        return { ok: false, error: { tool: e.tool, code: e.code, kind: e.kind, message: e.detail,
          retryable: e.retryable, ...(e.suggestedAction ? { suggestedAction: e.suggestedAction } : {}) } };
      }
    })()),
    stash: {
      get: (key: unknown) => stash.get(String(key)), keys: () => stash.keys(), usedBytes: () => stash.usedBytes(),
      set: (key: unknown, value: unknown) => { const k = String(key); stash.set(k, value); stashMutation({ type: 'stash', op: 'set', key: k, value: stash.get(k) }); },
      delete: (key: unknown) => { const k = String(key), existed = stash.delete(k); stashMutation({ type: 'stash', op: 'delete', key: k }); return existed; },
    },
    ...(input.changes.length ? { change: Object.fromEntries(input.changes.map(name => [name, (...args: unknown[]) => call('change', name, args)])) } : {}),
    log: (...parts: unknown[]) => log('log', parts),
    console: { log: (...parts: unknown[]) => log('log', parts), warn: (...parts: unknown[]) => log('warn', parts), error: (...parts: unknown[]) => log('error', parts) },
    JSON, Math, Number, String, Boolean, Array, Object, Promise, Set, Map, Date, RegExp, Error,
  };
  let result: unknown, error: CodeExecWireError | undefined;
  try {
    const value = await runInNewContext(`(async (tools) => {\n${input.code}\n})(tools)`, sandbox,
      { timeout: input.timeoutMs, filename: 'code_exec.js' });
    if (value !== undefined) {
      if (typeof value === 'string') result = value;
      else { try { result = JSON.stringify(value, null, 2); } catch { result = String(value); } }
    }
  } catch (cause) { error = encodeCodeExecError(cause); }
  finished = true;
  flushLogs();
  send({ type: 'omitted', lines: omittedLines, bytes: omittedBytes, errorTail: tail });
  try { send({ type: 'result', result, error }); }
  catch (cause) { send({ type: 'result', error: encodeCodeExecError(cause) }); }
  // Detached promises cannot keep evaluating after the result boundary. The
  // Host drains their physical effects separately and verifies this Job's reap.
  process.stdout.end(() => process.exit(0));
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  try {
    if (Buffer.byteLength(line) > CODE_EXEC_FRAME_BYTES) throw new Error('Evaluator input frame exceeds limit');
    const frame = JSON.parse(line);
    if (!started) {
      if (frame.type !== 'start') throw new Error('Expected evaluator bootstrap');
      started = true; void run(frame.input).catch(() => process.exit(1)); return;
    }
    if (finished) return;
    const receipt = pending.get(frame.id);
    if (frame.type !== 'reply' || !receipt) throw new Error('Unmatched evaluator reply');
    pending.delete(frame.id);
    if (frame.error) receipt.reject(decodeCodeExecError(frame.error)); else receipt.resolve(frame.result);
  } catch { process.exit(1); }
});
input.on('close', () => { if (!finished) process.exit(1); });
