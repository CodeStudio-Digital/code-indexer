import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import type { NativeDuplexOptions, NativeHostDuplexProcess } from '@mcp/agent-runtime-host';
import { ok, err, type ToolResult } from '@mcp/code-agent/core/tool.js';
import type { IPersistentCommandPort, PersistentCommandRequest } from '@mcp/code-agent/ports/persistent-command-port.js';
import { applyRuntimeEnv, cleanProcessEnv, BoundedUtf8Capture } from '@mcp/code-agent/ports/shell-port.js';

interface Session {
  id: string; command: string; mode: 'pipe' | 'pty'; owner: NativeHostDuplexProcess; pending: BoundedUtf8Capture;
  maximum: number; done: Promise<void>; exitCode?: number | null; failure?: unknown;
  busy: boolean; uncertain?: boolean; idle: ReturnType<typeof setTimeout>;
}

/** Command sessions belong to one attempt, including between provider turns.
 * A returned prompt never releases the Job; only wait() proves physical reap. */
export class NativePersistentCommandPort implements IPersistentCommandPort {
  readonly mutationFenceAttested = true as const;
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Set<Promise<void>>();
  private closed = false;
  private failure: unknown;
  private readonly onAbort = () => { for (const session of this.sessions.values()) session.owner.cancel(); };

  constructor(private readonly spawn: (input: NativeDuplexOptions) => NativeHostDuplexProcess,
    private readonly deadlineAtUnixMs: number, private readonly signal: AbortSignal,
    private readonly outcomeUnknown: () => void, private readonly supportsPty = false) {
    signal.addEventListener('abort', this.onAbort, { once: true });
  }

  assertQuiescent(): void {
    if (this.failure || this.pending.size) throw new Error('Finish active persistent commands and reconcile uncertain effects before delegating the workspace');
  }

  async start(input: Parameters<IPersistentCommandPort['start']>[0]): Promise<ToolResult> {
    this.assertOpen(input.signal);
    if (input.tty && !this.supportsPty) return err('This native runtime package does not support tty=true.');
    const columns = input.columns ?? 120; const rows = input.rows ?? 30;
    if (input.tty && (!Number.isInteger(columns) || columns < 1 || columns > 500
      || !Number.isInteger(rows) || rows < 1 || rows > 300)) return err('PTY geometry must be 1-500 columns and 1-300 rows.');
    if (this.sessions.size >= 16) return err('Persistent command session limit reached; finish existing sessions first.');
    const remaining = this.deadlineAtUnixMs - Date.now();
    if (remaining <= 0) throw new Error('Native persistent command lease expired');
    if (!Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1000 || input.maxOutputBytes > 800_000) {
      throw new Error('Native persistent command output bound');
    }
    const environment = Object.fromEntries(Object.entries(applyRuntimeEnv(cleanProcessEnv(), input.runtimeEnv))
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    input.assertFence();
    let owner: NativeHostDuplexProcess;
    try {
      owner = this.spawn({ executable: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
        arguments: ['/d', '/s', '/c', input.command], cwd: input.cwd, environment,
        timeoutMs: Math.max(1, Math.min(remaining, 86_400_000)), streamStderr: true,
        ...(input.tty ? { tty: true, columns, rows } : {}) });
    } catch (cause) { this.failure = cause; this.outcomeUnknown(); throw cause; }
    const session: Session = { id: randomUUID().slice(0, 8), command: input.command, mode: input.tty ? 'pty' : 'pipe', owner,
      pending: new BoundedUtf8Capture(input.maxOutputBytes), maximum: input.maxOutputBytes,
      done: Promise.resolve(), busy: true, idle: setTimeout(() => owner.cancel(), 600_000) };
    session.idle.unref();
    this.sessions.set(session.id, session);
    session.done = this.observe(session);
    this.pending.add(session.done);
    void session.done.finally(() => this.pending.delete(session.done));
    try { return await this.collect(session, input); }
    finally { session.busy = false; }
  }

  async write(input: Parameters<IPersistentCommandPort['write']>[0]): Promise<ToolResult> {
    this.assertOpen(input.signal);
    const session = this.sessions.get(input.sessionId);
    if (!session) return err(`write_stdin: session '${input.sessionId}' is not active in this attempt. Use list_sessions.`);
    if (session.uncertain) return { ...err('This session has unconfirmed stdin; reconciliation is required before further input.'), effectOutcome: 'unknown' };
    if (session.busy) return err('Persistent command already has an active consumer; wait for that invocation.');
    if (Buffer.byteLength(input.chars) > 1_048_576) return err('Persistent command stdin exceeds 1 MiB.');
    session.busy = true;
    const cancel = () => session.owner.cancel();
    input.signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (input.chars && session.exitCode === undefined && !session.failure) {
        input.assertFence();
        const receipt = session.owner.write(Buffer.from(input.chars));
        try { await receipt.wait(); }
        catch {
          session.uncertain = true; this.outcomeUnknown(); session.owner.cancel();
          return { ...err('stdin completion is uncertain; do not resend this input. Reconciliation is required.'), effectOutcome: 'unknown' };
        }
      }
      return await this.collect(session, input);
    } finally { input.signal?.removeEventListener('abort', cancel); session.busy = false; }
  }

  list(): ToolResult {
    return ok(this.sessions.size ? [...this.sessions.values()].map(session =>
      `${session.id} | ${session.failure ? 'cleanup_unconfirmed' : session.exitCode === undefined ? 'running' : 'exited'} | ${session.mode} | ${session.command.slice(0, 80)}`).join('\n')
      : '(no active sessions; spawn one with exec_command first)');
  }

  async close(): Promise<void> {
    this.closed = true;
    this.signal.removeEventListener('abort', this.onAbort);
    this.onAbort();
    await Promise.all([...this.pending]);
    this.sessions.clear();
    if (this.failure) throw new Error('Native persistent commands have unproven cleanup', { cause: this.failure });
  }

  private assertOpen(signal?: AbortSignal) {
    if (this.closed) throw new Error('Native persistent command scope is closed');
    this.signal.throwIfAborted(); signal?.throwIfAborted();
  }

  private async observe(session: Session): Promise<void> {
    const drain = async () => {
      if (!session.owner.readOutput) throw new Error('Native package lacks tagged command output');
      const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
      let sinceYield = performance.now();
      for (;;) {
        const chunk = await session.owner.readOutput();
        if (!chunk) break;
        session.pending.append(decoders[chunk.stderr ? 1 : 0].write(Buffer.from(chunk.bytes)));
        if (performance.now() - sinceYield >= 6) { await yieldEventLoop(); sinceYield = performance.now(); }
      }
      for (const decoder of decoders) session.pending.append(decoder.end());
    };
    const output = drain().catch(cause => { session.owner.cancel(); throw cause; });
    const reaped = session.owner.wait();
    // Await both even after IO failure; a rejected read cannot bypass reap.
    const [read, exit] = await Promise.allSettled([output, reaped]);
    clearTimeout(session.idle);
    if (read.status === 'rejected' || exit.status === 'rejected'
      || !exit.value.reaped || exit.value.processId !== session.owner.processId) {
      session.failure = read.status === 'rejected' ? read.reason : exit.status === 'rejected' ? exit.reason : new Error('Missing command reap evidence');
      this.failure ??= session.failure;
      this.outcomeUnknown();
    } else session.exitCode = exit.value.cancelled || exit.value.timedOut ? null : exit.value.exitCode;
  }

  private async collect(session: Session, input: PersistentCommandRequest): Promise<ToolResult> {
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); input.signal?.removeEventListener('abort', cancel); resolve(); };
      const cancel = () => { session.owner.cancel(); finish(); };
      const timer = setTimeout(finish, Math.max(0, Math.min(60_000, input.yieldMs)));
      void session.done.then(finish);
      input.signal?.addEventListener('abort', cancel, { once: true });
      if (input.signal?.aborted) cancel();
    });
    if (session.exitCode === undefined && !session.failure) session.idle.refresh();
    if (session.failure) return { ...err('Persistent command cleanup is unconfirmed; reconciliation is required.'), effectOutcome: 'unknown' };
    const output = session.pending.finishDetailed();
    session.pending = new BoundedUtf8Capture(session.maximum);
    const status = session.exitCode === undefined ? 'running' : 'exited';
    if (status === 'exited') this.sessions.delete(session.id);
    return { content: `session_id=${session.id} status=${status}${status === 'exited' ? ` exit=${session.exitCode ?? 'signal'}` : ''}\n\n${output.content || '(no new output)'}`,
      ...(output.truncation ? { sourceTruncations: [{ technique: 'bounded-stream-cap', unit: 'bytes' as const,
        inputSize: output.truncation.inputBytes, outputSize: output.truncation.outputBytes, recoverable: false }] } : {}) };
  }
}
