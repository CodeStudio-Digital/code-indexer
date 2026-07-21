import type { DebugAdapterExecutable, DebugTargetLaunch } from '@mcp/plugin-sdk';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import { killProcessTree, trackProcessTree } from '@mcp/shared/utils/process-tree.js';
import { cmdDoubleQuote } from '../terminal/shell-quote.js';
import { DapConnection, connectDapTcp } from './dap-connection.js';

const MAX_DIAGNOSTIC_CHARS = 32_000;

function resolveWindowsExecutable(command: string, env: NodeJS.ProcessEnv): string {
  if (isAbsolute(command) || /[\\/]/.test(command)) return command;
  const extensions = extname(command)
    ? ['']
    : (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    const cleanDirectory = directory.trim().replace(/^"|"$/g, '');
    if (!cleanDirectory) continue;
    for (const extension of extensions) {
      const candidate = join(cleanDirectory, `${command}${extension.toLowerCase()}`);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        // Ignore inaccessible PATH entries and continue to the next candidate.
      }
    }
  }
  return command;
}

function appendBounded(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length <= MAX_DIAGNOSTIC_CHARS ? next : next.slice(-MAX_DIAGNOSTIC_CHARS);
}

export interface ReservedLoopbackPort {
  port: number;
  release(): Promise<void>;
}

/** Hold a loopback port until the caller is ready to let the target bind it. */
export async function reserveLoopbackPort(host: '127.0.0.1' | '::1'): Promise<ReservedLoopbackPort> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host, port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to reserve DAP port'));
        return;
      }
      const port = address.port;
      let releasePromise: Promise<void> | null = null;
      resolve({
        port,
        release: () => {
          releasePromise ??= new Promise<void>((resolveRelease, rejectRelease) => {
            server.close((error) => error ? rejectRelease(error) : resolveRelease());
          });
          return releasePromise;
        },
      });
    });
  });
}

async function connectWithRetry(
  host: string,
  port: number,
  timeoutMs: number,
  processExited: () => boolean,
): Promise<DapConnection> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (processExited()) throw new Error('debug adapter exited before accepting a connection');
    try {
      return (await connectDapTcp(host, port, Math.min(500, Math.max(1, deadline - Date.now())))).dap;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`debug adapter did not listen on ${host}:${port}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await waitForExit(child, 1_500)) return;
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    await new Promise<void>((resolve) => {
      killer.once('error', () => resolve());
      killer.once('exit', () => resolve());
    });
  } else {
    child.kill('SIGKILL');
  }
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !pidExists(pid);
}

/** Terminate only the exact debuggee tree reported by the DAP `process` event. */
export async function terminateDebuggeeTree(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || !pidExists(pid)) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    await new Promise<void>((resolve) => {
      killer.once('error', () => resolve());
      killer.once('exit', () => resolve());
    });
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  if (await waitForPidExit(pid, 1_500)) return;
  try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
}

export interface StartedDebugAdapter {
  child: ChildProcessWithoutNullStreams;
  dap: DapConnection;
  /** Open another DAP connection to the same multi-session server. */
  connectSession(): Promise<DapConnection>;
  diagnostics(): { stdout: string; stderr: string };
  dispose(): Promise<void>;
}

export interface StartedDebugTarget {
  child: ChildProcessWithoutNullStreams;
  dispose(): Promise<void>;
}

/**
 * Launch a debug target owned by the host, independently from the adapter.
 * This is required for runtimes such as Workerd: js-debug attaches to the
 * Inspector, but must not own or reinterpret the command that starts Wrangler.
 */
export async function startDebugTarget(
  target: DebugTargetLaunch,
  onOutput: (category: 'stdout' | 'stderr', output: string) => void,
): Promise<StartedDebugTarget> {
  if (!target.command.trim()) throw new Error('debug target command is empty');

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.NODE_OPTIONS;
  delete childEnv.TSX_TSCONFIG_PATH;
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.MCP_DEV_HTTP;
  delete childEnv.MCP_ELECTRON_DEV_URL;
  Object.assign(childEnv, target.env ?? {});

  let command = target.command;
  let args = [...(target.args ?? [])];
  let shell: string | false = false;
  if (process.platform === 'win32') {
    // .cmd package-manager shims cannot be executed directly by CreateProcess.
    // Build a strictly quoted command line before invoking the required cmd
    // shell, so project-controlled script names remain literal arguments.
    command = resolveWindowsExecutable(command, childEnv);
    command = [command, ...args].map(cmdDoubleQuote).join(' ');
    args = [];
    shell = process.env.COMSPEC ?? 'cmd.exe';
  }

  const child = spawn(command, args, {
    cwd: target.cwd,
    env: childEnv,
    windowsHide: true,
    stdio: 'pipe',
    detached: process.platform !== 'win32',
    shell,
  });
  child.stdout.on('data', (chunk) => onOutput('stdout', chunk.toString()));
  child.stderr.on('data', (chunk) => onOutput('stderr', chunk.toString()));

  await new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      child.removeListener('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.removeListener('spawn', onSpawn);
      reject(error);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
  child.on('error', (error) => onOutput('stderr', `${error.message}\n`));
  const untrack = trackProcessTree(child.pid);
  child.once('exit', untrack);

  return {
    child,
    async dispose() {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        await killProcessTree(child.pid, 'SIGTERM');
        if (!(await waitForExit(child, 1_500))) {
          await killProcessTree(child.pid, 'SIGKILL');
          if (!(await waitForExit(child, 1_500))) {
            child.kill('SIGKILL');
            await waitForExit(child, 1_000);
          }
        }
      }
      untrack();
    },
  };
}

export async function startDebugAdapter(executable: DebugAdapterExecutable): Promise<StartedDebugAdapter> {
  let args = [...(executable.args ?? [])];
  let host: '127.0.0.1' | '::1' | undefined;
  let port: number | undefined;

  if (executable.transport.kind === 'tcp') {
    host = executable.transport.host;
    if (host !== '127.0.0.1' && host !== '::1') throw new Error('debug adapter must bind to loopback');
    const reservation = await reserveLoopbackPort(host);
    port = reservation.port;
    const token = executable.transport.portToken;
    if (!args.some((arg) => arg.includes(token))) {
      await reservation.release();
      throw new Error('debug adapter command is missing its port token');
    }
    args = args.map((arg) => arg.split(token).join(String(port)));
    await reservation.release();
  }

  // The Electron dev launcher may itself run under tsx/other Node loader
  // flags. Those bootstrap hooks belong to the host and must not leak into an
  // adapter installed outside the monorepo, where their packages cannot be
  // resolved. An adapter can still opt back in explicitly through its env.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.NODE_OPTIONS;
  delete childEnv.TSX_TSCONFIG_PATH;
  Object.assign(childEnv, executable.env ?? {});

  const child = spawn(executable.command, args, {
    cwd: executable.cwd,
    env: childEnv,
    windowsHide: true,
    stdio: 'pipe',
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
  child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });

  try {
    const dap = executable.transport.kind === 'stdio'
      ? new DapConnection(child.stdout, child.stdin)
      : await connectWithRetry(
          host!,
          port!,
          executable.transport.connectTimeoutMs ?? 10_000,
          () => child.exitCode !== null || child.signalCode !== null,
        );
    const sessions = new Set<DapConnection>([dap]);
    return {
      child,
      dap,
      async connectSession() {
        if (executable.transport.kind !== 'tcp') {
          throw new Error('stdio debug adapters do not support additional sessions');
        }
        const session = (await connectDapTcp(host!, port!, executable.transport.connectTimeoutMs ?? 10_000)).dap;
        sessions.add(session);
        session.onClose(() => sessions.delete(session));
        return session;
      },
      diagnostics: () => ({ stdout, stderr }),
      async dispose() {
        for (const session of sessions) session.close();
        sessions.clear();
        await terminateChild(child);
      },
    };
  } catch (error) {
    await terminateChild(child);
    const detail = stderr.trim() || stdout.trim();
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `\n${detail}` : ''}`);
  }
}
