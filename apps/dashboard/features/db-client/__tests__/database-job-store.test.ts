import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DbJobStatus } from '@mcp/api-bus';
import { createDatabaseJobStore } from '../database-job-store.js';

const stores: ReturnType<typeof createDatabaseJobStore>[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const store of stores.splice(0)) store.dispose(); vi.useRealTimers(); });
function fixture() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const status: DbJobStatus = { version: 1, jobId: '', kind: 'import', state: 'running', effect: 'none', completed: 0, startedAt: 1, updatedAt: 1 };
  const api = { jobStatus: vi.fn(async () => ({ ...status })), cancelJob: vi.fn(async () => undefined) };
  const create = () => { const store = createDatabaseJobStore(api, storage); stores.push(store); return store; };
  return { api, status, create };
}
it('retries a pre-admission cancel and retains capacity until settlement', async () => {
  const { create, api, status } = fixture(), store = create();
  const jobs = Array.from({ length: 8 }, () => store.begin('p7/2', 'Import', 'import'));
  api.cancelJob.mockRejectedValue(new Error('not admitted yet'));
  store.cancel(jobs[0].id); jobs[0].finish(false);
  expect(() => store.begin('p7/2', 'Import', 'import')).toThrow(/capacity/);
  await vi.advanceTimersByTimeAsync(750);
  expect(api.cancelJob).toHaveBeenCalledTimes(2);
  status.state = 'cancelled';
  await vi.advanceTimersByTimeAsync(750);
  expect(store.snapshot()[0].state).toBe('cancelled');
  expect(() => store.begin('p7/2', 'Import', 'import')).not.toThrow();
});
it('recovers an interrupted import as unknown without replay', async () => {
  const { create, api, status } = fixture(), before = create();
  const job = before.begin('p7/2@analytics', 'Import', 'import');
  job.progress(3); before.dispose(); status.state = 'interrupted'; status.effect = 'unknown'; status.completed = 3;
  const recovered = create();
  await vi.advanceTimersByTimeAsync(750);
  expect(api.jobStatus).toHaveBeenCalledWith('p7/2@analytics', job.id);
  expect(recovered.snapshot()[0]).toMatchObject({ id: job.id, state: 'unknown', completed: 3 });
  expect(api.cancelJob).not.toHaveBeenCalled();
});
it('trusts a completed import receipt after transport loss but not an unclosed export file', async () => {
  const { create, status } = fixture(), store = create();
  store.begin('p7/2', 'Import', 'import').finish(false);
  store.begin('p7/2', 'Export', 'export').finish(false);
  status.state = 'completed'; status.effect = 'confirmed';
  await vi.advanceTimersByTimeAsync(750);
  expect(store.snapshot().map(job => job.state)).toEqual(['completed', 'unknown']);
});
it('does not revive a completed job when a late polling response arrives', async () => {
  const { create, api, status } = fixture(), store = create();
  let resolve!: (value: DbJobStatus) => void;
  api.jobStatus.mockImplementation(() => new Promise(done => { resolve = done; }));
  const job = store.begin('p7/2', 'Export', 'export');
  await vi.advanceTimersByTimeAsync(750);
  job.progress(10); job.finish(true); resolve(status);
  await vi.advanceTimersByTimeAsync(750);
  expect(store.snapshot()[0]).toMatchObject({ completed: 10, state: 'completed' });
});
it('settles as unknown when receipt polling never returns', async () => {
  const { create, api } = fixture(), store = create();
  api.jobStatus.mockImplementation(() => new Promise(() => undefined));
  store.begin('p7/2', 'Import', 'import').finish(false);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(store.snapshot()[0].state).toBe('unknown');
  expect(api.jobStatus).toHaveBeenCalledTimes(1);
});
