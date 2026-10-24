import { beforeEach, expect, it, vi } from 'vitest';
import { fixture } from './fixtures/mongo-client.js';
import { createMongoDriver } from '../mongodb.js';

vi.mock('../driver-registry.js', () => ({ resolveDriverEntry: () => new URL('./fixtures/mongo-client.ts', import.meta.url).href }));
beforeEach(() => { fixture.pulled = 0; fixture.closed = 0; fixture.total = 10000; fixture.requests.length = 0; });
it.each(['find', 'aggregate'])('%s does not materialize the collection before applying the row cap', async op => {
  const driver = await createMongoDriver({ engine: 'mongodb' });
  try {
    const signal = new AbortController().signal;
    const result = await driver.runCommand!({ kind: 'document', op, collection: 'items' }, { maxRows: 2, signal, timeoutMs: 1000 });
    expect(result.rows).toHaveLength(2); expect(result.truncated).toBe(true);
    expect(fixture.pulled).toBe(3); expect(fixture.closed).toBe(1);
    expect(fixture.requests[0].options).toMatchObject({ signal, maxTimeMS: 1000 });
  } finally { await driver.close(); }
});
it('keeps a writing aggregation unchanged and drains it before confirming its result', async () => {
  const driver = await createMongoDriver({ engine: 'mongodb' }); fixture.total = 8;
  const pipeline = [{ $match: { enabled: true } }, { $merge: 'destination' }];
  try {
    const result = await driver.runCommand!({ kind: 'document', op: 'aggregate', collection: 'items', payload: { pipeline } }, { maxRows: 2 });
    expect(result.rows).toHaveLength(2); expect(result.rowCount).toBe(8);
    expect(fixture.requests[0].input).toEqual(pipeline);
    expect(fixture.pulled).toBe(8); expect(fixture.closed).toBe(1);
  } finally { await driver.close(); }
});
it('does not create a cursor when dispatch authority has expired', async () => {
  const driver = await createMongoDriver({ engine: 'mongodb' });
  try {
    await expect(driver.runCommand!({ kind: 'document', op: 'aggregate', collection: 'items' }, {
      beforeDispatch: () => { throw new Error('revoked'); },
    })).rejects.toThrow('revoked');
    expect(fixture.requests).toEqual([]);
  } finally { await driver.close(); }
});
