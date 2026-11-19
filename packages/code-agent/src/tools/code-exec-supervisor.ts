import { spawn } from 'node:child_process';
import { CODE_EXEC_EVALUATOR } from './code-exec-evaluator.js';
import { CODE_EXEC_FRAME_BYTES, decodeCodeExecError, encodeCodeExecError, type CodeExecBootstrap } from './code-exec-protocol.js';
import { killProcessTree, trackProcessTree } from '@mcp/shared/utils/process-tree.js';

export function superviseCodeExec(input: CodeExecBootstrap & { blocked?: string[] }, handlers: {
  invoke(kind: string, name: string, args: unknown): unknown;
  log(level: string, parts: unknown[], inputBytes: number): void;
  logOmission(lines: number, bytes: number): void;
  stash(op: string, key: string, value?: unknown): void;
  ready(): void;
}) {
  // No provider tokens, NODE_OPTIONS, preload hooks or project environment.
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  const child = spawn(process.execPath, ['--max-old-space-size=128', '-e', CODE_EXEC_EVALUATOR], {
    env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe'],
  });
  const untrack = trackProcessTree(child.pid);
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  let closed = false, settled = false, ready = false, lastHeartbeat = performance.now(), bytes = 0, incomingBytes = 0, pending = '', stderr = '';
  let lastWatchdogTick = lastHeartbeat;
  const requestIds = new Set<number>();
  let rejectRun!: (reason: unknown) => void;
  const promise = new Promise<unknown>((resolve, reject) => {
    rejectRun = reject;
    const fail = (error: unknown) => { if (!settled) { settled = true; reject(error); } };
    const send = (frame: unknown) => {
      if (closed || child.stdin.destroyed) return;
      const json = JSON.stringify(frame);
      const size = Buffer.byteLength(json);
      if (size > CODE_EXEC_FRAME_BYTES || (bytes += size) > CODE_EXEC_FRAME_BYTES) {
        fail(new Error('code_exec transfer budget exceeded')); return;
      }
      child.stdin.write(json + '\n');
    };
    child.stdin.on('error', fail);
    child.on('error', fail);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data: string) => { stderr = (stderr + data).slice(-4000); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      if ((incomingBytes += Buffer.byteLength(data)) > CODE_EXEC_FRAME_BYTES) { fail(new Error('code_exec input transfer budget exceeded')); return; }
      pending += data;
      if (Buffer.byteLength(pending) > CODE_EXEC_FRAME_BYTES) { fail(new Error('code_exec output frame budget exceeded')); return; }
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try {
          const frame = JSON.parse(line);
          if (frame.type === 'ready') { ready = true; lastHeartbeat = performance.now(); handlers.ready(); }
          else if (frame.type === 'heartbeat') {
            lastHeartbeat = performance.now();
            if (frame.cpuMs > input.timeoutMs) fail(Object.assign(new Error('code_exec active CPU budget exceeded'), { code: 'CODE_EXEC_JS_TIMEOUT' }));
          } else if (frame.type === 'invoke') {
            if (settled || !Number.isSafeInteger(frame.id) || frame.id < 1 || frame.id > 128 || requestIds.has(frame.id)) throw new Error('code_exec invalid, duplicate or late invocation');
            requestIds.add(frame.id);
            Promise.resolve().then(() => handlers.invoke(frame.kind, frame.name, frame.args)).then(
              value => send({ type:'response', id:frame.id, value }),
              error => send({ type:'response', id:frame.id, error:encodeCodeExecError(error) }),
            ).catch(fail);
          } else if (frame.type === 'log') handlers.log(frame.level, frame.parts, frame.inputBytes);
          else if (frame.type === 'logOmission') {
            if (!Number.isSafeInteger(frame.lines) || !Number.isSafeInteger(frame.bytes) || frame.lines < 0 || frame.bytes < 0) throw new Error('Invalid log accounting');
            handlers.logOmission(frame.lines, frame.bytes);
          }
          else if (frame.type === 'stash') handlers.stash(frame.op, frame.key, frame.value);
          else if (frame.type === 'error') fail(decodeCodeExecError(frame.error));
          else if (frame.type === 'result' && !settled) { settled = true; resolve(frame.value); }
        } catch (error) { fail(error); }
      }
    });
    child.on('close', (code) => {
      untrack();
      if (!settled) fail(new Error(`code_exec evaluator exited (${code}): ${stderr}`));
    });
    send({ type:'start', bootstrap:input });
  });
  // This clock is in the owning process; a post-await spin cannot block it.
  const watchdog = setInterval(() => {
    if (settled) return;
    const now = performance.now();
    const hostDelay = now - lastWatchdogTick;
    lastWatchdogTick = now;
    // A synchronous host tool can delay both this timer and stdout delivery.
    // Timers may run BEFORE the queued heartbeats are read. Give the pipe a
    // fresh observation window instead of charging host starvation to the
    // evaluator. Its reported CPU budget and the batch wall deadline remain
    // enforced; a child-only spin still times out on a responsive host.
    if (hostDelay > 150) {
      lastHeartbeat = now;
      return;
    }
    if (now - lastHeartbeat > (ready ? Math.max(100, input.timeoutMs) : 10_000)) {
      settled = true;
      rejectRun(Object.assign(new Error('code_exec timed out waiting for the evaluator to respond'), { code: 'CODE_EXEC_JS_TIMEOUT' }));
    }
  }, 50);
  watchdog.unref();
  return { promise, pid: child.pid, async close() {
    if (closed) return;
    closed = true;
    clearInterval(watchdog);
    child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 100); })]);
    if (timer) clearTimeout(timer);
    if (child.exitCode == null && child.pid) {
      // Direct kill is tied to this ChildProcess handle; tree cleanup uses its owned PID.
      child.kill('SIGKILL');
      await killProcessTree(child.pid);
    }
    await exited;
    untrack();
  } };
}
