import { statSync } from 'node:fs';
import { isAbsolute, join, delimiter, resolve } from 'node:path';
import type { NativeHostCommand, NativeHostCommandOptions, NativeHostCommandResult } from '@mcp/agent-runtime-host';
import { applyRuntimeEnv, cleanProcessEnv, formatBoundedBuffers,
  type IShellPort, type ShellExecOptions, type ShellExecResult, type ShellRunOptions } from '@mcp/code-agent/ports/shell-port.js';

/** All descendants belong to one native Job. A rejected cleanup keeps the
 * workspace fenced; a tool error alone is never evidence that children died. */
export class NativeShellPort implements IShellPort {
  readonly mutationFenceAttested = true as const;
  private readonly pending = new Set<Promise<ShellExecResult>>();
  private readonly owners = new Set<NativeHostCommand>();
  private failure: unknown;
  private closed = false;

  constructor(private readonly start: (options: NativeHostCommandOptions) => NativeHostCommand,
    private readonly deadlineAtUnixMs: number, private readonly signal: AbortSignal) {}

  exec(command: string, options: ShellExecOptions): Promise<ShellExecResult> {
    return this.spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), ['/d', '/s', '/c', command], options);
  }

  run(program: string, args: string[], options: ShellRunOptions): Promise<ShellExecResult> {
    return this.spawn(program, args, { ...options, timeoutMs: options.timeoutMs ?? 600_000 });
  }

  spawn(program: string, args: string[], options: ShellExecOptions): Promise<ShellExecResult> {
    if (this.closed) throw new Error('Native Host command scope is closed');
    this.signal.throwIfAborted(); options.signal?.throwIfAborted();
    const environment = Object.fromEntries(Object.entries(options.env ?? applyRuntimeEnv(cleanProcessEnv(), options.runtimeEnv))
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    const remaining = this.deadlineAtUnixMs - Date.now();
    if (remaining <= 0) throw new Error('Native Host command lease expired');
    const maximum = options.maxOutputBytes ?? 100_000;
    if (!Number.isSafeInteger(maximum) || maximum <= 0 || maximum > 1_048_576) throw new Error('Native Host command output bound');
    const executable = resolveExecutable(program, options.cwd, environment);
    // No await between the registry's physical fence and this contained spawn.
    let owner: NativeHostCommand;
    try {
      owner = this.start({ executable, arguments: args, cwd: options.cwd, environment,
        stdin: Buffer.from(options.stdin ?? ''), timeoutMs: Math.max(1, Math.min(remaining, options.timeoutMs, 600_000)),
        maximumOutputBytes: maximum });
    } catch (error) { this.failure = error; throw error; }
    this.owners.add(owner);
    const cancel = () => owner.cancel();
    this.signal.addEventListener('abort', cancel, { once: true });
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (this.signal.aborted || options.signal?.aborted) cancel();
    const pending = owner.wait().then(result => {
      if (result.processId !== owner.processId || !result.reaped) throw new Error('Native Host command lacks physical reap evidence');
      return formatResult(result, maximum);
    }).catch(error => { this.failure = error; throw error; }).finally(() => {
      this.signal.removeEventListener('abort', cancel); options.signal?.removeEventListener('abort', cancel);
      this.owners.delete(owner); this.pending.delete(pending);
    });
    this.pending.add(pending);
    return pending;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const owner of this.owners) owner.cancel();
    await Promise.allSettled([...this.pending]);
    if (this.failure) throw new Error('Native Host commands have unproven cleanup', { cause: this.failure });
  }

  assertQuiescent(): void {
    if (this.failure || this.pending.size) throw new Error('Native Host commands must be physically reaped before workspace delegation');
  }
}

function resolveExecutable(program: string, cwd: string, environment: Record<string, string>): string {
  const roots = isAbsolute(program) || /[\\/]/.test(program) ? [resolve(cwd, program)]
    : (environment.PATH ?? environment.Path ?? '').split(delimiter).filter(Boolean).map(root => join(root.replace(/^"|"$/g, ''), program));
  for (const root of roots) {
    for (const path of /\.(exe|com)$/i.test(root) ? [root] : [`${root}.exe`, `${root}.com`]) {
      try { if (statSync(path).isFile()) return path; } catch { /* next explicit executable candidate */ }
    }
  }
  throw new Error(`Native Host executable not found: ${program}`);
}

function formatResult(result: NativeHostCommandResult, maximum: number): ShellExecResult {
  const capture = (head: Uint8Array, tail: Uint8Array, total: number) => {
    if (!Number.isSafeInteger(total) || total < head.length + tail.length || head.length + tail.length > maximum) {
      throw new Error('Invalid native Host output evidence');
    }
    const content = total <= maximum ? Buffer.concat([head, tail]).toString('utf8')
      : formatBoundedBuffers(Buffer.from(head), Buffer.from(tail), total, maximum);
    return { content, ...(total > maximum ? { truncation: { inputBytes: total, outputBytes: Buffer.byteLength(content) } } : {}) };
  };
  const stdout = capture(result.stdoutHead, result.stdoutTail, result.stdoutTotalBytes);
  const stderr = capture(result.stderrHead, result.stderrTail, result.stderrTotalBytes);
  return { stdout: stdout.content, stderr: stderr.content, exitCode: result.cancelled || result.timedOut ? null : result.exitCode,
    timedOut: result.timedOut, stdoutTruncation: stdout.truncation, stderrTruncation: stderr.truncation };
}
