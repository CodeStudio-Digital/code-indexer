import type { DebugAdapterExecutable } from '@mcp/plugin-sdk';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { DapConnection, connectDapTcp } from './dap-connection.js';

const MAX_DIAGNOSTIC_CHARS = 32_000;

function appendBounded(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length <= MAX_DIAGNOSTIC_CHARS ? next : next.slice(-MAX_DIAGNOSTIC_CHARS);
}

async function reserveLoopbackPort(host: '127.0.0.1' | '::1'): Promise<number> {
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
      server.close((error) => error ? reject(error) : resolve(port));
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
    await new Promise<void>((resolve) => killer.once('exit', () => resolve()));
  } else {
    child.kill('SIGKILL');
  }
}

export interface StartedDebugAdapter {
  child: ChildProcessWithoutNullStreams;
  dap: DapConnection;
  /** Open another DAP connection to the same multi-session server. */
  connectSession(): Promise<DapConnection>;
  diagnostics(): { stdout: string; stderr: string };
  dispose(): Promise<void>;
}

export async function startDebugAdapter(executable: DebugAdapterExecutable): Promise<StartedDebugAdapter> {
  let args = [...(executable.args ?? [])];
  let host: '127.0.0.1' | '::1' | undefined;
  let port: number | undefined;

  if (executable.transport.kind === 'tcp') {
    host = executable.transport.host;
    if (host !== '127.0.0.1' && host !== '::1') throw new Error('debug adapter must bind to loopback');
    port = await reserveLoopbackPort(host);
    const token = executable.transport.portToken;
    if (!args.some((arg) => arg.includes(token))) throw new Error('debug adapter command is missing its port token');
    args = args.map((arg) => arg.split(token).join(String(port)));
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
