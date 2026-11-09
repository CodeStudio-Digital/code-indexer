import { ApiError } from '@mcp/api-bus';
import type { DatabaseDriver, DbEngine, QueryResult } from '@mcp/db-drivers';
import { DbBatchError } from '@mcp/db-drivers';
import { buildDml, type RowChange } from '@mcp/db-drivers/sql/dml.js';

export async function applyCheckedRowEdits(driver: DatabaseDriver, engine: DbEngine, changes: RowChange[], dryRun?: boolean) {
  for (const change of changes) {
    if (change.op !== 'insert' && (!change.original || !Object.keys(change.original).length)) {
      throw new ApiError('db_edit_requires_original', 409, 'Reload the row before editing; original values are required to detect concurrent changes.');
    }
  }
  const built = changes.map(change => buildDml(engine, change));
  const sql = built.map(statement => statement.display).join(';\n') + (built.length ? ';' : '');
  if (dryRun || !built.length) return { sql, applied: 0, results: [] as QueryResult[] };
  if (!driver.runBatch) throw new ApiError('db_atomic_edit_unsupported', 422, 'This driver cannot apply a checked row edit transaction.');
  // Validate the whole composite primary key against current metadata, before
  // any mutation. User-supplied column names are not evidence of uniqueness.
  const relations = new Map<string, { keys: string[]; columns: string[] }>();
  for (const change of changes) if (change.op !== 'insert') {
    const key = JSON.stringify([change.schema, change.table]);
    let relation = relations.get(key);
    if (!relation) {
      const table = await driver.describeTable(change.schema ?? '', change.table);
      relation = { keys: table.columns.filter(c => c.isPrimaryKey).map(c => c.name), columns: table.columns.map(c => c.name) };
      relations.set(key, relation);
    }
    const { keys, columns } = relation;
    if (!keys.length || keys.some(key => !(key in (change.pk ?? {}))) || Object.keys(change.pk ?? {}).some(key => !keys!.includes(key))) {
      throw new ApiError('db_edit_primary_key', 409, 'The complete current primary key is required. Reload this table.');
    }
    if (columns.some(column => !keys.includes(column) && !Object.hasOwn(change.original!, column))
      || Object.keys(change.original!).some(column => !columns.includes(column))) {
      throw new ApiError('db_edit_requires_complete_original', 409, 'A complete original row is required. Reload all columns before editing.');
    }
  }
  const results: QueryResult[] = [];
  try {
    const result = await driver.runBatch(built.map(s => ({ sql: s.sql, params: s.params })), {
      onResult: (result, index) => {
        if (changes[index].op !== 'insert' && result.rowCount !== 1) {
          throw new ApiError('db_edit_conflict', 409, 'The row changed or was deleted after loading. Reload and review your edit before applying again.', { changeIndex: index });
        }
        results.push(result);
      },
    });
    return { sql, result, results, applied: changes.length };
  } catch (error) {
    if (error instanceof DbBatchError && error.cause instanceof ApiError) {
      throw new ApiError('db_edit_conflict', 409, error.cause.message, { outcome: error.outcome });
    }
    throw error;
  }
}
