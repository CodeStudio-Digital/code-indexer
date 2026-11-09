import { expect, it } from 'vitest';
import { timedDatabaseStage, withDatabaseTimings } from '../query-timing.js';

it('isolates concurrent query stages and exposes no unmeasured zeroes or row content in timing evidence', async () => {
  const row = { secret: 'sentinel-row-secret' };
  const [first, second] = await Promise.all([
    withDatabaseTimings(async () => {
      await timedDatabaseStage('acquireMs', async () => { await new Promise(r => setTimeout(r, 5)); });
      return { rows: [row], fields: [], rowCount: 1 };
    }),
    withDatabaseTimings(async () => {
      await timedDatabaseStage('executeFetchMs', async () => undefined);
      return { rows: [], fields: [], rowCount: 0 };
    }),
  ]);
  expect(first.timings?.acquireMs).toBeGreaterThan(0);
  expect(first.timings?.executeFetchMs).toBeUndefined();
  expect(second.timings?.acquireMs).toBeUndefined();
  expect(second.timings?.executeFetchMs).toBeGreaterThanOrEqual(0);
  expect(first.timings?.unmeasured).toContain('serializationMs');
  expect(JSON.stringify(first.timings)).not.toContain('sentinel');
});
