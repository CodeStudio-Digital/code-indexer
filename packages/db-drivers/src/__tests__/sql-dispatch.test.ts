import { beforeEach, expect, it, vi } from 'vitest';
import { createPostgresDriver } from '../postgres.js';
import { createMysqlDriver } from '../mysql.js';

const fake = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), release: vi.fn(), destroy: vi.fn(), side: vi.fn() }));
vi.mock('pg', () => ({ default: { Pool: class {
  connect = fake.connect; query = fake.side; end = async () => {};
} } }));
vi.mock('mysql2/promise', () => ({ createPool: () => ({ getConnection: fake.connect, query: fake.side, end: async () => {} }) }));
beforeEach(() => {
  vi.resetAllMocks();
  fake.side.mockResolvedValue({});
  fake.connect.mockResolvedValue({ threadId: 42, query: fake.query, release: fake.release, destroy: fake.destroy });
});
const engines = [
  ['postgres', () => createPostgresDriver({ engine: 'postgres' })],
  ['mysql', () => createMysqlDriver({ engine: 'mysql' })],
] as const;
it.each(engines)('%s does not dispatch after authority is revoked during pool acquisition', async (_engine, create) => {
  const driver = await create(); let allowed = true;
  fake.connect.mockImplementationOnce(async () => {
    await Promise.resolve(); allowed = false;
    return { threadId: 42, query: fake.query, release: fake.release, destroy: fake.destroy };
  });
  try {
    await expect(driver.runQuery('DELETE FROM items', { beforeDispatch: () => { if (!allowed) throw new Error('revoked'); } }))
      .rejects.toThrow('revoked');
    expect(fake.query).not.toHaveBeenCalled(); expect(fake.release).toHaveBeenCalledTimes(1);
  } finally { await driver.close(); }
});
it.each(engines)('%s rechecks authority after schema selection', async (engine, create) => {
  const driver = await create(); let allowed = true;
  const statements: string[] = [];
  fake.query.mockImplementation(async (query: string | { text: string }) => {
    const text = typeof query === 'string' ? query : query.text; statements.push(text);
    if (/^(SET search_path|USE)/.test(text)) allowed = false;
    return engine === 'postgres' ? { rows: [{ pid: 42 }], fields: [], rowCount: 1 } : [[], []];
  });
  try {
    await expect(driver.runQuery('DELETE FROM items', { schema: 'fixture', beforeDispatch: () => { if (!allowed) throw new Error('revoked'); } }))
      .rejects.toThrow('revoked');
    expect(statements).not.toContain('DELETE FROM items');
  } finally { await driver.close(); }
});
it.each(engines)('%s evicts an aborted connection so a late server cancel cannot affect the next borrower', async (engine, create) => {
  const driver = await create(), controller = new AbortController();
  fake.query.mockImplementation(async (query: string | { text: string }) => {
    if ((typeof query === 'string' ? query : query.text) === 'DELETE FROM items') controller.abort();
    return engine === 'postgres' ? { rows: [{ pid: 42 }], fields: [], rowCount: 1 } : [[], []];
  });
  try {
    await driver.runQuery('DELETE FROM items', { signal: controller.signal });
    expect(fake.side).toHaveBeenCalledTimes(1);
    if (engine === 'postgres') expect(fake.release).toHaveBeenCalledExactlyOnceWith(true);
    else { expect(fake.destroy).toHaveBeenCalledTimes(1); expect(fake.release).not.toHaveBeenCalled(); }
  } finally { await driver.close(); }
});
