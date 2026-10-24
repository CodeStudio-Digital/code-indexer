/**
 * Worker-thread watchdog for hangs that never return to the main event loop.
 *
 * The regular freeze watchdog is intentionally richer, but its timer cannot
 * fire while the Electron/main Node loop is blocked. This tiny worker receives
 * heartbeats plus handler lifecycle metadata and writes only when heartbeats
 * stop. It never receives request payloads or secrets.
 */
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { closeSync, fdatasyncSync, openSync, writeSync } = require('node:fs');
const { performance } = require('node:perf_hooks');

const handlers = new Map();
let lastHeartbeat = performance.now();
let lastReport = 0;
let closed = false;
let fd = null;
// Identify re-reports of one still-ongoing hang. Without this a single 12s
// stall lands as 1.6s + 6.6s + 11.6s and any consumer summing durationMs
// over-counts it ~2x. Cleared as soon as heartbeats resume.
let hangId = null;
let reportSeq = 0;

try {
  fd = openSync(workerData.outputPath, 'a', 0o600);
} catch (error) {
  parentPort.postMessage({ type: 'error', message: error && error.message ? error.message : String(error) });
}

function append(record) {
  if (fd == null) return;
  try {
    const buffer = Buffer.from(JSON.stringify(record) + '\n', 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
      const written = writeSync(fd, buffer, offset, buffer.length - offset, null);
      if (written <= 0) throw new Error('off-loop watchdog write made no progress');
      offset += written;
    }
    // This runs outside the measured loop. Make the rare hang record durable
    // immediately so a Task Manager kill right afterward still leaves it.
    fdatasyncSync(fd);
  } catch (error) {
    parentPort.postMessage({ type: 'error', message: error && error.message ? error.message : String(error) });
  }
}

function recentActivities() {
  return Array.from(handlers.values()).slice(-5).reverse();
}

const timer = setInterval(() => {
  const nowMono = performance.now();
  const lateMs = nowMono - lastHeartbeat;
  if (lateMs < workerData.thresholdMs) {
    lastReport = 0;
    hangId = null;
    reportSeq = 0;
    return;
  }
  if (lastReport && nowMono - lastReport < workerData.repeatMs) return;
  lastReport = nowMono;
  const suspects = recentActivities();
  const at = Date.now();
  if (!hangId) {
    hangId = 'h' + String(at - Math.round(lateMs)) + '-' + String(process.pid);
    reportSeq = 0;
  }
  reportSeq++;
  // Only name a handler whose WHOLE lifetime is comparable to the stall. One
  // that has been in flight far longer was already alive and awaiting before
  // the loop stopped, so blaming it manufactures a culprit — that is how a
  // streaming handler (api:files:archive stays in flight for the entire job)
  // became the standing suspect for every hang during its run. Mirrors the
  // duration guard in freeze-log.ts attributeStall().
  const tolerance = Math.max(workerData.pollMs, 250);
  let suspect = null;
  for (let i = 0; i < suspects.length; i++) {
    if (at - suspects[i].startedAt <= lateMs + tolerance) {
      suspect = suspects[i];
      break;
    }
  }
  append({
    type: 'freeze',
    at,
    event: {
      at,
      source: 'offloop',
      channel: suspect && suspect.channel,
      durationMs: Math.round(lateMs),
      wallLateMs: Math.round(lateMs),
      windowMs: Math.round(lateMs),
      detail: suspect
        ? suspect.kind === 'background'
          ? 'Worker watchdog: main heartbeat stopped; latest background activity persisted before the block'
          : 'Worker watchdog: main heartbeat stopped; latest in-flight handler persisted before the block'
        : suspects.length
          ? 'Worker watchdog: main heartbeat stopped; in-flight activity existed but all of it predates the stall, so no handler is named'
          : 'Worker watchdog: main heartbeat stopped; no in-flight handler or background activity was known',
      suspects,
      hangId,
      reportSeq,
      detectedBy: 'worker-thread',
    },
  });
}, workerData.pollMs);

parentPort.on('message', (message) => {
  if (!message || closed) return;
  if (message.type === 'heartbeat') {
    lastHeartbeat = performance.now();
    return;
  }
  if (message.type === 'enter') {
    handlers.set(message.id, {
      channel: message.channel,
      startedAt: message.at,
      kind: message.kind === 'background' ? 'background' : 'handler',
    });
    return;
  }
  if (message.type === 'exit') {
    handlers.delete(message.id);
    return;
  }
  if (message.type === 'stop') {
    closed = true;
    clearInterval(timer);
    if (fd != null) {
      try { fdatasyncSync(fd); } catch {}
      try { closeSync(fd); } catch {}
      fd = null;
    }
    parentPort.postMessage({ type: 'stopped' });
    parentPort.close();
  }
});
`;

interface OffloopWatchdogOptions {
  thresholdMs?: number;
  pollMs?: number;
  repeatMs?: number;
}

type OffloopActivityKind = 'handler' | 'background';

let watchdog: Worker | null = null;
let warned = false;

function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  console.warn(`[offloop-watchdog] ${message}`);
}

export function startOffloopWatchdog(runDir: string, options: OffloopWatchdogOptions = {}): void {
  if (watchdog) return;
  warned = false;
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      outputPath: join(runDir, 'offloop-watchdog.jsonl'),
      // The in-loop watchdog covers ordinary 200–1000ms stalls with richer
      // ELU attribution. This worker is the catastrophic-hang backstop.
      thresholdMs: Math.max(100, options.thresholdMs ?? 1_500),
      pollMs: Math.max(25, options.pollMs ?? 100),
      repeatMs: Math.max(250, options.repeatMs ?? 5_000),
    },
  });
  watchdog = worker;
  worker.on('message', (message: unknown) => {
    if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'error') {
      warnOnce(String((message as { message?: unknown }).message ?? 'worker write failed'));
    }
  });
  worker.on('error', (error) => warnOnce(error.message));
  worker.on('exit', (code) => {
    if (watchdog === worker) watchdog = null;
    if (code !== 0) warnOnce(`worker exited with code ${code}`);
  });
  worker.unref();
  heartbeatOffloopWatchdog();
}

function post(message: object): void {
  try { watchdog?.postMessage(message); } catch (error) {
    warnOnce(error instanceof Error ? error.message : String(error));
  }
}

export function heartbeatOffloopWatchdog(): void {
  post({ type: 'heartbeat' });
}

export function enterOffloopHandler(id: number, channel: string, at: number): void {
  enterOffloopActivity(id, channel, at, 'handler');
}

export function exitOffloopHandler(id: number): void {
  exitOffloopActivity(id);
}

/** Register non-request work so catastrophic hangs retain a useful suspect. */
export function enterOffloopActivity(
  id: number,
  label: string,
  at: number,
  kind: OffloopActivityKind = 'background',
): void {
  post({ type: 'enter', id, channel: label, at, kind });
}

export function exitOffloopActivity(id: number): void {
  post({ type: 'exit', id });
}

export function stopOffloopWatchdog(): Promise<void> {
  const worker = watchdog;
  watchdog = null;
  if (!worker) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      void worker.terminate().finally(finish);
    }, 1_000);
    timeout.unref?.();
    worker.once('message', (message: unknown) => {
      if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'stopped') finish();
    });
    worker.once('exit', finish);
    try { worker.postMessage({ type: 'stop' }); } catch { finish(); }
  });
}
