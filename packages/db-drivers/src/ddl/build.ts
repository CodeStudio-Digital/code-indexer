/**
 * Dialect DDL builder. Returns an ARRAY of statements (each run separately — a
 * single ALTER may expand to several, and MySQL disallows multi-statement by
 * default). The structure editor shows `statements.join(';\n') + ';'` as the
 * preview and applies them in order.
 */
import { quoteIdent, quoteRelation } from '../sql/identifiers.js';
import type { DbEngine, TableInfo } from '../types.js';
import type { AlterTableSpec, ColumnSpec, CreateTableSpec, DdlOp, DdlSpec, DropTableSpec, ForeignKeySpec, IndexSpec } from './spec.js';

const FK_ACTIONS = new Set(['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']);

/** A referential action is a closed enum — reject anything else (no injection). */
function fkAction(a: string | undefined | null): string | undefined {
  if (a == null || a.trim() === '') return undefined;
  const up = a.trim().toUpperCase();
  if (!FK_ACTIONS.has(up)) throw new Error(`db-ddl: invalid referential action "${a}"`);
  return up;
}

/**
 * Column types and default expressions are interpolated RAW (they're too free-form
 * to enumerate). Block statement-breaking tokens so a malicious/confused spec
 * can't chain `; DROP …` or comment out the rest of the statement.
 */
function assertSafeFragment(s: string | null | undefined): void {
  if (s == null) return;
  if (/;|--|\/\*/.test(s)) throw new Error(`db-ddl: unsafe SQL fragment "${s}"`);
}

/** A single-quoted SQL string literal (for SQL Server's sp_rename arguments). */
function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export function buildDdl(engine: DbEngine, op: DdlOp, spec: DdlSpec): string[] {
  if (op === 'create') {
    if (!spec.create) throw new Error('ddl: create spec missing');
    return [buildCreate(engine, spec.create)];
  }
  if (op === 'drop') {
    if (!spec.drop) throw new Error('ddl: drop spec missing');
    return [buildDrop(engine, spec.drop)];
  }
  if (!spec.alter) throw new Error('ddl: alter spec missing');
  return buildAlter(engine, spec.alter);
}

// ─── CREATE ──────────────────────────────────────────────────────────────
function buildCreate(engine: DbEngine, spec: CreateTableSpec): string {
  const rel = quoteRelation(engine, spec.schema, spec.table);
  const pkCols = spec.columns.filter((c) => c.primaryKey);
  // SQLite: a single autoincrement PK MUST be inline `INTEGER PRIMARY KEY AUTOINCREMENT`.
  const sqliteInlinePk =
    engine === 'sqlite' && pkCols.length === 1 && !!pkCols[0].autoIncrement ? pkCols[0].name : null;

  const colDefs = spec.columns.map((c) =>
    c.name === sqliteInlinePk
      ? `${quoteIdent(engine, c.name)} INTEGER PRIMARY KEY AUTOINCREMENT`
      : renderColumn(engine, c),
  );

  const parts = [...colDefs];
  if (pkCols.length > 0 && !sqliteInlinePk) {
    parts.push(`PRIMARY KEY (${pkCols.map((c) => quoteIdent(engine, c.name)).join(', ')})`);
  }
  return `CREATE TABLE ${rel} (\n  ${parts.join(',\n  ')}\n)`;
}

// ─── ALTER ───────────────────────────────────────────────────────────────
function buildAlter(engine: DbEngine, spec: AlterTableSpec): string[] {
  const rel = quoteRelation(engine, spec.schema, spec.table);
  const out: string[] = [];
  for (const action of spec.actions) {
    switch (action.kind) {
      case 'addColumn':
        // SQL Server + Oracle add-column has no COLUMN keyword.
        out.push(`ALTER TABLE ${rel} ${engine === 'mssql' || engine === 'oracle' ? 'ADD' : 'ADD COLUMN'} ${renderColumn(engine, action.column)}`);
        break;
      case 'dropColumn':
        out.push(`ALTER TABLE ${rel} DROP COLUMN ${quoteIdent(engine, action.name)}`);
        break;
      case 'renameColumn':
        if (engine === 'mssql') {
          out.push(`EXEC sp_rename ${sqlStr(`${spec.schema ? `${spec.schema}.` : ''}${spec.table}.${action.from}`)}, ${sqlStr(action.to)}, 'COLUMN'`);
        } else {
          out.push(`ALTER TABLE ${rel} RENAME COLUMN ${quoteIdent(engine, action.from)} TO ${quoteIdent(engine, action.to)}`);
        }
        break;
      case 'modifyColumn':
        out.push(...renderModify(engine, rel, action.name, action.column));
        break;
      case 'renameTable':
        // SQL Server renames via sp_rename, not ALTER … RENAME TO.
        if (engine === 'mssql') {
          out.push(`EXEC sp_rename ${sqlStr(`${spec.schema ? `${spec.schema}.` : ''}${spec.table}`)}, ${sqlStr(action.to)}`);
        } else {
          out.push(`ALTER TABLE ${rel} RENAME TO ${quoteIdent(engine, action.to)}`);
        }
        break;
      case 'addIndex': {
        const cols = action.index.columns.map((c) => quoteIdent(engine, c)).join(', ');
        out.push(`CREATE ${action.index.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(engine, action.index.name)} ON ${rel} (${cols})`);
        break;
      }
      case 'dropIndex':
        // MySQL + SQL Server drop an index relative to its table; pg/sqlite by (schema-qualified) name.
        if (engine === 'mysql' || engine === 'mariadb' || engine === 'mssql') out.push(`DROP INDEX ${quoteIdent(engine, action.name)} ON ${rel}`);
        else out.push(`DROP INDEX ${quoteRelation(engine, spec.schema, action.name)}`);
        break;
      case 'addForeignKey':
        if (engine === 'sqlite') {
          out.push(`-- SQLite: adding a foreign key requires a table rebuild (not supported here)`);
          break;
        }
        out.push(renderAddFk(engine, rel, action.fk));
        break;
      case 'dropForeignKey':
        if (engine === 'sqlite') out.push(`-- SQLite: dropping a foreign key requires a table rebuild (not supported here)`);
        else if (engine === 'mysql' || engine === 'mariadb') out.push(`ALTER TABLE ${rel} DROP FOREIGN KEY ${quoteIdent(engine, action.name)}`);
        else out.push(`ALTER TABLE ${rel} DROP CONSTRAINT ${quoteIdent(engine, action.name)}`);
        break;
    }
  }
  return out;
}

function renderModify(engine: DbEngine, rel: string, name: string, col: ColumnSpec): string[] {
  if (engine === 'mysql' || engine === 'mariadb') {
    return [`ALTER TABLE ${rel} MODIFY COLUMN ${renderColumn(engine, col)}`];
  }
  if (engine === 'mssql') {
    // SQL Server changes type/nullability with ALTER COLUMN; defaults live in a
    // separate constraint, so they're not folded in here.
    assertSafeFragment(col.type);
    return [`ALTER TABLE ${rel} ALTER COLUMN ${quoteIdent(engine, col.name)} ${col.type}${col.nullable === false ? ' NOT NULL' : ' NULL'}`];
  }
  if (engine === 'oracle') {
    // Oracle: MODIFY (col type [NOT NULL]). Re-stating the current nullability is
    // an error, so only emit NOT NULL when the editor explicitly set it.
    assertSafeFragment(col.type);
    return [`ALTER TABLE ${rel} MODIFY ${quoteIdent(engine, col.name)} ${col.type}${col.nullable === false ? ' NOT NULL' : ''}`];
  }
  if (engine === 'postgres') {
    assertSafeFragment(col.type);
    assertSafeFragment(col.default);
    const q = quoteIdent(engine, name);
    const stmts = [`ALTER TABLE ${rel} ALTER COLUMN ${q} TYPE ${col.type}`];
    if (col.nullable === false) stmts.push(`ALTER TABLE ${rel} ALTER COLUMN ${q} SET NOT NULL`);
    else if (col.nullable === true) stmts.push(`ALTER TABLE ${rel} ALTER COLUMN ${q} DROP NOT NULL`);
    if (col.default != null) stmts.push(`ALTER TABLE ${rel} ALTER COLUMN ${q} SET DEFAULT ${col.default}`);
    else stmts.push(`ALTER TABLE ${rel} ALTER COLUMN ${q} DROP DEFAULT`);
    return stmts;
  }
  // SQLite can't modify a column in place — it needs a 12-step table rebuild.
  return [`-- SQLite: modifying column "${name}" requires a table rebuild (not supported here)`];
}

function renderAddFk(engine: DbEngine, rel: string, fk: ForeignKeySpec): string {
  const cols = fk.columns.map((c) => quoteIdent(engine, c)).join(', ');
  const refRel = quoteRelation(engine, fk.refSchema, fk.refTable);
  const refCols = fk.refColumns.map((c) => quoteIdent(engine, c)).join(', ');
  let s = `ALTER TABLE ${rel} ADD CONSTRAINT ${quoteIdent(engine, fk.name)} FOREIGN KEY (${cols}) REFERENCES ${refRel} (${refCols})`;
  const onDel = fkAction(fk.onDelete);
  const onUpd = fkAction(fk.onUpdate);
  if (onDel) s += ` ON DELETE ${onDel}`;
  if (onUpd) s += ` ON UPDATE ${onUpd}`;
  return s;
}

// ─── DROP ────────────────────────────────────────────────────────────────
function buildDrop(engine: DbEngine, spec: DropTableSpec): string {
  return `DROP TABLE ${quoteRelation(engine, spec.schema, spec.table)}`;
}

/** Inline FOREIGN KEY clause for a CREATE TABLE (used by the SQLite rebuild). */
function renderInlineFk(engine: DbEngine, fk: ForeignKeySpec): string {
  const cols = fk.columns.map((c) => quoteIdent(engine, c)).join(', ');
  const refRel = quoteRelation(engine, fk.refSchema, fk.refTable);
  const refCols = fk.refColumns.map((c) => quoteIdent(engine, c)).join(', ');
  let s = `CONSTRAINT ${quoteIdent(engine, fk.name)} FOREIGN KEY (${cols}) REFERENCES ${refRel} (${refCols})`;
  const onDel = fkAction(fk.onDelete);
  const onUpd = fkAction(fk.onUpdate);
  if (onDel) s += ` ON DELETE ${onDel}`;
  if (onUpd) s += ` ON UPDATE ${onUpd}`;
  return s;
}

/**
 * SQLite can't `ALTER COLUMN` / add-or-drop a FK in place. The documented
 * workaround is a table rebuild: create a new table with the desired shape,
 * copy the data, drop the old, rename. This is PURE — it takes the introspected
 * current `TableInfo` plus the requested alter actions and emits the full
 * statement list (the handler runs it in a transaction with FK enforcement off).
 * Used when an alter contains modifyColumn / add|dropForeignKey; it applies the
 * WHOLE action list so a mixed alter still resolves in one rebuild.
 */
export function buildSqliteRebuild(info: TableInfo, spec: AlterTableSpec): string[] {
  const engine: DbEngine = 'sqlite';
  interface WorkCol { spec: ColumnSpec; src: string | null }
  let cols: WorkCol[] = (info.columns ?? []).map((c) => ({
    spec: {
      name: c.name,
      type: c.dataType,
      nullable: c.nullable,
      default: c.defaultValue ?? null,
      primaryKey: c.isPrimaryKey,
      autoIncrement: c.isAutoIncrement,
    },
    src: c.name,
  }));
  if (cols.length === 0) throw new Error('db-ddl: cannot rebuild a table with no known columns');

  let fks: ForeignKeySpec[] = (info.foreignKeys ?? []).map((f) => ({
    name: f.name, columns: f.columns, refSchema: f.refSchema, refTable: f.refTable,
    refColumns: f.refColumns, onDelete: f.onDelete, onUpdate: f.onUpdate,
  }));
  const addIdx: IndexSpec[] = [];
  const dropIdx = new Set<string>();
  const colRename = new Map<string, string>();
  const droppedCols = new Set<string>();
  let finalName = spec.table;

  for (const a of spec.actions) {
    switch (a.kind) {
      case 'addColumn':
        cols.push({ spec: a.column, src: null });
        break;
      case 'dropColumn':
        cols = cols.filter((c) => c.spec.name !== a.name);
        droppedCols.add(a.name);
        break;
      case 'renameColumn': {
        const wc = cols.find((c) => c.spec.name === a.from);
        if (wc) wc.spec = { ...wc.spec, name: a.to };
        colRename.set(a.from, a.to);
        break;
      }
      case 'modifyColumn': {
        const idx = cols.findIndex((c) => c.spec.name === a.name);
        if (idx >= 0) {
          cols[idx] = { spec: a.column, src: cols[idx].src };
          if (a.column.name !== a.name) colRename.set(a.name, a.column.name);
        }
        break;
      }
      case 'renameTable':
        finalName = a.to;
        break;
      case 'addIndex':
        addIdx.push(a.index);
        break;
      case 'dropIndex':
        dropIdx.add(a.name);
        break;
      case 'addForeignKey':
        fks.push(a.fk);
        break;
      case 'dropForeignKey':
        fks = fks.filter((f) => f.name !== a.name);
        break;
    }
  }

  const tmp = `${spec.table}__mcp_rebuild`;
  const pkCols = cols.filter((c) => c.spec.primaryKey);
  const inlinePk = pkCols.length === 1 && !!pkCols[0].spec.autoIncrement ? pkCols[0].spec.name : null;
  const colDefs = cols.map((c) =>
    c.spec.name === inlinePk
      ? `${quoteIdent(engine, c.spec.name)} INTEGER PRIMARY KEY AUTOINCREMENT`
      : renderColumn(engine, c.spec),
  );
  const parts = [...colDefs];
  if (pkCols.length > 0 && !inlinePk) {
    parts.push(`PRIMARY KEY (${pkCols.map((c) => quoteIdent(engine, c.spec.name)).join(', ')})`);
  }
  for (const fk of fks) parts.push(renderInlineFk(engine, fk));

  // Copy only the columns that existed before (new columns take their default).
  const copy = cols.filter((c) => c.src);
  const insertCols = copy.map((c) => quoteIdent(engine, c.spec.name)).join(', ');
  const selectCols = copy.map((c) => quoteIdent(engine, c.src as string)).join(', ');

  // Recreate non-primary, non-auto indexes (remap renamed columns; drop those on
  // removed columns), plus any explicitly added index, minus dropped ones.
  const existing = (info.indexes ?? [])
    .filter((ix) => !ix.primary && !/^sqlite_autoindex/i.test(ix.name) && !dropIdx.has(ix.name))
    .map((ix) => ({
      name: ix.name,
      unique: ix.unique,
      columns: ix.columns.filter((c) => !droppedCols.has(c)).map((c) => colRename.get(c) ?? c),
      complete: ix.columns.every((c) => !droppedCols.has(c)),
    }))
    .filter((ix) => ix.complete && ix.columns.length > 0);
  const idxStmts = [
    ...existing.map((ix) => `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(engine, ix.name)} ON ${quoteIdent(engine, finalName)} (${ix.columns.map((c) => quoteIdent(engine, c)).join(', ')})`),
    ...addIdx.map((ix) => `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(engine, ix.name)} ON ${quoteIdent(engine, finalName)} (${ix.columns.map((c) => quoteIdent(engine, c)).join(', ')})`),
  ];

  return [
    'PRAGMA foreign_keys=OFF',
    'BEGIN TRANSACTION',
    `CREATE TABLE ${quoteIdent(engine, tmp)} (\n  ${parts.join(',\n  ')}\n)`,
    `INSERT INTO ${quoteIdent(engine, tmp)} (${insertCols})\n  SELECT ${selectCols} FROM ${quoteIdent(engine, spec.table)}`,
    `DROP TABLE ${quoteIdent(engine, spec.table)}`,
    `ALTER TABLE ${quoteIdent(engine, tmp)} RENAME TO ${quoteIdent(engine, finalName)}`,
    ...idxStmts,
    'COMMIT',
    'PRAGMA foreign_keys=ON',
  ];
}

/** True when a SQLite alter needs a full table rebuild (modify-column / FK ops). */
export function sqliteAlterNeedsRebuild(spec: AlterTableSpec): boolean {
  return spec.actions.some((a) => a.kind === 'modifyColumn' || a.kind === 'addForeignKey' || a.kind === 'dropForeignKey');
}

// ─── Shared column rendering ─────────────────────────────────────────────
function renderColumn(engine: DbEngine, col: ColumnSpec): string {
  assertSafeFragment(col.type);
  assertSafeFragment(col.default);
  const mysql = engine === 'mysql' || engine === 'mariadb';
  let s = `${quoteIdent(engine, col.name)} ${col.type}`;
  if (mysql && col.unsigned) s += ' UNSIGNED';
  if ((engine === 'postgres' || engine === 'oracle') && col.autoIncrement) s += ' GENERATED BY DEFAULT AS IDENTITY';
  if (engine === 'mssql' && col.autoIncrement) s += ' IDENTITY(1,1)';
  if (col.nullable === false) s += ' NOT NULL';
  if (col.default != null && !col.autoIncrement) s += ` DEFAULT ${col.default}`;
  if (mysql && col.autoIncrement) s += ' AUTO_INCREMENT';
  return s;
}
