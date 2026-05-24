/**
 * Terminal IPC bridge — replaces the WebSocket `/ws/terminal/:id` gateway
 * for the Electron renderer. The renderer opens a MessagePort stream
 * via `electronAPI.api.terminal.open({sessionId, target, cols, rows})`,
 * and gets back a port that streams the same {type, data} frames the
 * WebSocket gateway emitted. Input (keystrokes, resize) flows back over
 * the same port.
 *
 * Why this exists: the only remaining HTTP user inside Electron was the
 * terminal — WebSocket needs an HTTP upgrade, and our goal is zero
 * loopback. By spawning node-pty in the main process and piping bytes
 * over MessagePort, we get the exact same UX with no socket.
 *
 * Wire protocol (mirrors the legacy WS gateway so the dashboard's
 * existing xterm handlers don't change):
 *   - Inbound  (renderer → main):
 *       { type: 'data',   data: string }              keystrokes
 *       { type: 'resize', cols: number, rows: number } term resize
 *       { type: 'close' }                             user closed the panel
 *   - Outbound (main → renderer):
 *       { type: 'data',  data: string }                PTY stdout/stderr
 *       { type: 'exit',  code: number, signal?: number }
 *       { type: 'error', message: string }
 *
 * Two `target`s:
 *   - 'host' — spawns the operator's local shell (PowerShell on Windows,
 *              bash elsewhere) at the project's root_path. Gated by
 *              MCP_HOST_TERMINAL_ENABLED=1 to mirror the legacy WS rule.
 *   - 'sandbox' — `podman exec -it <container> bash` into the session's
 *                 primary container. We do NOT implement sandbox here in
 *                 the first cut — it depends on the orchestrator registry
 *                 which lives in apps/http-api. Sandbox terminals continue
 *                 to ride the legacy WS (operator must MCP_DEV_HTTP=1).
 */

import { createRequire } from 'node:module';
import { ipcMain, MessageChannelMain, type IpcMainEvent } from 'electron';
import type { ServerDeps } from '@apps/http-api/server/deps.js';

const require = createRequire(import.meta.url);

interface IPty {
  pid: number;
  cols: number;
  rows: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[] | string,
    opts: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string | undefined>;
      encoding?: string;
    },
  ): IPty;
}

let cachedPty: NodePtyModule | null | undefined;
function tryLoadPty(): NodePtyModule | null {
  if (cachedPty !== undefined) return cachedPty;
  try {
    cachedPty = require('node-pty') as NodePtyModule;
  } catch {
    cachedPty = null;
  }
  return cachedPty;
}

interface OpenInput {
  sessionId: number;
  /** 'host' | 'sandbox'. Sandbox not yet supported via IPC (falls back to error). */
  target?: 'host' | 'sandbox';
  cols?: number;
  rows?: number;
  /** Project ID for `target=host` — its root_path is used as cwd. Optional;
   *  falls back to companyStore.getSession when sessionId provided. */
  projectId?: number;
}

/**
 * Mount the terminal IPC stream handler. The renderer calls this via
 * preload's `electronAPI.api.terminal.open({sessionId, target, ...})`,
 * which the proxy resolves as a streaming method (registered in
 * preload's STREAMING_METHOD_PATHS — we add `terminal:open` below).
 *
 * The handler creates a MessagePort, hands one half to the renderer,
 * spawns node-pty, and pumps frames in both directions.
 */
export function mountTerminalIpc(deps: ServerDeps): void {
  const channel = 'api:terminal:open';

  ipcMain.on(`stream:${channel}`, async (event: IpcMainEvent, msg: { requestId: string; payload: OpenInput }) => {
    const { requestId, payload } = msg;
    const { port1, port2 } = new MessageChannelMain();
    event.sender.postMessage(`stream-port:${requestId}`, null, [port1]);
    port2.start();

    const post = (frame: unknown): void => {
      try {
        port2.postMessage({ type: 'value', value: frame });
      } catch {
        /* port closed — caller went away */
      }
    };
    const fail = (message: string): void => {
      post({ type: 'error', message });
      post({ type: 'exit', code: 1 });
      try {
        port2.postMessage({ type: 'done' });
        port2.close();
      } catch {
        /* already closed */
      }
    };

    const pty = tryLoadPty();
    if (!pty) {
      fail('node-pty is not available — rebuild for the Electron ABI (pnpm electron:rebuild)');
      return;
    }

    const target = payload.target ?? 'host';
    if (target === 'sandbox') {
      // Sandbox terminals route through the orchestrator registry +
      // container engine. We haven't ported that path to IPC yet — for
      // now, surface a structured error so the dashboard's terminal
      // panel can fall back to the legacy WS path (MCP_DEV_HTTP=1).
      fail('sandbox terminals via IPC are not yet wired — set MCP_DEV_HTTP=1 to use the WS fallback');
      return;
    }
    if (target === 'host' && process.env.MCP_HOST_TERMINAL_ENABLED !== '1') {
      fail('host terminal disabled — set MCP_HOST_TERMINAL_ENABLED=1 to enable');
      return;
    }

    // Resolve the working directory. If projectId provided, use its
    // root_path. Otherwise look up the session's project. Fall back to
    // user home if neither resolves.
    let cwd = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
    try {
      if (payload.projectId) {
        const project = deps.db.getProject(payload.projectId);
        if (project?.root_path) cwd = project.root_path;
      } else if (payload.sessionId) {
        const session = deps.sessionStore.getSession(payload.sessionId);
        if (session?.project_id) {
          const project = deps.db.getProject(session.project_id);
          if (project?.root_path) cwd = project.root_path;
        }
      }
    } catch {
      /* keep fallback cwd */
    }

    // Pick the shell. Windows: prefer pwsh, then powershell, then cmd.
    // Unix: $SHELL → /bin/bash → /bin/sh.
    const isWindows = process.platform === 'win32';
    const shell = isWindows
      ? (process.env.COMSPEC?.includes('pwsh')
          ? process.env.COMSPEC
          : 'powershell.exe')
      : (process.env.SHELL ?? '/bin/bash');
    const args: string[] = isWindows ? [] : ['-l'];

    let term: IPty;
    try {
      term = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: payload.cols ?? 80,
        rows: payload.rows ?? 24,
        cwd,
        env: process.env as Record<string, string | undefined>,
        encoding: 'utf-8',
      });
    } catch (e) {
      fail(`failed to spawn shell: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    const dataSub = term.onData((data) => post({ type: 'data', data }));
    const exitSub = term.onExit(({ exitCode, signal }) => {
      post({ type: 'exit', code: exitCode, signal });
      try {
        port2.postMessage({ type: 'done' });
        port2.close();
      } catch {
        /* already closed */
      }
    });

    port2.on('message', (msgEvt) => {
      const frame = msgEvt.data as { type?: string; data?: string; cols?: number; rows?: number };
      if (!frame || typeof frame !== 'object') return;
      if (frame.type === 'data' && typeof frame.data === 'string') {
        try { term.write(frame.data); } catch { /* pty dying */ }
      } else if (frame.type === 'resize' && typeof frame.cols === 'number' && typeof frame.rows === 'number') {
        try { term.resize(frame.cols, frame.rows); } catch { /* pty dying */ }
      } else if (frame.type === 'close') {
        try { term.kill(); } catch { /* already dead */ }
      }
    });
    port2.on('close', () => {
      dataSub.dispose();
      exitSub.dispose();
      try { term.kill(); } catch { /* already dead */ }
    });
  });
}
