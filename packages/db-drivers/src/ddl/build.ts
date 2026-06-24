/**
 * Dialect DDL builder. Returns an ARRAY of statements (each run separately — a
 * single ALTER may expand to several, and MySQL disallows multi-statement by
 * default). The structure editor shows `statements.join(';\n') + ';'` as the
 * preview and applies them in order.
 */
import { quoteIdent, quoteRelation } from '../sql/identifiers.js';
import type { DbEngine } from '../types.js';
import type { AlterTableSpec, ColumnSpec, CreateTableSpec, DdlOp, DdlSpec, DropTableSpec, ForeignKeySpec } from './spec.js';

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
        out.push(`ALTER TABLE ${rel} ADD COLUMN ${renderColumn(engine, action.column)}`);
        break;
      case 'dropColumn':
        out.push(`ALTER TABLE ${rel} DROP COLUMN ${quoteIdent(engine, action.name)}`);
        break;
      case 'renameColumn':
        out.push(`ALTER TABLE ${rel} RENAME COLUMN ${quoteIdent(engine, action.from)} TO ${quoteIdent(engine, action.to)}`);
        break;
      case 'modifyColumn':
        out.push(...renderModify(engine, rel, action.name, action.column));
        break;
      case 'renameTable':
        out.push(`ALTER TABLE ${rel} RENAME TO ${quoteIdent(engine, action.to)}`);
        break;
      case 'addIndex': {
        const cols = action.index.columns.map((c) => quoteIdent(engine, c)).join(', ');
        out.push(`CREATE ${action.index.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(engine, action.index.name)} ON ${rel} (${cols})`);
        break;
      }
      case 'dropIndex':
        // MySQL drops an index relative to its table; pg/sqlite drop it by (schema-qualified) name.
        if (engine === 'mysql' || engine === 'mariadb') out.push(`DROP INDEX ${quoteIdent(engine, action.name)} ON ${rel}`);
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

// ─── Shared column rendering ─────────────────────────────────────────────
function renderColumn(engine: DbEngine, col: ColumnSpec): string {
  assertSafeFragment(col.type);
  assertSafeFragment(col.default);
  const mysql = engine === 'mysql' || engine === 'mariadb';
  let s = `${quoteIdent(engine, col.name)} ${col.type}`;
  if (mysql && col.unsigned) s += ' UNSIGNED';
  if (engine === 'postgres' && col.autoIncrement) s += ' GENERATED BY DEFAULT AS IDENTITY';
  if (col.nullable === false) s += ' NOT NULL';
  if (col.default != null && !col.autoIncrement) s += ` DEFAULT ${col.default}`;
  if (mysql && col.autoIncrement) s += ' AUTO_INCREMENT';
  return s;
}
