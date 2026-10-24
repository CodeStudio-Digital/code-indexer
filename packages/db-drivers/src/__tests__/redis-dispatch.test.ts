import { beforeEach, expect, it, vi } from 'vitest';
import { fixture } from './fixtures/redis-client.js';
import { createRedisDriver } from '../redis.js';

vi.mock('../driver-registry.js', () => ({ resolveDriverEntry: () => new URL('./fixtures/redis-client.ts', import.meta.url).href }));
beforeEach(() => {
  fixture.events.length = 0;
  fixture.select = async () => {};
  fixture.execute = async () => 'OK';
});
it('accepts the documented raw command shape and honors the saved database', async () => {
  const driver = await createRedisDriver({ engine: 'redis', connectionString: 'redis://localhost/4' });
  try {
    await driver.runCommand!({ kind: 'keyvalue', args: ['GET', 'key'] });
    expect(fixture.events).toEqual([{ method: 'SELECT', db: 4, args: [] }, { method: 'GET', db: 4, args: ['key'] }]);
  } finally { await driver.close(); }
});
it('serializes database selection with the entire command across callers', async () => {
  const driver = await createRedisDriver({ engine: 'redis' });
  let release!: () => void;
  fixture.execute = async (_name, db) => { if (db === 1) await new Promise<void>(resolve => { release = resolve; }); return 'OK'; };
  const first = driver.runCommand!({ kind: 'keyvalue', args: ['SET', 'first', 'value'], payload: { db: 1 } });
  const second = driver.runCommand!({ kind: 'keyvalue', op: 'set', payload: { db: 2, key: 'second', value: 'value' } });
  try {
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(fixture.events.map(e => [e.method, e.db])).toEqual([['SELECT', 1], ['SET', 1]]);
    release(); await first; await second;
    expect(fixture.events.map(e => [e.method, e.db])).toEqual([['SELECT', 1], ['SET', 1], ['SELECT', 2], ['SET', 2]]);
  } finally { release?.(); await driver.close(); }
});
it('never writes to the previous database when SELECT fails', async () => {
  const driver = await createRedisDriver({ engine: 'redis' });
  fixture.select = async () => { throw new Error('database index out of range'); };
  try {
    await expect(driver.runCommand!({ kind: 'keyvalue', op: 'set', payload: { db: 999, key: 'x', value: 'y' } }))
      .rejects.toThrow('out of range');
    expect(fixture.events.map(e => e.method)).toEqual(['SELECT']);
  } finally { await driver.close(); }
});
it('stops before a write when cancellation arrives during SELECT', async () => {
  const driver = await createRedisDriver({ engine: 'redis' }), controller = new AbortController();
  fixture.select = async () => { controller.abort(new Error('cancelled')); };
  try {
    await expect(driver.runCommand!({ kind: 'keyvalue', args: ['SET', 'x', 'y'] }, { signal: controller.signal }))
      .rejects.toThrow('cancelled');
    expect(fixture.events.map(e => e.method)).toEqual(['SELECT']);
  } finally { await driver.close(); }
});
it('does not report success when any pipelined write fails', async () => {
  const driver = await createRedisDriver({ engine: 'redis' });
  fixture.execute = async name => { if (name === 'EXPIRE') throw new Error('expiry denied'); return 'OK'; };
  try {
    await expect(driver.runCommand!({ kind: 'keyvalue', op: 'set', payload: { key: 'x', value: 'y', ttl: 10 } }))
      .rejects.toThrow('expiry denied');
    expect(fixture.events.map(e => e.method)).toEqual(['SELECT', 'SET', 'EXPIRE']);
  } finally { await driver.close(); }
});
it('caps raw multi-bulk replies and preserves truncation evidence', async () => {
  const driver = await createRedisDriver({ engine: 'redis' }); fixture.execute = async () => ['a', 'b', 'c'];
  try {
    expect(await driver.runCommand!({ kind: 'keyvalue', args: ['KEYS', '*'] }, { maxRows: 1 }))
      .toMatchObject({ rowCount: 3, rows: [{ '#': 1, value: 'a' }], truncated: true });
  } finally { await driver.close(); }
});
