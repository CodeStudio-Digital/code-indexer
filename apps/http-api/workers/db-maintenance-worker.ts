/**
 * db-maintenance-worker — WAL checkpointing + retention OFF the Electron main
 * thread. It owns the CENTRAL index DB schedule and accepts fire-and-forget
 * PASSIVE checkpoints for per-project DB handles evicted by the main process.
 *
 * Why: the main-process CodeIndexDB handle used to own the periodic
 * `wal_checkpoint(PASSIVE)` timer. Under coder-worker write bursts that
 * checkpoint runs synchronously on the Electron main thread and freezes
 * every window. This worker opens its OWN connection (WAL,
 * `synchronous=NORMAL`, `busy_timeout=5000` — see `openWorkerDb`) and owns:
 *
 *   - `wal_checkpoint(PASSIVE)` every MCP_SQLITE_CHECKPOINT_MS (default 30s)
 * Session retention does not run here. Session events, metrics, baselines,
 * transcripts and tool output now live in filesystem bundles and are removed
 * only with their owning session.
 *
 * The main handle keeps `wal_autocheckpoint=0` + close-time TRUNCATE (see
 * CodeIndexDB `externalCheckpointer`). Kill switch MCP_DB_MAINTENANCE=0 in
 * deps.ts never spawns this file and restores the old main-thread timer.
 *
 * The retention core is exported as pure functions over a minimal
 * `MaintenanceDb` so tests run WITHOUT the native better-sqlite3 ABI: the
 * driver import is lazy, inside the `parentPort`-guarded runtime only.
 */
import { existsSync } from 'node:fs';
import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import { isAbsolute } from 'node:path';
import { MessageBridge, type MessageBridgeOpts } from '../../../packages/orchestrator-host/src/MessageBridge.js';
import { registerPerfStatsHandler } from './perf-stats.js';

// ─── Pure retention core (node-pure; no native driver) ──────────────────

export interface StatementLike {
  run(...args: unknown[]): { changes: number | bigint };
  get(...args: unknown[]): unknown;
}
export interface MaintenanceDb { prepare(sql: string): StatementLike }

export const DEFAULT_RETENTION_DAYS = 90;
export const RETENTION_BATCH_SIZE = 5000;
/** Pause between full batches so the prune never starves other writers. */
export const RETENTION_BATCH_PAUSE_MS = 25;

export function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]); // NaN-safe: garbage falls back
  return Number.isFinite(n) ? n : fallback;
}

/** UTC cutoffs `days` back from `nowMs`, for explicitly shared catalogs. */
export function retentionCutoffs(nowMs: number, days: number): { text: string; ms: number } {
  const ms = nowMs - days * 86_400_000;
  return { ms, text: new Date(ms).toISOString().slice(0, 19).replace('T', ' ') };
}

export function tableExists(db: MaintenanceDb, name: string): boolean {
  try {
    return !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
  } catch { return false; }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Drain one batched DELETE (`sql` must end with `LIMIT ?`): loop until a
 *  short batch, pausing between full ones. Returns total rows deleted. */
export async function drainDelete(
  db: MaintenanceDb, sql: string, params: unknown[],
  batchSize = RETENTION_BATCH_SIZE, pauseMs = RETENTION_BATCH_PAUSE_MS,
): Promise<number> {
  const stmt = db.prepare(sql);
  let total = 0;
  for (;;) {
    const changes = Number(stmt.run(...params, batchSize).changes);
    total += changes;
    if (changes < batchSize) return total;
    if (pauseMs > 0) await sleep(pauseMs);
  }
}

interface RetentionPass {
  name: string;
  /** ALL must exist — a per-project trimmed DB opened by mistake must not explode. */
  requires: string[];
  cutoff: 'text' | 'ms' | 'none';
  sql: string;
}

/**
 * Intentionally empty after the filesystem cutover. Any future central
 * retention pass must target an explicitly shared, non-session catalog.
 */
const RETENTION_PASSES: RetentionPass[] = [
];

export interface RetentionResult { counts: Record<string, number>; skipped: string[] }

export async function runRetention(
  db: MaintenanceDb,
  opts: { retentionDays: number; nowMs?: number; batchSize?: number; pauseMs?: number },
): Promise<RetentionResult> {
  const counts: Record<string, number> = {};
  const skipped: string[] = [];
  if (opts.retentionDays <= 0) return { counts, skipped };
  const cut = retentionCutoffs(opts.nowMs ?? Date.now(), opts.retentionDays);
  for (const pass of RETENTION_PASSES) {
    if (!pass.requires.every((table) => tableExists(db, table))) { skipped.push(pass.name); continue; }
    const params = pass.cutoff === 'text' ? [cut.text] : pass.cutoff === 'ms' ? [cut.ms] : [];
    counts[pass.name] = await drainDelete(db, pass.sql, params, opts.batchSize, opts.pauseMs);
  }
  return { counts, skipped };
}

// ─── Worker runtime (worker_thread only) ─────────────────────────────────

async function bootWorker(port: MessagePort, dbPath: string): Promise<void> {
  // Lazy: keeps this module importable in node-pure tests (no native ABI).
  const { DbConnection, openWorkerDb } = await import('../../../packages/orchestrator-host/src/DbConnection.js');
  const conn = openWorkerDb({ dbPath });
  const db = conn.handle;

  const bridge = new MessageBridge({
    port: port as unknown as MessageBridgeOpts['port'],
    onListenerError: (error, context) =>
      console.warn(`[db-maintenance-worker] listener error in ${context}:`, error),
  });
  registerPerfStatsHandler(bridge);

  bridge.handle('semantic.recover-mutation-fences', async (payload: unknown) => {
    const input = payload as { prefixes?: unknown; currentOwner?: unknown };
    if (!Array.isArray(input?.prefixes)
      || input.prefixes.some((prefix) => typeof prefix !== 'string' || prefix.length > 128)
      || typeof input.currentOwner !== 'string'
      || input.currentOwner.length === 0
      || input.currentOwner.length > 256) {
      throw new Error('semantic.recover-mutation-fences requires valid prefixes and currentOwner');
    }
    const { SemanticStore } = await import('../../../packages/store/src/semantic-store.js');
    const store = new SemanticStore(db);
    let recovered = 0;
    for (const prefix of input.prefixes as string[]) {
      recovered += store.recoverNamespaceMutationFences(prefix, input.currentOwner);
      // Let checkpoint/retention messages run between independent namespaces.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return { recovered };
  });

  bridge.handle('checkpoint.project', async (payload: unknown) => {
    const projectDbPath =
      payload && typeof payload === 'object' && 'dbPath' in payload
        ? (payload as { dbPath?: unknown }).dbPath
        : undefined;
    if (typeof projectDbPath !== 'string' || !isAbsolute(projectDbPath)) {
      throw new Error('checkpoint.project requires an absolute dbPath');
    }
    if (!existsSync(projectDbPath)) return { ok: true, skipped: 'missing' };
    const started = Date.now();
    const projectConn = new DbConnection({ dbPath: projectDbPath, busyTimeoutMs: 0 });
    try {
      projectConn.handle.pragma('wal_checkpoint(PASSIVE)');
      const tookMs = Date.now() - started;
      if (tookMs > 100) {
        console.warn(
          `[db-maintenance-worker] project wal_checkpoint(PASSIVE) took ${tookMs}ms: ${projectDbPath}`,
        );
      }
      return { ok: true, tookMs };
    } finally {
      projectConn.close();
    }
  });

  const timers: Array<ReturnType<typeof setInterval>> = [];
  const schedule = (timer: ReturnType<typeof setInterval>): void => {
    (timer as { unref?: () => void }).unref?.();
    timers.push(timer);
  };

  const checkpointMs = envInt('MCP_SQLITE_CHECKPOINT_MS', 30_000);
  if (checkpointMs > 0) {
    schedule(setInterval(() => {
      const started = Date.now();
      try { db.pragma('wal_checkpoint(PASSIVE)'); } catch { /* busy/closing — next tick retries */ }
      const took = Date.now() - started;
      if (took > 100) console.warn(`[db-maintenance-worker] wal_checkpoint(PASSIVE) took ${took}ms`);
    }, checkpointMs));
  }

  const pruning = new AbortController();
  let pruningPass: Promise<void> | undefined;
  let nextPrune: ReturnType<typeof setTimeout>;
  const schedulePrune = (ms: number): void => {
    nextPrune = setTimeout(() => {
      let nextMs = 24 * 60 * 60 * 1000;
      pruningPass = import('../../../packages/store/src/semantic-build-retention.js')
        .then(({ pruneDuplicateSemanticBuilds }) => pruneDuplicateSemanticBuilds(db, pruning.signal))
        .then(count => { if (count) console.info(`[db-maintenance] removed ${count} duplicate semantic build attempts`); })
        .catch((err: unknown) => {
          nextMs = 60_000;
          console.warn('[db-maintenance] semantic build retention will retry:', err);
        }).finally(() => { if (!pruning.signal.aborted) schedulePrune(nextMs); });
    }, ms);
    nextPrune.unref();
  };
  schedulePrune(10_000);

  bridge.handle('stop', async () => {
    pruning.abort();
    clearTimeout(nextPrune);
    await pruningPass;
    for (const timer of timers) clearInterval(timer);
    conn.close();
    setImmediate(() => process.exit(0));
    return { ok: true };
  });
  bridge.emit('worker.ready', {});
}

if (parentPort) {
  const { dbPath } = workerData as { dbPath: string };
  void bootWorker(parentPort, dbPath).catch((error) => {
    console.error('[db-maintenance-worker] boot failed:', error);
    process.exit(1);
  });
}
