/**
 * Terminal WebSocket gateway — interactive PTY into the sandbox container
 * (via `podman exec -it`) OR into the host shell (PowerShell on Windows,
 * bash on macOS/Linux) for the session's project root.
 *
 * Phase D of the "living company" restructure. Wires xterm.js in the
 * dashboard to a live shell so the operator can run scripts in the
 * sandbox or against their local Node/Python/Unity setup without
 * leaving the agents UI.
 *
 * Protocol:
 *   - URL: `GET /ws/terminal/:sessionId?target=sandbox|host` (HTTP Upgrade)
 *   - Inbound frames (text, JSON):
 *       { type: 'data',   data: string }              user keystrokes
 *       { type: 'resize', cols: number, rows: number } resize the PTY
 *   - Outbound frames (text, JSON):
 *       { type: 'data', data: string }                PTY stdout/stderr
 *       { type: 'exit', code: number, signal?: number }  PTY exited
 *       { type: 'error', message: string }            unrecoverable error
 *
 * Security:
 *   - The HTTP server should bind to loopback in single-user dev. We
 *     additionally validate `Origin` against an allowlist (defaults to
 *     localhost + 127.0.0.1) and reject upgrades otherwise.
 *   - **Host target is gated by `MCP_HOST_TERMINAL_ENABLED=1`** — opt-in
 *     because it gives shell access to the operator's machine. A `host`
 *     upgrade without the flag returns 403.
 *   - Every host PTY open is logged with `{ sessionId, ts, pid }`.
 *
 * Native dependency: `node-pty`. Loaded lazily via `createRequire` so a
 * missing prebuild on exotic platforms degrades gracefully (returns a
 * 503 instead of failing module load and crashing the server).
 */

import { createRequire } from 'node:module';
import type { Duplex } from 'node:stream';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Hono } from 'hono';
import type { CompanySandboxStore } from '@mcp/store/company-sandbox-store.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { killProcessTree } from '@mcp/shared/utils/process-tree.js';
import { getCompanyOrchestrator } from '../../sse/companyOrchestrator.js';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import {
  asCompanySessionId,
  type CompanySessionId,
} from '@mcp/session-storage';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';

// ─── ws + node-pty surface (typed locally — no @types installed) ──

interface WsLike {
  readyState: number;
  readonly OPEN: number;
  send(data: string, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: string | Buffer) => void): void;
  on(event: 'close' | 'error', listener: (err?: Error) => void): void;
  once(event: 'close', listener: () => void): void;
}

interface WebSocketServerLike {
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    cb: (ws: WsLike) => void,
  ): void;
}

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
      /** Windows-only — force WinPTY when inside Electron (ConPTY's
       *  agent helper crashes on AttachConsole under GUI subsystem). */
      useConpty?: boolean;
    },
  ): IPty;
}

const require = createRequire(import.meta.url);
const wsModule = require('ws') as {
  WebSocketServer: new (opts: { noServer: boolean }) => WebSocketServerLike;
};

let cachedPty: NodePtyModule | null | undefined;
function tryLoadPty(): NodePtyModule | null {
  if (cachedPty !== undefined) return cachedPty;
  try {
    cachedPty = require('node-pty') as NodePtyModule;
  } catch (e) {
    console.warn(
      `[terminal-ws] node-pty failed to load — terminal feature disabled: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    cachedPty = null;
  }
  return cachedPty;
}

// ─── Public wire-up ──────────────────────────────────────────────

const PATH_RE =
  /^\/ws\/terminal\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\?(.*))?$/i;
const DEFAULT_ORIGINS = new Set(['http://localhost', 'http://127.0.0.1']);

export interface TerminalUpgradeDeps {
  sessionStore: FsSessionStore;
  companySandboxStore: CompanySandboxStore;
  db: CodeIndexDB;
}

/**
 * Pre-flight HTTP diagnose. Returns the same gate decision the WS
 * upgrade applies, but as a JSON response — the browser can't read
 * the HTTP status of a rejected WebSocket upgrade (the spec collapses
 * every rejection into close code 1006 with no reason), so the
 * terminal UI calls this endpoint first and surfaces the structured
 * error instead of an opaque "code 1006".
 *
 * Mounted at `GET /api/terminal/diagnose?sessionId=N&target=sandbox|host`.
 */
export function mountTerminalDiagnoseRoute(app: Hono, deps: TerminalUpgradeDeps): void {
  app.get('/api/terminal/diagnose', async (c) => {
    const sessionIdRaw = c.req.query('sessionId') ?? '';
    const targetRaw = c.req.query('target') ?? 'sandbox';
    let sessionId: CompanySessionId;
    try {
      sessionId = asCompanySessionId(sessionIdRaw);
      await deps.sessionStore.ensureCatalog();
    } catch {
      return c.json({ ok: false, code: 400, error: 'sessionId must be a canonical Company session UUID' }, 400);
    }
    if (targetRaw !== 'sandbox' && targetRaw !== 'host') {
      return c.json({ ok: false, code: 400, error: `target must be 'sandbox' or 'host' (got '${targetRaw}')` }, 400);
    }
    if (targetRaw === 'host' && process.env.MCP_HOST_TERMINAL_ENABLED !== '1') {
      return c.json(
        {
          ok: false,
          code: 403,
          error: 'Host terminal is disabled. Set MCP_HOST_TERMINAL_ENABLED=1 in the http-api process env and restart the server.',
          remediation: 'env',
        },
        403,
      );
    }
    if (!tryLoadPty()) {
      return c.json(
        {
          ok: false,
          code: 503,
          error: 'node-pty failed to load on this server. Check the [terminal-ws] warning in the server log.',
          remediation: 'native-dep',
        },
        503,
      );
    }
    const spec = targetRaw === 'sandbox'
      ? resolveSandboxSpec(sessionId, deps)
      : resolveHostSpec(sessionId, deps);
    if ('error' in spec) {
      return c.json(
        {
          ok: false,
          code: spec.status,
          error: spec.error,
          remediation: spec.status === 404 ? 'open-session' : spec.status === 409 ? 'provision' : null,
        },
        spec.status as 400 | 404 | 409 | 500,
      );
    }
    return c.json({ ok: true, target: targetRaw, label: spec.label });
  });
}

/**
 * Attach the terminal-WS upgrade listener to the HTTP server. Mirrors
 * the pattern used by `attachCompanyStreamUpgrade`: `noServer: true` so
 * we share the same `upgrade` event with other listeners.
 */
export function attachTerminalUpgrade(server: HttpServer, deps: TerminalUpgradeDeps): void {
  const wss = new wsModule.WebSocketServer({ noServer: true });
  server.on('upgrade', async (req, socket, head) => {
    const ctx = parseUpgradeRequest(req);
    if (!ctx) return;
    if (!isOriginAllowed(req)) {
      writeUpgradeFailure(socket, 403, 'origin not allowed');
      return;
    }
    if (ctx.target === 'host' && process.env.MCP_HOST_TERMINAL_ENABLED !== '1') {
      writeUpgradeFailure(
        socket,
        403,
        'host terminal disabled (set MCP_HOST_TERMINAL_ENABLED=1)',
      );
      return;
    }
    const pty = tryLoadPty();
    if (!pty) {
      writeUpgradeFailure(socket, 503, 'node-pty unavailable on this platform');
      return;
    }
    try {
      await deps.sessionStore.ensureCatalog();
    } catch {
      writeUpgradeFailure(socket, 503, 'filesystem session catalog unavailable');
      return;
    }

    // Resolve the spawn shape BEFORE upgrading so a misconfigured
    // session fails fast with a meaningful HTTP error instead of a
    // mid-WebSocket close code.
    let spec: SpawnSpec | { error: string; status: number };
    if (ctx.target === 'sandbox') {
      spec = resolveSandboxSpec(ctx.sessionId, deps);
    } else {
      spec = resolveHostSpec(ctx.sessionId, deps);
    }
    if ('error' in spec) {
      writeUpgradeFailure(socket, spec.status, spec.error);
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, ctx, pty, spec as SpawnSpec);
    });
  });
}

// ─── Spawn specifications ───────────────────────────────────────

interface SpawnSpec {
  file: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  label: string;
}

function resolveSandboxSpec(
  sessionId: CompanySessionId,
  deps: TerminalUpgradeDeps,
): SpawnSpec | { error: string; status: number } {
  const orchestrator = getCompanyOrchestrator(sessionId);
  if (!orchestrator) {
    return { error: `session ${sessionId} has no live orchestrator (open it in the dashboard first)`, status: 404 };
  }
  // The worker proxy makes every method asynchronous, and a full
  // SandboxBinding contains a driver that cannot cross MessagePort. Read the
  // write-through persisted sandbox row instead; it is the restart-safe source
  // of the exact container id and works for child sessions via their root.
  const session = resolveCompanySession(sessionId, deps);
  if (!session) {
    return { error: `session ${sessionId} does not exist in the filesystem catalog`, status: 404 };
  }
  const sandboxSessionId = session.rootId;
  const sandbox = deps.companySandboxStore.get(sandboxSessionId);
  if (!sandbox) {
    return { error: `session ${sessionId} has no sandbox binding`, status: 409 };
  }
  if (!sandbox.container_id || sandbox.status !== 'running') {
    return { error: `session ${sessionId} sandbox is not running`, status: 409 };
  }
  // `podman exec -it <id> /bin/bash` — `-it` allocates a TTY inside the
  // exec, and node-pty wraps the outer process in another TTY so the
  // shell believes it's interactive at every layer.
  return {
    file: 'podman',
    args: ['exec', '-it', sandbox.container_id, '/bin/bash'],
    label: `sandbox(s=${sessionId},c=${sandbox.container_id.slice(0, 12)})`,
  };
}

function resolveHostSpec(
  sessionId: CompanySessionId,
  deps: TerminalUpgradeDeps,
): SpawnSpec | { error: string; status: number } {
  // Prefer the operator-configured project root; fall back to the
  // session's first project. Both come from session.json, not
  // orchestrator — the host terminal must work even when the
  // orchestrator is dormant (no sandbox provisioned).
  const company = resolveCompanySession(sessionId, deps);
  if (!company) {
    return { error: `session ${sessionId} does not exist in the filesystem catalog`, status: 404 };
  }
  const projects = company.root.project_ids.map((projectId) => ({
    project_id: projectId,
    label: company.root.project_labels[String(projectId)] ?? null,
  }));
  if (projects.length === 0) {
    return { error: `session ${sessionId} has no project — host terminal needs a working directory`, status: 409 };
  }
  const primary = projects.find((p) => !p.label) ?? projects[0];
  const project = deps.db.getProject(primary.project_id);
  if (!project?.root_path) {
    return { error: `session ${sessionId} project has no root path on disk`, status: 409 };
  }
  const isWindows = process.platform === 'win32';
  const fileFromEnv = process.env.MCP_HOST_SHELL;
  const file = fileFromEnv || (isWindows ? 'pwsh.exe' : '/bin/bash');
  // PowerShell-specific: `-NoLogo` keeps the banner out; we don't pass
  // `-NoProfile` so the operator's prompt customisations still load.
  const args = isWindows && /pwsh|powershell/i.test(file) ? ['-NoLogo'] : [];
  console.log(
    `[terminal-ws] host pty open session=${sessionId} cwd=${project.root_path} shell=${file}`,
  );
  return {
    file,
    args,
    cwd: project.root_path,
    env: process.env,
    label: `host(s=${sessionId})`,
  };
}

// ─── Origin allow-list ──────────────────────────────────────────

function isOriginAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) {
    // No Origin header → probably curl or another non-browser client.
    // Allow only when bound to loopback (which we are by default) but
    // log so the operator notices unexpected traffic.
    return true;
  }
  try {
    const u = new URL(origin);
    const base = `${u.protocol}//${u.hostname}`;
    if (DEFAULT_ORIGINS.has(base)) return true;
    const extras = (process.env.MCP_TERMINAL_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return extras.includes(base) || extras.includes(origin);
  } catch {
    return false;
  }
}

// ─── Per-connection plumbing ────────────────────────────────────

interface TerminalCtx {
  sessionId: CompanySessionId;
  target: 'sandbox' | 'host';
  cols: number;
  rows: number;
}

/** Active legacy WebSocket PTYs, drained by the process shutdown coordinator. */
const activeTerminalCleanups = new Set<() => void>();

export function closeTerminalWebSocketProcesses(): void {
  for (const cleanup of [...activeTerminalCleanups]) cleanup();
}

function parseUpgradeRequest(req: IncomingMessage): TerminalCtx | null {
  if (req.method !== 'GET') return null;
  const url = req.url ?? '';
  const m = PATH_RE.exec(url);
  if (!m) return null;
  let sessionId: CompanySessionId;
  try {
    sessionId = asCompanySessionId(m[1]!);
  } catch {
    return null;
  }
  const params = m[2] ? new URLSearchParams(m[2]) : new URLSearchParams();
  const rawTarget = params.get('target') ?? 'sandbox';
  if (rawTarget !== 'sandbox' && rawTarget !== 'host') return null;
  const cols = clampDim(params.get('cols'), 80);
  const rows = clampDim(params.get('rows'), 24);
  return { sessionId, target: rawTarget, cols, rows };
}

function resolveCompanySession(
  sessionId: CompanySessionId,
  deps: TerminalUpgradeDeps,
): {
  rootId: CompanySessionId;
  root: ReturnType<CompanySessionFiles['getSession']>;
} | null {
  try {
    const requestedFiles = new CompanySessionFiles({
      companySessionId: sessionId,
      sessionStore: deps.sessionStore,
    });
    const requested = requestedFiles.getSession();
    const rootId = requested.parent_session_id ?? sessionId;
    const rootFiles = rootId === sessionId
      ? requestedFiles
      : new CompanySessionFiles({
          companySessionId: rootId,
          sessionStore: deps.sessionStore,
        });
    return { rootId, root: rootFiles.getSession() };
  } catch {
    return null;
  }
}

function clampDim(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(500, n);
}

function writeUpgradeFailure(socket: Duplex, status: number, reason: string): void {
  try {
    const body = JSON.stringify({ error: reason });
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\n` +
        'Content-Type: application/json\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        'Connection: close\r\n' +
        '\r\n' +
        body,
    );
    socket.destroy();
  } catch {
    /* socket already closed */
  }
}

function handleConnection(
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
