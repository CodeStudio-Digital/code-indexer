import { beforeEach, expect, it, vi } from 'vitest';
import { NativeDatabasePort } from '../workers/native-database-port.js';
import { HostEffectScope } from '@mcp/code-agent/runtime/host-effect-scope.js';
import { assertDatabaseDispatch } from '@mcp/db-drivers/dispatch.js';
import type { DbConnection } from '@mcp/store/db-client-store-types.js';
import type { DatabaseDriver } from '@mcp/db-drivers/types.js';

const row = { id: 1, project_id: 7, label: 'fixture', engine: 'sqlite', file_path: ':memory:',
  options_json: '{}', is_read_only: 0, updated_at: 'version' } as DbConnection;
const invocation = () => ({ signal: new AbortController().signal, assertDispatch: vi.fn() });
function fixture() {
  const signal = new AbortController(), effects = new HostEffectScope();
  let current = { ...row };
  const driver = { kind: 'relational', runQuery: vi.fn(async (): Promise<unknown> => ({ rows: [], fields: [], rowCount: 0 })),
    listTables: vi.fn(async () => []), close: vi.fn(async () => undefined) };
  const createDriver = vi.fn(async () => driver as unknown as DatabaseDriver);
  const store = { listConnections: (id: number) => id === 7 ? [current] : [] };
  const port = new NativeDatabasePort({ projectId: 7, store, signal: signal.signal, assertOwner: () => {},
    decrypt: async () => '', effects, outcomeUnknown: vi.fn(), createDriver });
  return { port, driver, createDriver, effects, signal, change: (patch: Partial<DbConnection>) => { current = { ...current, ...patch }; } };
}
beforeEach(() => vi.clearAllMocks());
it('single-flights private connections and rejects changed or cross-project targets', async () => {
  const f = fixture();
  try {
    await Promise.all([f.port.acquire(row, invocation()), f.port.acquire(row, invocation())]);
    expect(f.createDriver).toHaveBeenCalledTimes(1);
    expect(() => f.port.listConnections(8)).toThrow('another project');
    f.change({ is_read_only: 1 });
    await expect(f.port.acquire(row, invocation())).rejects.toThrow('changed after attempt admission');
    expect(f.createDriver).toHaveBeenCalledTimes(1);
  } finally { await f.port.close(); }
});
it('owns and closes a connection that arrives after cancellation instead of publishing it', async () => {
  const f = fixture(); let release!: (driver: DatabaseDriver) => void;
  f.createDriver.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = f.port.acquire(row, invocation()); const rejected = expect(pending).rejects.toThrow('scope closed');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const closing = f.port.close(); release(f.driver as unknown as DatabaseDriver);
  await rejected; await closing; await f.effects.waitForIdle();
  expect(f.driver.close).toHaveBeenCalledTimes(1);
});
it('retains the actual query lifetime after the caller cancels its wait', async () => {
  const f = fixture(); let release!: () => void;
  const acquired = await f.port.acquire(row, invocation());
  f.driver.runQuery.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ rows: [], fields: [], rowCount: 1 }); }));
  const pending = acquired.driver.runQuery('INSERT INTO items VALUES (1)');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  f.signal.abort(); expect(f.effects.activeCount).toBe(1);
  await expect(acquired.driver.runQuery('INSERT INTO items VALUES (2)')).rejects.toThrow();
  release(); await pending; await f.port.close(); await f.effects.waitForIdle();
  expect(f.driver.runQuery).toHaveBeenCalledTimes(1);
});
it('carries dispatch authority through asynchronous metadata calls', async () => {
  const f = fixture(), fence = invocation(); let valid = true;
  fence.assertDispatch.mockImplementation(() => { if (!valid) throw new Error('revoked'); });
  f.driver.listTables.mockImplementationOnce(async () => { await Promise.resolve(); valid = false; assertDatabaseDispatch({}); return []; });
  const acquired = await f.port.acquire(row, fence);
  try { await expect(acquired.driver.listTables()).rejects.toThrow('revoked'); }
  finally { await f.port.close(); }
});
it('never grants direct connection cleanup to a tool and fails closed on owner cleanup error', async () => {
  const f = fixture(), acquired = await f.port.acquire(row, invocation());
  await expect(acquired.driver.close()).rejects.toThrow('outside the admitted tool contract');
  f.driver.close.mockRejectedValueOnce(new Error('physical close failed'));
  await expect(f.port.close()).rejects.toThrow('cleanup is unconfirmed');
  await expect(f.port.close()).rejects.toThrow('cleanup is unconfirmed');
});
