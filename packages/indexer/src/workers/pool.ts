/**
 * Generic worker_threads pool with lazy spawn, idle shutdown, crash backoff
 * and event-loop hygiene.
 *
 * Lifecycle:
 *  - Workers spawn on the FIRST dispatch (not at pool creation) and are
 *    terminated after `idleTtlMs` with no outstanding work — the pool object
 *    stays usable and respawns lazily on the next dispatch.
 *  - Unexpected exits respawn with exponential backoff (see respawn-policy);
 *    too many consecutive crashes flip the pool to degraded: queued and
 *    future dispatches reject with `code: 'POOL_DEGRADED'` (recovery =
 *    close() + recreate).
 *  - Workers are ref'd only while work is outstanding, so an idle pool never
 *    keeps the process alive (a CLI exits even without an explicit close()).
 *  - `maxQueue` caps outstanding dispatches (`code: 'POOL_QUEUE_FULL'`) as a
 *    safety belt — the primary limit is the caller's own concurrency bound.
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { createRespawnPolicy, type RespawnPolicyOptions } from './respawn-policy.js';
import { createIdleShutdown } from './pool-idle.js';

interface Deferred<T> { resolve: (v: T) => void; reject: (e: Error) => void }

interface Slot {
  idx: number;
  worker: Worker;
  ready: boolean;
  inflight: Set<number>;
  /** Terminate initiated by close()/idle shutdown — exit handler must not respawn. */
  expected: boolean;
  refed: boolean;
}

export interface PoolOptions {
  workerUrl: URL;
  size: number;
  workerData?: unknown;
  /** Label for logs, e.g. "indexJob". */
  name?: string;
  /** Terminate idle workers after this long with no outstanding work. 0 = never. */
  idleTtlMs?: number;
  /** Cap on outstanding dispatches (queued + in flight). Default 1024. */
  maxQueue?: number;
  respawn?: RespawnPolicyOptions;
}

export interface Pool<Req, Res> {
  dispatch(req: Req): Promise<Res>;
  /** Number of live (spawned) workers — 0 when idle-shutdown ran. */
  size(): number;
  drain(): Promise<void>;
  close(): Promise<void>;
}

type Inbound =
  | { kind: 'ready' }
  | { reqId: number; ok: true; result: unknown }
  | { reqId: number; ok: false; error: { message: string; code?: string } };

export function createPool<Req, Res>(opts: PoolOptions): Pool<Req, Res> {
  const label = opts.name ? ` ${opts.name}` : '';
  const idleTtlMs = opts.idleTtlMs ?? 0;
  const maxQueue = opts.maxQueue ?? 1024;
  const policy = createRespawnPolicy(opts.respawn);

  const slots: Array<Slot | null> = new Array(opts.size).fill(null);
  const pending = new Map<number, { def: Deferred<Res>; slot: Slot }>();
  const waiters: Array<() => void> = [];
  const emptyWaiters: Array<() => void> = [];
  const respawnTimers = new Set<ReturnType<typeof setTimeout>>();
  let waiting = 0;          // dispatches not yet handed to a worker
  let nextId = 1;
  let closed = false;
  let degradedCause: string | null = null;

  const idle = createIdleShutdown({
    idleTtlMs,
    label,
    isQuiescent: () => !closed && !policy.isDegraded() && pending.size === 0 && waiting === 0,
    hasWorkers: () => slots.some(Boolean),
    teardown: () => {
      let n = 0;
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        if (!s) continue;
        s.expected = true;
        void s.worker.terminate();
        slots[i] = null;
        n++;
      }
      return n;
    },
  });

  const degradedError = (): Error => Object.assign(
    new Error(`worker pool${label} degraded after ${policy.consecutiveFailures()} consecutive crashes${degradedCause ? `: ${degradedCause}` : ''}`),
    { code: 'POOL_DEGRADED' },
  );

  const notifyWaiters = (): void => {
    while (waiters.length > 0) waiters.shift()!();
  };

  const updateRefs = (): void => {
    const hasWork = pending.size > 0 || waiting > 0;
    for (const s of slots) {
      if (!s) continue;
      if (hasWork && !s.refed) { s.worker.ref(); s.refed = true; }
      else if (!hasWork && s.refed) { s.worker.unref(); s.refed = false; }
    }
  };

  /** Outstanding work shrank — settle drain()ers, maybe arm the idle timer. */
  const afterPendingShrunk = (): void => {
    if (pending.size === 0 && waiting === 0) {
      while (emptyWaiters.length > 0) emptyWaiters.shift()!();
      idle.maybeArm();
    }
    updateRefs();
  };

  const rejectInflight = (slot: Slot, err: Error): void => {
    for (const reqId of slot.inflight) {
      const entry = pending.get(reqId);
      if (!entry) continue;
      pending.delete(reqId);
      entry.def.reject(err);
    }
    slot.inflight.clear();
  };

  const spawn = (idx: number): Slot => {
    const w = new Worker(opts.workerUrl, { workerData: opts.workerData });
    const slot: Slot = { idx, worker: w, ready: false, inflight: new Set(), expected: false, refed: true };
    w.on('message', (msg: Inbound) => {
      if ('kind' in msg && msg.kind === 'ready') {
        slot.ready = true;
        notifyWaiters();
        return;
      }
      if ('reqId' in msg) {
        const entry = pending.get(msg.reqId);
        if (!entry) return;
        pending.delete(msg.reqId);
        slot.inflight.delete(msg.reqId);
        policy.onHealthy();
        if (msg.ok) entry.def.resolve(msg.result as Res);
        else entry.def.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
        afterPendingShrunk();
      }
    });
    w.on('error', (err) => {
      slot.ready = false;
      degradedCause = err.message;
      rejectInflight(slot, err);
      afterPendingShrunk();
    });
    w.on('exit', (code) => {
      slot.ready = false;
      rejectInflight(slot, new Error(`worker exited with code ${code}`));
      slots[idx] = null;
      afterPendingShrunk();
      if (closed || slot.expected) return;
      const decision = policy.onCrash();
      if (decision.kind === 'degraded') {
        console.error(`[pool${label}] degraded after ${policy.consecutiveFailures()} consecutive crashes — dispatches will reject`);
        notifyWaiters(); // queued dispatches wake up and see the degraded state
        return;
      }
      const t = setTimeout(() => {
        respawnTimers.delete(t);
        if (closed || policy.isDegraded()) return;
        // Respawn only under demand; otherwise stay lazy (next dispatch spawns).
        if ((pending.size > 0 || waiting > 0) && !slots[idx]) slots[idx] = spawn(idx);
      }, decision.delayMs);
      t.unref?.();
      respawnTimers.add(t);
    });
    return slot;
  };

  const ensureSlots = (): void => {
    if (closed || policy.isDegraded()) return;
    for (let i = 0; i < opts.size; i++) {
      if (!slots[i]) slots[i] = spawn(i);
    }
    updateRefs();
  };

  const pickSlot = async (): Promise<Slot> => {
    for (;;) {
      if (closed) throw new Error('pool is closed');
      if (policy.isDegraded()) throw degradedError();
      ensureSlots();
      let best: Slot | null = null;
      for (const s of slots) {
        if (!s?.ready) continue;
        if (!best || s.inflight.size < best.inflight.size) best = s;
      }
      if (best) return best;
      await new Promise<void>((r) => waiters.push(r));
    }
  };

  return {
    async dispatch(req: Req): Promise<Res> {
      if (closed) throw new Error('pool is closed');
      if (policy.isDegraded()) throw degradedError();
      if (pending.size + waiting >= maxQueue) {
        throw Object.assign(new Error(`worker pool${label} queue full (${maxQueue} outstanding)`), { code: 'POOL_QUEUE_FULL' });
      }
      idle.touch();
      waiting++;
      updateRefs();
      let queued = true;
      const dequeue = (): void => {
        if (!queued) return;
        queued = false;
        waiting--;
        afterPendingShrunk();
      };
      try {
        const slot = await pickSlot();
        const reqId = nextId++;
        slot.inflight.add(reqId);
        return await new Promise<Res>((resolve, reject) => {
          pending.set(reqId, { def: { resolve, reject }, slot });
          slot.worker.postMessage({ reqId, body: req });
          dequeue(); // handed off — counted in `pending` from here on
        });
      } catch (err) {
        dequeue();
        throw err;
      }
    },

    size(): number {
      return slots.reduce((n, s) => n + (s ? 1 : 0), 0);
    },

    async drain(): Promise<void> {
      if (pending.size === 0 && waiting === 0) return;
      await new Promise<void>((r) => emptyWaiters.push(r));
    },

    async close(): Promise<void> {
      closed = true;
      idle.stop();
      for (const t of respawnTimers) clearTimeout(t);
      respawnTimers.clear();
      notifyWaiters(); // queued dispatches wake and reject with 'pool is closed'
      if (pending.size > 0 || waiting > 0) {
        await new Promise<void>((r) => emptyWaiters.push(r));
      }
      await Promise.all(slots.map((s) => {
        if (!s) return Promise.resolve(0);
        s.expected = true;
        return s.worker.terminate();
      }));
      slots.fill(null);
    },
  };
}

export interface WorkerSpec {
  url: URL;
  /** Present in dev (tsx): merge into `workerData` so the bootstrap can hand off. */
  bootstrapData?: { tsEntry: string };
}

/**
 * Resolve the worker entry for both runtimes. Compiled (`.js` caller) →
 * sibling `.js` worker. Source (`.ts` caller, i.e. tsx dev) → the
 * `_dev-bootstrap.mjs` next to this module, which registers tsx inside the
 * worker thread and imports the real `.ts` entry (tsx's `tsx/esm` shorthand
 * refuses to register off the main thread — see the bootstrap header).
 */
export function resolveWorkerSpec(metaUrl: string, basename: string): WorkerSpec {
  // tsx may append a cache-busting query/hash to import.meta.url inside a
  // nested worker. Inspect the URL pathname rather than the raw string or a
  // source `client.ts?...` is mistaken for compiled JS.
  const sourceUrl = new URL(metaUrl);
  if (sourceUrl.pathname.endsWith('.ts')) {
    return {
      url: new URL('./_dev-bootstrap.mjs', import.meta.url),
      bootstrapData: { tsEntry: fileURLToPath(new URL(`${basename}.ts`, sourceUrl)) },
    };
  }
  return { url: new URL(`${basename}.js`, sourceUrl) };
}
