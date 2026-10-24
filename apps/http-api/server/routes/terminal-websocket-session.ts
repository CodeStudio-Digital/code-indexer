import { killProcessTree } from '@mcp/shared/utils/process-tree.js';
import { type WsLike, type TerminalCtx, type NodePtyModule, type SpawnSpec, type IPty } from './terminal-websocket-types.js';

/** Active legacy WebSocket PTYs, drained by the process shutdown coordinator. */
const activeTerminalCleanups = new Set<() => void>();

export function closeTerminalWebSocketProcesses(): void {
  for (const cleanup of [...activeTerminalCleanups]) cleanup();
}

export function handleConnection(
  ws: WsLike,
  ctx: TerminalCtx,
  pty: NodePtyModule,
  spec: SpawnSpec,
): void {
  let proc: IPty;
  // Force WinPTY backend in Electron — see NodePtyModule's `useConpty`
  // comment. Plain Node deployments (CLI / standalone server) keep
  // ConPTY for the perf win.
  const inElectron = !!process.versions.electron;
  const isWindows = process.platform === 'win32';
  try {
    proc = pty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: ctx.cols,
      rows: ctx.rows,
      cwd: spec.cwd,
      env: spec.env,
      encoding: 'utf8',
      ...(isWindows && inElectron ? { useConpty: false } : {}),
    });
  } catch (e) {
    safeSend(ws, { type: 'error', message: `spawn failed: ${e instanceof Error ? e.message : String(e)}` });
    try { ws.close(1011, 'spawn failed'); } catch { /* best-effort */ }
    return;
  }

  const onData = proc.onData((data) => {
    safeSend(ws, { type: 'data', data });
  });
  const onExit = proc.onExit(({ exitCode, signal }) => {
    safeSend(ws, { type: 'exit', code: exitCode, signal });
    try { ws.close(1000, 'pty exited'); } catch { /* best-effort */ }
  });

  ws.on('message', (raw) => {
    let parsed: { type?: string; data?: string; cols?: number; rows?: number };
    try {
      const text = typeof raw === 'string' ? raw : raw.toString();
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      return;
    }
    if (parsed.type === 'data' && typeof parsed.data === 'string') {
      try { proc.write(parsed.data); } catch { /* shell died — wait for onExit */ }
    } else if (
      parsed.type === 'resize' &&
      typeof parsed.cols === 'number' &&
      typeof parsed.rows === 'number'
    ) {
      try { proc.resize(Math.max(1, parsed.cols), Math.max(1, parsed.rows)); } catch { /* ignore */ }
    }
  });

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    activeTerminalCleanups.delete(cleanup);
    onData.dispose();
    onExit.dispose();
    killProcessTree(proc.pid);
    try { proc.kill(); } catch { /* may already be dead */ }
    try { ws.close(1001, 'server shutting down'); } catch { /* already closed */ }
  };
  activeTerminalCleanups.add(cleanup);
  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

function safeSend(ws: WsLike, frame: Record<string, unknown>): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    /* connection lost — cleanup will fire from `close`/`error` */
  }
}
