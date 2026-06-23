/**
 * Spawn a command and stream its stdout+stderr as lines, for shell-out
 * installers (brew/pyenv/pecl) where progress is indeterminate. Rejects on
 * non-zero exit or spawn error (ENOENT → a clear "not found" message so the
 * UI can tell the user to install the prerequisite tool).
 *
 * Kept local to api-handlers (no cross-package dep) and intentionally tiny.
 */

import { spawn } from 'node:child_process';

export interface ShellStreamOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Windows needs shell:true for `.cmd`/`.bat` shims (brew/pyenv aren't, but pecl is). */
  shell?: boolean;
  /** Exit codes treated as success. Default `[0]`. (e.g. 3010 = reboot-required.) */
  okExitCodes?: number[];
}

/** Yield each line of combined stdout/stderr; throw if the process fails. */
export async function* spawnLogStream(
  program: string,
  args: string[],
  opts: ShellStreamOpts = {},
): AsyncGenerator<string> {
  const child = spawn(program, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    shell: opts.shell ?? false,
  });

  const lines: string[] = [];
  let resolveNext: (() => void) | null = null;
  let done = false;
  let failure: Error | null = null;

  const wake = (): void => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  };

  let buf = '';
  const onChunk = (chunk: Buffer): void => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, nl).replace(/\r$/, ''));
      buf = buf.slice(nl + 1);
    }
    wake();
  };

  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);
  child.on('error', (err) => {
    failure =
      (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? new Error(`'${program}' was not found on PATH`)
        : (err as Error);
    done = true;
    wake();
  });
  const okCodes = opts.okExitCodes ?? [0];
  child.on('close', (code) => {
    if (buf.length) lines.push(buf.replace(/\r$/, ''));
    if (!failure && (code == null || !okCodes.includes(code))) {
      failure = new Error(`${program} exited with code ${code}`);
    }
    done = true;
    wake();
  });

  for (;;) {
    while (lines.length) yield lines.shift()!;
    if (done) break;
    await new Promise<void>((r) => (resolveNext = r));
  }
  while (lines.length) yield lines.shift()!;
  if (failure) throw failure;
}
