import { Worker } from 'node:worker_threads';

interface Deferred<T> {
  resolve: (v: T) => void;
  reject: (e: Error) => void;
}

interface Slot {
  idx: number;
  worker: Worker;
  ready: boolean;
  inflight: Set<number>;
}

export interface PoolOptions {
  workerUrl: URL;
  size: number;
  workerData?: unknown;
}

export interface Pool<Req, Res> {
  dispatch(req: Req): Promise<Res>;
  size(): number;
  drain(): Promise<void>;
  close(): Promise<void>;
}

type Inbound =
  | { kind: 'ready' }
  | { reqId: number; ok: true; result: unknown }
  | { reqId: number; ok: false; error: { message: string; code?: string } };

export function createPool<Req, Res>(opts: PoolOptions): Pool<Req, Res> {
  const slots: Slot[] = [];
  const pending = new Map<number, { def: Deferred<Res>; slot: Slot }>();
  const waiters: Array<() => void> = [];
  let nextId = 1;
  let closed = false;

  const notifyWaiters = (): void => {
    while (waiters.length > 0) {
      const cb = waiters.shift();
      if (cb) cb();
    }
  };

  const spawn = (idx: number): Slot => {
    const w = new Worker(opts.workerUrl, { workerData: opts.workerData });
    const slot: Slot = { idx, worker: w, ready: false, inflight: new Set() };
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
        if (msg.ok) entry.def.resolve(msg.result as Res);
        else entry.def.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      }
    });
    w.on('error', (err) => {
      for (const reqId of slot.inflight) {
        const entry = pending.get(reqId);
        if (!entry) continue;
        pending.delete(reqId);
        entry.def.reject(err);
      }
      slot.inflight.clear();
      slot.ready = false;
    });
    w.on('exit', (code) => {
      for (const reqId of slot.inflight) {
        const entry = pending.get(reqId);
        if (!entry) continue;
        pending.delete(reqId);
        entry.def.reject(new Error(`worker exited with code ${code}`));
      }
      slot.inflight.clear();
      slot.ready = false;
      if (!closed) {
        slots[idx] = spawn(idx);
      }
    });
    return slot;
  };

  for (let i = 0; i < opts.size; i++) slots.push(spawn(i));

  const pickSlot = async (): Promise<Slot> => {
    while (true) {
      if (closed) throw new Error('pool is closed');
      let best: Slot | null = null;
      for (const s of slots) {
        if (!s.ready) continue;
        if (!best || s.inflight.size < best.inflight.size) best = s;
      }
      if (best) return best;
      await new Promise<void>((r) => waiters.push(r));
    }
  };

  return {
    async dispatch(req: Req): Promise<Res> {
      if (closed) throw new Error('pool is closed');
      const slot = await pickSlot();
      const reqId = nextId++;
      slot.inflight.add(reqId);
      return new Promise<Res>((resolve, reject) => {
        pending.set(reqId, { def: { resolve, reject }, slot });
        slot.worker.postMessage({ reqId, body: req });
      });
    },
    size() { return slots.length; },
    async drain() {
      while (pending.size > 0) {
        await new Promise<void>((r) => setImmediate(r));
      }
    },
    async close() {
      closed = true;
      while (pending.size > 0) {
        await new Promise<void>((r) => setImmediate(r));
      }
      notifyWaiters();
      await Promise.all(slots.map((s) => s.worker.terminate()));
    },
  };
}

export function resolveWorkerUrl(metaUrl: string, basename: string): URL {
  const isTs = metaUrl.endsWith('.ts');
  return new URL(`${basename}${isTs ? '.ts' : '.js'}`, metaUrl);
}
