import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const READY = /^CODESTUDIO_AGENT_PACKAGE_READY_V1 role=(runner|supervisor) pid=(\d+)$/;
const MAX_OUTPUT_BYTES = 4096;
const START_TIMEOUT_MS = 5000;
const EXIT_TIMEOUT_MS = 5000;

export async function probeInstalledBinary(
  executable: string,
  expectedRole: 'runner' | 'supervisor',
): Promise<void> {
  const token = randomBytes(32).toString('hex');
  const child = spawn(executable, ['--package-smoke'], {
    env: {
      ...process.env,
      CODESTUDIO_AGENT_PACKAGE_SMOKE_TOKEN: token,
    },
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let exited = false;
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = boundedAppend(stderr, chunk, true);
  });
  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });
  try {
    const line = await firstLine(child, START_TIMEOUT_MS);
    const match = READY.exec(line);
    if (
      !match
      || match[1] !== expectedRole
      || Number(match[2]) !== child.pid
    ) throw new TypeError(`invalid package readiness marker: ${line}`);
    if (!child.kill('SIGKILL')) {
      throw new Error(`failed to kill installed ${expectedRole}`);
    }
    const outcome = await deadline(
      exit,
      EXIT_TIMEOUT_MS,
      `installed ${expectedRole} ignored kill`,
    );
    if (outcome.code === 0 && outcome.signal === null) {
      throw new Error(`installed ${expectedRole} exited without physical kill`);
    }
  } catch (error) {
    const suffix = stderr ? `; stderr=${stderr}` : '';
    throw new Error(`${error instanceof Error ? error.message : error}${suffix}`);
  } finally {
    child.stdin.destroy();
    if (!exited) child.kill('SIGKILL');
  }
}

function firstLine(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<string> {
  return deadline(new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        output = boundedAppend(output, chunk);
        const newline = output.indexOf('\n');
        if (newline >= 0) resolve(output.slice(0, newline).trim());
      } catch (error) {
        reject(error);
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      reject(new Error(`binary exited before readiness with code ${code}`));
    });
  }), timeoutMs, 'installed binary readiness timed out');
}

function boundedAppend(
  current: string,
  chunk: Buffer,
  truncate = false,
): string {
  const next = current + chunk.toString('utf8');
  if (Buffer.byteLength(next, 'utf8') > MAX_OUTPUT_BYTES) {
    if (truncate) return next.slice(0, MAX_OUTPUT_BYTES);
    throw new RangeError('installed binary output exceeded smoke limit');
  }
  return next;
}

async function deadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
