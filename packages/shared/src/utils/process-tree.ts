/**
 * Best-effort cross-platform process-tree termination.
 *
 * Killing only the direct shell/process is not enough for IDE workloads:
 * package-manager scripts commonly leave Vite, esbuild, language runtimes, or
 * WinPTY helpers behind.  Keep this helper outside Electron so the desktop app,
 * standalone HTTP server, terminals, and host-process sandboxes all use the
 * same semantics.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

export type ProcessTreeSignal = 'SIGTERM' | 'SIGKILL';

const trackedProcessTrees = new Set<number>();

// `taskkill` occasionally stalls inside Windows process enumeration. Running
// several copies at once amplifies the contention system-wide (including the
// Electron browser thread), so tree cleanup is deliberately serialized.
const WINDOWS_KILL_CONCURRENCY = 1;
const WINDOWS_KILL_TIMEOUT_MS = 3_000;
const WINDOWS_KILL_CIRCUIT_MS = 30_000;

interface WindowsKillRequest {
  pid: number;
  signal: ProcessTreeSignal;
  resolve: () => void;
}

const windowsKillQueue: WindowsKillRequest[] = [];
const pendingWindowsKills = new Map<number, Promise<void>>();
let activeWindowsKills = 0;
let windowsKillCircuitOpenUntil = 0;

function skipQueuedWindowsKills(): void {
  let request: WindowsKillRequest | undefined;
  while ((request = windowsKillQueue.shift())) {
    pendingWindowsKills.delete(request.pid);
    request.resolve();
  }
}

function finishWindowsKill(request: WindowsKillRequest): void {
  pendingWindowsKills.delete(request.pid);
  activeWindowsKills = Math.max(0, activeWindowsKills - 1);
  request.resolve();
  pumpWindowsKillQueue();
}

function launchWindowsKill(request: WindowsKillRequest): void {
  const { pid, signal } = request;
  activeWindowsKills++;
  let child: ChildProcess;
  try {
    child = spawn(
      'taskkill',
      ['/PID', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])],
      { stdio: 'ignore', windowsHide: true },
    );
  } catch {
    finishWindowsKill(request);
    return;
  }

  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    finishWindowsKill(request);
  };

  child.once('error', finish);
  child.once('exit', finish);
  timeout = setTimeout(() => {
    // `taskkill` itself can be suspended indefinitely on Windows. Never let a
    // cleanup helper become a permanent process/handle leak. More importantly,
    // do not start additional helpers while Windows is already failing to reap
    // the first one: concurrent taskkill processes can starve Electron's native
    // browser thread even though Node's event loop remains technically idle.
    windowsKillCircuitOpenUntil = Date.now() + WINDOWS_KILL_CIRCUIT_MS;
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    finish();
  }, WINDOWS_KILL_TIMEOUT_MS);
  timeout.unref?.();
  child.unref();
}

function pumpWindowsKillQueue(): void {
  if (Date.now() < windowsKillCircuitOpenUntil) {
    skipQueuedWindowsKills();
    return;
  }
  while (activeWindowsKills < WINDOWS_KILL_CONCURRENCY) {
    const request = windowsKillQueue.shift();
    if (!request) return;
    launchWindowsKill(request);
  }
}

function enqueueWindowsKill(pid: number, signal: ProcessTreeSignal): Promise<void> {
  // Repeated abort/dispose paths often target the same child. One tree-kill is
  // sufficient and avoids a helper-process storm during shutdown.
  const existing = pendingWindowsKills.get(pid);
  if (existing) return existing;
  let resolve!: () => void;
  const completion = new Promise<void>((done) => { resolve = done; });
  pendingWindowsKills.set(pid, completion);
  windowsKillQueue.push({ pid, signal, resolve });
  pumpWindowsKillQueue();
  return completion;
}

/** Track a transient child so process-wide shutdown can reap it mid-operation. */
export function trackProcessTree(pid: number | undefined | null): () => void {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return () => undefined;
  trackedProcessTrees.add(pid);
  return () => trackedProcessTrees.delete(pid);
}

/**
 * Pids of every transient tree tracked in this realm.
 *
 * These are the children nobody else can enumerate: LSP servers, debug
 * adapters and the like register here for shutdown, but their own managers
 * hold handles rather than pids. The task manager reads this to keep such
 * processes visible (and adoptable as orphan roots) after their spawning
 * parent is gone.
 */
export function listTrackedProcessTrees(): number[] {
  return [...trackedProcessTrees];
}

/** Hard-stop and await all transient process trees in this JavaScript realm. */
export async function disposeTrackedProcessTrees(): Promise<void> {
  const snapshot = [...trackedProcessTrees];
  trackedProcessTrees.clear();
  if (process.platform === 'win32') {
    await Promise.all(snapshot.map((pid) => enqueueWindowsKill(pid, 'SIGKILL')));
    // Include tree-kills that process-specific registries started immediately
    // before this sweep. This keeps normal shutdown fully asynchronous while
    // still waiting for every queued helper to settle.
    await Promise.all([...pendingWindowsKills.values()]);
    return;
  }
  for (const pid of snapshot) killProcessTree(pid, 'SIGKILL');
}

/**
 * Last-resort synchronous tree kill for process `exit`, where the event loop
 * can no longer drain the asynchronous queue. All targets share one bounded
 * helper to avoid the process storm caused by one `taskkill` per child.
 */
export function killProcessTreesSync(pids: ReadonlyArray<number | undefined | null>): void {
  const snapshot = [...new Set(
    pids.filter((pid): pid is number => (
      typeof pid === 'number' && Number.isInteger(pid) && pid > 0
    )),
  )];
  if (snapshot.length === 0) return;
  if (process.platform === 'win32') {
    try {
      spawnSync(
        'taskkill',
        [...snapshot.flatMap((pid) => ['/PID', String(pid)]), '/T', '/F'],
        {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 500,
          killSignal: 'SIGKILL',
        },
      );
    } catch { /* taskkill unavailable or already gone */ }
    return;
  }
  for (const pid of snapshot) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
}

/**
 * Bounded synchronous emergency sweep for `process.on('exit')`, where promises
 * cannot settle. Windows supports multiple `/PID` arguments, so one helper
 * reaps the full snapshot and can block for at most 500 ms.
 */
export function disposeTrackedProcessTreesSync(): void {
  const snapshot = [...trackedProcessTrees];
  trackedProcessTrees.clear();
  killProcessTreesSync(snapshot);
}

export function killProcessTree(
  pid: number | undefined | null,
  signal: ProcessTreeSignal = 'SIGKILL',
): Promise<void> {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  try {
    if (process.platform === 'win32') {
      return enqueueWindowsKill(pid, signal);
    }

    // Children started as their own process-group leader are terminated as a
    // group. If the pid is not a group leader, fall back to the direct child.
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* taskkill unavailable / process already reaped */
  }
  return Promise.resolve();
}
