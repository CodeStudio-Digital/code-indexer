/**
 * Resolve a preview-able dev-server URL for a project — REUSING a runner
 * that's already up instead of letting the agent spawn its own server in
 * the shell. Starts a tracked ("owned") runner only when none is running,
 * so the lifecycle layer can stop exactly what the preview created (and
 * never the user's own runner).
 *
 * Runs in the Electron main process; the worker reaches it through the
 * `previewDevtools` RPC → PreviewWindowService.open. Decoupled from the
 * runner/PtyManager via the injected `RunnerBridge` so it unit-tests with
 * a fake.
 */
import {
  extractDevUrl,
  isDevServerCommand,
  type DevOutputChunk,
} from '@mcp/shared';

export interface ResolverRunnerTask {
  taskId: string;
  terminalId: string;
  projectId: number;
  status: 'running' | 'exited' | 'stopped';
  command: string;
  label: string;
}

export interface RunnerBridge {
  list(): ResolverRunnerTask[] | Promise<ResolverRunnerTask[]>;
  start(input: { projectId: number; command: string; label: string; manager: string }): Promise<ResolverRunnerTask>;
  stop(taskId: string): Promise<void>;
  /** Detected dev command for the project, or null to fall back to `npm run dev`. */
  detectDevCommand(projectId: number): Promise<{ command: string; label: string; manager: string } | null>;
  /** Accumulated terminal scrollback for a runner's PTY ([] if gone). */
  readBuffer(terminalId: string): DevOutputChunk[];
  /** Pinned dev port from `projects.builder_json` (DS/builder projects), or null. */
  pinnedPort(projectId: number): number | null;
}

export interface ResolvedDevUrl {
  url: string;
  /** Set only when THIS call started the server — the lifecycle stops it. */
  ownedTaskId?: string;
}

export interface DetectedRunnerLite {
  id?: string;
  label: string;
  command: string;
  manager: string;
}

/** Pick the dev command from detection: a script literally named "dev" wins,
 *  else the first dev-server-ish command. Null when none looks runnable. */
export function pickDevRunner(
  groups: ReadonlyArray<{ runners: ReadonlyArray<DetectedRunnerLite> }>,
): { command: string; label: string; manager: string } | null {
  const all = groups.flatMap((g) => g.runners);
  const isDevNamed = (s: string): boolean => /(^|[:\s])dev($|[:\s])/i.test(s);
  const pick =
    all.find((r) => isDevNamed(r.label) || isDevNamed(r.id ?? '')) ??
    all.find((r) => isDevServerCommand(r.command, r.label));
  return pick ? { command: pick.command, label: pick.label, manager: pick.manager } : null;
}

const REUSE_POLL_MS = 10_000;
const BOOT_POLL_MS = 45_000;
const POLL_INTERVAL_MS = 400;

export interface ResolveDevUrlOptions {
  /** Override poll timeouts (tests). */
  reusePollMs?: number;
  bootPollMs?: number;
  pollIntervalMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll a terminal buffer until extractDevUrl yields a match (or timeout). */
async function pollForUrl(
  bridge: RunnerBridge,
  terminalId: string,
  timeoutMs: number,
  wantAuthoritative: boolean,
  intervalMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let provisional: string | null = null;
  for (;;) {
    const match = extractDevUrl(bridge.readBuffer(terminalId));
    if (match.url && (match.authoritative || !wantAuthoritative)) return match.url;
    if (match.url) provisional = match.url;
    if (Date.now() >= deadline) return provisional;
    await sleep(intervalMs);
  }
}

function localhost(port: number): string {
  return `http://localhost:${port}`;
}

export async function resolveDevUrl(
  bridge: RunnerBridge,
  projectId: number,
  opts: ResolveDevUrlOptions = {},
): Promise<ResolvedDevUrl> {
  const reusePollMs = opts.reusePollMs ?? REUSE_POLL_MS;
  const bootPollMs = opts.bootPollMs ?? BOOT_POLL_MS;
  const intervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const pinned = bridge.pinnedPort(projectId);
  const tasks = await bridge.list();
  const running = tasks.find(
    (t) => t.projectId === projectId && t.status === 'running' && isDevServerCommand(t.command, t.label),
  );

  // ── Reuse an already-running dev server (NEVER owned → never stopped). ──
  if (running) {
    if (pinned) return { url: localhost(pinned) };
    const url = await pollForUrl(bridge, running.terminalId, reusePollMs, false, intervalMs);
    if (url) return { url };
    throw new Error(
      'A dev server is running for this project but no URL was detected in its output. ' +
        'Pass an explicit `url` to preview_open (e.g. http://localhost:5173).',
    );
  }

  // ── Nothing running → start a tracked, owned dev server. ──
  const detected = await bridge.detectDevCommand(projectId);
  const cmd = detected ?? { command: 'npm run dev', label: 'dev', manager: 'npm' };
  const task = await bridge.start({ projectId, ...cmd });
  const ownedTaskId = task.taskId;

  // strictPort scaffolds bind exactly to the pinned port, so once the
  // server announces ANY ready URL we trust the pinned port. Prefer an
  // authoritative detected URL when it actually differs.
  const detectedUrl = await pollForUrl(bridge, task.terminalId, bootPollMs, !pinned, intervalMs);
  if (detectedUrl) return { url: pinned ? localhost(pinned) : detectedUrl, ownedTaskId };
  if (pinned) return { url: localhost(pinned), ownedTaskId };

  // Started but never printed a URL — don't leak the process.
  await bridge.stop(ownedTaskId).catch(() => undefined);
  throw new Error(
    'Started a dev server but it never printed a URL within 45s. ' +
      'Pass an explicit `url` to preview_open once it is up.',
  );
}
