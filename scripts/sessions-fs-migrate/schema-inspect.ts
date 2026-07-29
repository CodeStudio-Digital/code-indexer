/**
 * Internal read-only helper for auditing an Electron-ABI database while
 * developing/validating the explicit disposition manifest.
 */
import { openDatabase, tableColumns } from './db.js';
import { findUnclassifiedSessionSchema } from './manifest.js';

const args = process.argv.slice(2);
const check = args.includes('--check');
const dbPath = args.find((arg) => arg !== '--check');
if (!dbPath) throw new Error('schema-inspect requires a DB path');
const db = openDatabase(dbPath, { readonly: true, fileMustExist: true });
try {
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).all() as Array<{ name: string }>;
  const schema = tables.map((table) => ({
    name: table.name,
    columns: tableColumns(db, table.name),
  }));
  const output = schema.filter((table) => table.columns.some((column) => (
    column === 'session_id'
    || column === 'company_session_id'
    || column === 'coder_session_id'
    || column === 'legacy_session_id'
    || column === 'parent_coder_session_id'
    || column === 'app_session_id'
    || column === 'sprite_project_id'
  )));
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (check) {
    const violations = findUnclassifiedSessionSchema(schema);
    if (violations.length > 0) {
      throw new Error(`session disposition audit failed:\n${violations.join('\n')}`);
    }
  }
} finally {
  db.close();
}
