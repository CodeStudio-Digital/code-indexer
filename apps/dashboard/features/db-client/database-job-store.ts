import type { DbJobStatus } from '@mcp/api-bus';

export type DatabaseUiJob = {
  id: string; connectionId: string; label: string; kind: 'import' | 'export';
  completed: number; total?: number;
  state: 'running' | 'cancelling' | 'settling' | 'completed' | 'failed' | 'cancelled' | 'unknown';
};
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
const STORAGE_KEY = 'db-job-receipts-v1';
const active = (job: DatabaseUiJob) => ['running', 'cancelling', 'settling'].includes(job.state);
const receiptState = (status: DbJobStatus): DatabaseUiJob['state'] =>
  status.effect === 'unknown' || status.state === 'interrupted' ? 'unknown'
    : status.state === 'cancelled' ? 'cancelled' : status.state === 'completed' ? 'completed' : 'failed';

/** Stores only receipt identities/progress. Recovery observes; it never replays SQL. */
export function createDatabaseJobStore(api: {
  jobStatus(connectionId: string, jobId: string): Promise<DbJobStatus>;
  cancelJob(connectionId: string, jobId: string): Promise<unknown>;
}, storage?: Storage) {
  let jobs: DatabaseUiJob[] = [];
  let disposed = false;
  const listeners = new Set<() => void>();
  const controls = new Map<string, { controller: AbortController; timer: ReturnType<typeof setInterval> }>();
  const publish = () => {
    jobs = [...jobs];
    try { storage?.setItem(STORAGE_KEY, JSON.stringify(jobs)); } catch { /* Server receipts remain durable. */ }
    for (const listener of listeners) listener();
  };
  function observe(job: DatabaseUiJob, recovered: boolean) {
    const controller = new AbortController();
    if (job.state === 'cancelling') controller.abort();
    let polling = false, finished = false, failedAt = recovered ? Date.now() : undefined;
    const settle = (state: DatabaseUiJob['state']) => {
      finished = true; clearInterval(timer); controls.delete(job.id); job.state = state; publish();
    };
    const timer = setInterval(() => {
      if (finished || disposed) return;
      if (failedAt !== undefined && Date.now() - failedAt >= 120_000) { settle('unknown'); return; }
      if (polling) return;
      polling = true;
      void api.jobStatus(job.connectionId, job.id).then(status => {
        if (finished || disposed) return;
        job.completed = status.completed; job.total = status.total; publish();
        // Cancellation may precede admission. Retry the cancel, never the work.
        if (controller.signal.aborted && status.state === 'running') {
          void api.cancelJob(job.connectionId, job.id).catch(() => undefined);
        }
        if (failedAt !== undefined && status.state !== 'running') {
          const state = receiptState(status);
          // A producer's completed export does not prove the local file closed.
          // A completed import receipt does prove its commit outcome.
          settle(state === 'completed' && job.kind === 'export' ? 'unknown' : state);
        }
      }).catch(() => { /* Transport errors do not prove rollback. */ }).finally(() => { polling = false; });
    }, 750);
    controls.set(job.id, { controller, timer });
    return { id: job.id, signal: controller.signal,
      progress(completed: number) { if (!finished) { job.completed = completed; publish(); } },
      finish(success: boolean) {
        if (finished) return;
        if (success) settle('completed');
        else { failedAt ??= Date.now(); job.state = 'settling'; publish(); }
      },
    };
  }
  try {
    const stored: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '[]');
    if (Array.isArray(stored)) for (const entry of stored.slice(-32)) {
      if (!entry || typeof entry !== 'object'
        || !/^[a-f0-9-]{36}$/i.test(entry.id) || typeof entry.connectionId !== 'string'
        || !/^p[1-9]\d*\/[1-9]\d*(?:@[^\s]{1,512})?$/.test(entry.connectionId)
        || !['import', 'export'].includes(entry.kind) || typeof entry.label !== 'string'
        || !['running', 'cancelling', 'settling', 'completed', 'failed', 'cancelled', 'unknown'].includes(entry.state)
        || !Number.isFinite(entry.completed) || entry.completed < 0 || jobs.some(job => job.id === entry.id)) continue;
      const job: DatabaseUiJob = { id: entry.id, connectionId: entry.connectionId, kind: entry.kind,
        label: entry.label.slice(0, 200), state: entry.state, completed: entry.completed };
      jobs.push(job);
      if (active(job)) { job.state = job.state === 'cancelling' ? 'cancelling' : 'settling'; observe(job, true); }
    }
  } catch { /* Corrupt renderer metadata cannot replay an operation. */ }
  return {
    snapshot: () => jobs,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    begin(connectionId: string, label: string, kind: DatabaseUiJob['kind']) {
      if (jobs.filter(active).length >= 8) throw new Error('Database job capacity reached. Wait for an active job to finish.');
      const job: DatabaseUiJob = { id: crypto.randomUUID(), connectionId, label, kind, completed: 0, state: 'running' };
      jobs = [...jobs.filter(active), ...jobs.filter(job => !active(job)).slice(-23), job]; publish();
      return observe(job, false);
    },
    cancel(id: string) {
      const job = jobs.find(job => job.id === id), control = controls.get(id);
      if (!job || !control || job.state !== 'running') return;
      job.state = 'cancelling'; publish(); control.controller.abort();
      void api.cancelJob(job.connectionId, id).catch(() => undefined);
    },
    dispose() { disposed = true; for (const { timer } of controls.values()) clearInterval(timer); controls.clear(); listeners.clear(); },
  };
}
