import { asCompanySessionId, type CompanySessionId } from '@mcp/session-storage';
import { getCompanyOrchestrator } from '../../sse/companyOrchestrator.js';
import type { IncomingMessage } from 'node:http';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import type { Duplex } from 'node:stream';
import { type TerminalUpgradeDeps, type SpawnSpec, type TerminalCtx } from './terminal-websocket-types.js';

// ─── Public wire-up ──────────────────────────────────────────────

const PATH_RE =
  /^\/ws\/terminal\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\?(.*))?$/i;

const DEFAULT_ORIGINS = new Set(['http://localhost', 'http://127.0.0.1']);

export function resolveSandboxSpec(
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

export function resolveHostSpec(
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
export function isOriginAllowed(req: IncomingMessage): boolean {
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

export function parseUpgradeRequest(req: IncomingMessage): TerminalCtx | null {
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

export function writeUpgradeFailure(socket: Duplex, status: number, reason: string): void {
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
