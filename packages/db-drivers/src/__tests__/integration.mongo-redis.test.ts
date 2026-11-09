import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDriver } from '../factory.js';
import type { DatabaseDriver, DbCommand, DbConnectConfig } from '../types.js';

/**
 * REAL-database integration tests for the NON-relational drivers — MongoDB
 * (a document store, `kind: 'document'`) and Redis (a key-value store,
 * `kind: 'keyvalue'`). Both reject the SQL surface (runQuery/buildDdl) and route
 * all work through `driver.runCommand(DbCommand)`, so these exercise that path.
 * Zero extra deps: point them at a running server via env URLs. Without the env
 * var the matching suite is SKIPPED, so CI/local without Docker stays green.
 *
 *   docker run --rm -p 27017:27017 mongo:7
 *   DB_IT_MONGO_URL=mongodb://localhost:27017/ pnpm vitest integration.mongo-redis
 *
 *   docker run --rm -p 6379:6379 redis:7
 *   DB_IT_REDIS_URL=redis://localhost:6379 pnpm vitest integration.mongo-redis
 */

const MONGO_URL = process.env.DB_IT_MONGO_URL;
const REDIS_URL = process.env.DB_IT_REDIS_URL;

describe.skipIf(!MONGO_URL)('mongodb (document) integration', () => {
  let driver: DatabaseDriver;
  // Unique temp collection so a real DB is left untouched.
  const collection = `it_dbclient_mongo_${Date.now()}`;

  beforeAll(async () => {
    driver = await createDriver({
      engine: 'mongodb',
      connectionString: MONGO_URL,
      database: dbFromMongoUrl(MONGO_URL),
    } as DbConnectConfig);
  });

  afterAll(async () => {
    if (!driver) return;
    // Best-effort cleanup: drop any stragglers, then close.
    await driver
      .runCommand?.({ kind: 'document', op: 'deleteOne', collection, payload: { filter: {} } })
      .catch(() => void 0);
    await driver.close();
  });

  it('is a document store with a runCommand entry point', () => {
    expect(driver.kind).toBe('document');
    expect(typeof driver.runCommand).toBe('function');
  });

  it('insert → find → update → count → delete round-trips', async () => {
    const run = (command: DbCommand) => driver.runCommand!(command);

    // insertOne → rowCount 1, command echoes the inserted id.
    const inserted = await run({
      kind: 'document',
      op: 'insertOne',
      collection,
      payload: { document: { sku: 'A1', qty: 2 } },
    });
    expect(inserted.rowCount).toBe(1);
    expect(inserted.command).toMatch(/^inserted /);
    expect(inserted.rows).toEqual([]);

    // find → normalized rows (ObjectId _id → Extended-JSON tag { $oid: hex }) + `_id` first.
    const found = await run({
      kind: 'document',
      op: 'find',
      collection,
      payload: { filter: { sku: 'A1' } },
    });
    expect(found.rowCount).toBe(1);
    const doc = found.rows[0] as { _id: { $oid?: string }; sku: string; qty: number };
    expect(typeof doc._id).toBe('object');
    expect(typeof doc._id.$oid).toBe('string');
    expect(/^[a-f0-9]{24}$/i.test(doc._id.$oid ?? '')).toBe(true);
    expect(doc.sku).toBe('A1');
    expect(doc.qty).toBe(2);
    expect(found.fields.map((f) => f.name)).toContain('_id');
    expect(found.fields[0].name).toBe('_id');

    // The {$oid} tag fed straight back as a filter is revived to ObjectId and matches.
    const byOid = await run({ kind: 'document', op: 'updateOne', collection, payload: { filter: { _id: doc._id }, update: { qty: 7 } } });
    expect(byOid.rowCount).toBe(1);

    // updateOne → rowCount mirrors matchedCount (here 1).
    const updated = await run({
      kind: 'document',
      op: 'updateOne',
      collection,
      payload: { filter: { sku: 'A1' }, update: { qty: 5 } },
    });
    expect(updated.rowCount).toBe(1);
    expect(updated.command).toBe('updated');

    // updateOne against a non-matching filter → matchedCount 0.
    const updatedNone = await run({
      kind: 'document',
      op: 'updateOne',
      collection,
      payload: { filter: { sku: 'NOPE' }, update: { qty: 9 } },
    });
    expect(updatedNone.rowCount).toBe(0);

    // countDocuments → rows shape `[{ count: n }]`, rowCount == n.
    const counted = await run({
      kind: 'document',
      op: 'countDocuments',
      collection,
      payload: { filter: {} },
    });
    expect(counted.rowCount).toBe(1);
    expect((counted.rows[0] as { count: number }).count).toBe(1);
    expect(counted.fields.map((f) => f.name)).toEqual(['count']);

    // Confirm the update actually landed.
    const refound = await run({ kind: 'document', op: 'find', collection, payload: { filter: { sku: 'A1' } } });
    expect((refound.rows[0] as { qty: number }).qty).toBe(5);

    // deleteOne → rowCount mirrors deletedCount (1).
    const deleted = await run({
      kind: 'document',
      op: 'deleteOne',
      collection,
      payload: { filter: { sku: 'A1' } },
    });
    expect(deleted.rowCount).toBe(1);
    expect(deleted.command).toBe('deleted');

    // Empty after delete.
    const after = await run({ kind: 'document', op: 'countDocuments', collection, payload: { filter: {} } });
    expect((after.rows[0] as { count: number }).count).toBe(0);
  });

  it('a genuine string _id is NOT revived to ObjectId — matches by string', async () => {
    const run = (command: DbCommand) => driver.runCommand!(command);
    await run({ kind: 'document', op: 'insertOne', collection, payload: { document: { _id: 'abc', v: 1 } } });
    const found = await run({ kind: 'document', op: 'find', collection, payload: { filter: { _id: 'abc' } } });
    expect(found.rowCount).toBe(1);
    expect((found.rows[0] as { _id: unknown })._id).toBe('abc'); // stays a string, not { $oid }
    const upd = await run({ kind: 'document', op: 'updateOne', collection, payload: { filter: { _id: 'abc' }, update: { v: 2 } } });
    expect(upd.rowCount).toBe(1);
    const del = await run({ kind: 'document', op: 'deleteOne', collection, payload: { filter: { _id: 'abc' } } });
    expect(del.rowCount).toBe(1);
  });

  it('bounds a real cursor page and large document cells, then accepts another query', async () => {
    const boundedCollection = `${collection}_bounded`;
    const run = (command: DbCommand) => driver.runCommand!(command);
    await run({ kind: 'document', op: 'insertMany', collection: boundedCollection,
      payload: { documents: Array.from({ length: 12 }, (_, index) => ({ index, value: 'x'.repeat(80_000) })) } });
    try {
      const page = await driver.runCommand!({ kind: 'document', op: 'find', collection: boundedCollection,
        payload: { filter: {} } }, { maxRows: 2 });
      expect(page.rows).toHaveLength(2);
      expect(page.truncated).toBe(true);
      expect(page.acquisition).toMatchObject({ mode: 'cursor', observedRows: 3, returnedRows: 2, cellsTruncated: 2 });
      expect(page.acquisition!.retainedBytes).toBeLessThan(150_000);
      const count = await run({ kind: 'document', op: 'countDocuments', collection: boundedCollection, payload: { filter: {} } });
      expect(count.rowCount).toBe(12);
      const abort = new AbortController(); abort.abort(new Error('integration cancelled'));
      await expect(driver.runCommand!({ kind: 'document', op: 'find', collection: boundedCollection }, { signal: abort.signal }))
        .rejects.toThrow('integration cancelled');
    } finally {
      for (let index = 0; index < 12; index++) await run({ kind: 'document', op: 'deleteOne', collection: boundedCollection, payload: { filter: { index } } });
    }
  });
});

describe.skipIf(!REDIS_URL)('redis (keyvalue) integration', () => {
  let driver: DatabaseDriver;
  // Unique temp key prefix so a real DB is left untouched.
  const prefix = `it:dbclient:redis:${Date.now()}`;
  const key = `${prefix}:hello`;

  beforeAll(async () => {
    driver = await createDriver({ engine: 'redis', connectionString: REDIS_URL } as DbConnectConfig);
  });

  afterAll(async () => {
    if (!driver) return;
    await driver.runCommand?.({ kind: 'keyvalue', op: 'del', payload: { key } }).catch(() => void 0);
    await driver.close();
  });

  it('is a key-value store with a runCommand entry point', () => {
    expect(driver.kind).toBe('keyvalue');
    expect(typeof driver.runCommand).toBe('function');
  });

  it('set → get (value/type/ttl) → scan → del round-trips', async () => {
    const run = (command: DbCommand) => driver.runCommand!(command);

    // set with a TTL → command 'OK'.
    const set = await run({ kind: 'keyvalue', op: 'set', payload: { key, value: 'world', ttl: 120 } });
    expect(set.rowCount).toBe(1);
    expect(set.command).toBe('OK');

    // get → single row carrying key/type/ttl/value; string type, value echoed.
    const got = await run({ kind: 'keyvalue', op: 'get', payload: { key } });
    expect(got.rowCount).toBe(1);
    const row = got.rows[0] as { key: string; type: string; ttl: number; value: unknown };
    expect(row.key).toBe(key);
    expect(row.type).toBe('string');
    expect(row.value).toBe('world');
    // TTL is returned in seconds (we set 120; ioredis may report slightly less).
    expect(row.ttl).toBeGreaterThan(0);
    expect(row.ttl).toBeLessThanOrEqual(120);
    expect(got.fields.map((f) => f.name)).toEqual(['key', 'type', 'ttl', 'value']);

    // scan → cursor + key/type/ttl rows; our key shows up under its prefix match.
    const scan = await run({ kind: 'keyvalue', op: 'scan', payload: { cursor: '0', match: `${prefix}:*` } });
    expect(typeof scan.cursor).toBe('string');
    expect(scan.fields.map((f) => f.name)).toEqual(['key', 'type', 'ttl']);
    // SCAN is incremental — accumulate until the cursor returns to '0'.
    const keys = new Set<string>(scan.rows.map((r) => String((r as { key: string }).key)));
    let cursor = scan.cursor ?? '0';
    let guard = 0;
    while (cursor !== '0' && guard++ < 1000) {
      const next = await run({ kind: 'keyvalue', op: 'scan', payload: { cursor, match: `${prefix}:*` } });
      for (const r of next.rows) keys.add(String((r as { key: string }).key));
      cursor = next.cursor ?? '0';
    }
    expect(keys.has(key)).toBe(true);
    // Each scanned row has the documented shape.
    for (const r of scan.rows) {
      expect(typeof (r as { key: string }).key).toBe('string');
      expect('type' in (r as object)).toBe(true);
      expect('ttl' in (r as object)).toBe(true);
    }

    // del → rowCount reflects keys removed (1), command 'deleted'.
    const del = await run({ kind: 'keyvalue', op: 'del', payload: { key } });
    expect(del.rowCount).toBe(1);
    expect(del.command).toBe('deleted');

    // get after del → type 'none' (key gone).
    const gone = await run({ kind: 'keyvalue', op: 'get', payload: { key } });
    expect((gone.rows[0] as { type: string }).type).toBe('none');
  });

  it('keeps simultaneous logical databases separate and rejects an invalid SELECT before writing', async () => {
    const scopedKey = `${prefix}:scope`;
    const run = (op: string, db: number, value?: string) => driver.runCommand!({
      kind: 'keyvalue', op, payload: { db, key: scopedKey, ...(value === undefined ? {} : { value }) },
    });
    try {
      await Promise.all([run('set', 1, 'one'), run('set', 2, 'two')]);
      const values = await Promise.all([run('get', 1), run('get', 2)]);
      expect(values.map(result => (result.rows[0] as { value: string }).value)).toEqual(['one', 'two']);
      await expect(run('set', 999, 'wrong database')).rejects.toThrow(/DB index|out of range/i);
      expect((await run('get', 2)).rows[0]).toMatchObject({ value: 'two' });
    } finally { await run('del', 1); await run('del', 2); }
  });

  it('bounds previews before RESP delivery for strings and all supported collections', async () => {
    const keys = ['string', 'list', 'hash', 'set', 'zset'].map(type => `${prefix}:bounded:${type}`);
    const raw = (args: string[]) => driver.runCommand!({ kind: 'keyvalue', op: 'raw', args });
    const get = (key: string, maxRows = 2) => driver.runCommand!({ kind: 'keyvalue', op: 'get', payload: { key } }, { maxRows });
    try {
      await raw(['SET', keys[0], '🙂'.repeat(40_000)]);
      await raw(['RPUSH', keys[1], ...Array.from({ length: 800 }, (_, index) => `item-${index}`)]);
      await raw(['HSET', keys[2], 'small', 'ok', 'large', 'x'.repeat(80_000)]);
      await raw(['SADD', keys[3], ...Array.from({ length: 800 }, (_, index) => `member-${index}`)]);
      await raw(['ZADD', keys[4], ...Array.from({ length: 800 }, (_, index) => [String(index), `member-${index}`]).flat()]);
      const string = await get(keys[0]);
      expect(string.truncated).toBe(true);
      expect(Buffer.byteLength(String(string.rows[0].value))).toBeLessThanOrEqual(65_536);
      const list = await get(keys[1]);
      expect(list).toMatchObject({ truncated: true, rows: [{ value: ['item-0', 'item-1'] }] });
      const hash = await get(keys[2], 200);
      expect(hash.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(hash.rows))).toBeLessThan(70_000);
      const set = await get(keys[3]);
      expect(set.truncated).toBe(true); expect((set.rows[0].value as unknown[]).length).toBeLessThanOrEqual(2);
      const sorted = await get(keys[4]);
      expect(sorted).toMatchObject({ truncated: true, rows: [{ value: ['member-0', '0', 'member-1', '1'] }] });
      // Preview never modifies the source or disguises an omitted tail as complete.
      expect((await raw(['LLEN', keys[1]])).rows[0].value).toBe(800);
      expect((await raw(['STRLEN', keys[0]])).rows[0].value).toBe(160_000);
      await raw(['SET', keys[0], 'complete']);
      expect(await get(keys[0])).toMatchObject({ truncated: false, rows: [{ value: 'complete' }] });
    } finally { await raw(['DEL', ...keys]); }
  });
});

/** Mongo URL path is the default database; fall back to a test db name. */
function dbFromMongoUrl(url: string | undefined): string {
  if (!url) return 'it_dbclient_test';
  try {
    const path = new URL(url).pathname.replace(/^\//, '');
    return path || 'it_dbclient_test';
  } catch {
    return 'it_dbclient_test';
  }
}
