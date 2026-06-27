import { describe, it, expect } from 'vitest';
import { buildSqliteRebuild, sqliteAlterNeedsRebuild } from '../ddl/build.js';
import type { TableInfo } from '../types.js';
import type { AlterTableSpec } from '../ddl/spec.js';

/**
 * Pure tests for the SQLite table-rebuild path (modify-column / FK changes that
 * SQLite can't do in place). No native module → not ABI-gated.
 */
const users: TableInfo = {
  schema: '',
  name: 'users',
  columns: [
    { name: 'id', dataType: 'INTEGER', nullable: false, isPrimaryKey: true, isAutoIncrement: true },
    { name: 'email', dataType: 'TEXT', nullable: true, isPrimaryKey: false },
    { name: 'age', dataType: 'TEXT', nullable: true, isPrimaryKey: false },
  ],
  indexes: [
    { name: 'idx_email', columns: ['email'], unique: true },
    { name: 'sqlite_autoindex_users_1', columns: ['id'], unique: true, primary: true },
  ],
  foreignKeys: [],
};

describe('sqliteAlterNeedsRebuild', () => {
  it('is true for modifyColumn / FK ops and false for native ones', () => {
    expect(sqliteAlterNeedsRebuild({ table: 'users', actions: [{ kind: 'modifyColumn', name: 'age', column: { name: 'age', type: 'INTEGER' } }] })).toBe(true);
    expect(sqliteAlterNeedsRebuild({ table: 'users', actions: [{ kind: 'addForeignKey', fk: { name: 'fk', columns: ['x'], refTable: 'y', refColumns: ['id'] } }] })).toBe(true);
    expect(sqliteAlterNeedsRebuild({ table: 'users', actions: [{ kind: 'addColumn', column: { name: 'x', type: 'TEXT' } }] })).toBe(false);
  });
});

describe('buildSqliteRebuild', () => {
  it('modify-column rebuilds via tmp table, copies data, drops, renames, recreates indexes', () => {
    const spec: AlterTableSpec = {
      table: 'users',
      actions: [{ kind: 'modifyColumn', name: 'age', column: { name: 'age', type: 'INTEGER', nullable: false, default: '0' } }],
    };
    const out = buildSqliteRebuild(users, spec);
    expect(out[0]).toBe('PRAGMA foreign_keys=OFF');
    expect(out[1]).toBe('BEGIN TRANSACTION');
    const create = out.find((s) => s.startsWith('CREATE TABLE')) as string;
    expect(create).toContain('"users__mcp_rebuild"');
    expect(create).toContain('"id" INTEGER PRIMARY KEY AUTOINCREMENT');
    expect(create).toContain('"age" INTEGER NOT NULL DEFAULT 0');
    // Data copy keeps every pre-existing column (new name → old name).
    const insert = out.find((s) => s.startsWith('INSERT INTO')) as string;
    expect(insert).toContain('("id", "email", "age")');
    expect(insert).toContain('SELECT "id", "email", "age" FROM "users"');
    expect(out).toContain('DROP TABLE "users"');
    expect(out).toContain('ALTER TABLE "users__mcp_rebuild" RENAME TO "users"');
    // The user index is recreated; the auto index is not.
    expect(out.some((s) => s.includes('CREATE UNIQUE INDEX "idx_email" ON "users" ("email")'))).toBe(true);
    expect(out.some((s) => s.includes('sqlite_autoindex'))).toBe(false);
    expect(out[out.length - 2]).toBe('COMMIT');
    expect(out[out.length - 1]).toBe('PRAGMA foreign_keys=ON');
  });

  it('rename-column remaps the data copy source and dependent index columns', () => {
    const spec: AlterTableSpec = {
      table: 'users',
      actions: [
        { kind: 'renameColumn', from: 'email', to: 'mail' },
        { kind: 'modifyColumn', name: 'age', column: { name: 'age', type: 'INTEGER' } },
      ],
    };
    const out = buildSqliteRebuild(users, spec);
    const insert = out.find((s) => s.startsWith('INSERT INTO')) as string;
    // New column is "mail", copied FROM the old "email".
    expect(insert).toContain('("id", "mail", "age")');
    expect(insert).toContain('SELECT "id", "email", "age" FROM "users"');
    expect(out.some((s) => s.includes('CREATE UNIQUE INDEX "idx_email" ON "users" ("mail")'))).toBe(true);
  });

  it('drop-column excludes the column from the copy and drops indexes on it', () => {
    const spec: AlterTableSpec = {
      table: 'users',
      actions: [
        { kind: 'dropColumn', name: 'email' },
        { kind: 'modifyColumn', name: 'age', column: { name: 'age', type: 'INTEGER' } },
      ],
    };
    const out = buildSqliteRebuild(users, spec);
    const insert = out.find((s) => s.startsWith('INSERT INTO')) as string;
    expect(insert).toContain('("id", "age")');
    expect(insert).not.toContain('email');
    // idx_email referenced the dropped column → not recreated.
    expect(out.some((s) => s.includes('idx_email'))).toBe(false);
  });

  it('adds a foreign key as an inline table constraint', () => {
    const spec: AlterTableSpec = {
      table: 'users',
      actions: [{ kind: 'addForeignKey', fk: { name: 'fk_org', columns: ['email'], refTable: 'orgs', refColumns: ['id'], onDelete: 'CASCADE' } }],
    };
    const create = buildSqliteRebuild(users, spec).find((s) => s.startsWith('CREATE TABLE')) as string;
    expect(create).toContain('CONSTRAINT "fk_org" FOREIGN KEY ("email") REFERENCES "orgs" ("id") ON DELETE CASCADE');
  });
});
