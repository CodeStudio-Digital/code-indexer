import { ApiError, type DbRowBatch } from '@mcp/api-bus';
import type { DatabaseDriver, DbEngine } from '@mcp/db-drivers';
import { buildExportPage } from '@mcp/db-drivers/sql/export-page.js';

/** Pull-based batches: one page acquired per consumer request, no prefetch. */
export async function* exportTableRows(driver: DatabaseDriver, engine: DbEngine, schema: string | undefined, table: string, batchRows?: number, signal?: AbortSignal): AsyncGenerator<DbRowBatch> {
  signal?.throwIfAborted();
  const info = await driver.describeTable(schema ?? '', table);
  const keys = info.columns.filter(c => c.isPrimaryKey).map(c => c.name);
  let after: unknown[] | undefined;
  let total = 0;
  for (;;) {
    signal?.throwIfAborted();
    const built = buildExportPage(engine, schema, table, keys, after, batchRows ?? 500);
    const result = await driver.runQuery(built.sql, { params: built.params, maxRows: built.limit, signal, timeoutMs: 30_000 });
    if (result.acquisition?.cellsTruncated || result.truncated && !result.rows.length) {
      throw new ApiError('db_export_value_too_large', 422, 'A value exceeds the lossless export budget. Use a native database dump; this export cannot be marked complete.');
    }
    total += result.rows.length;
    if (result.rows.length) {
      after = keys.map(key => result.rows[result.rows.length - 1][key]);
      if (after.some(value => value == null)) throw new ApiError('db_export_nullable_key', 422, 'A null primary-key value prevents a reliable continuation.');
    }
    const done = !result.truncated;
    yield { columns: info.columns.map(c => c.name), rows: result.rows, total, done,
      consistency: 'best_effort', pagination: 'keyset', observedAt: Date.now() };
    if (done) return;
  }
}
