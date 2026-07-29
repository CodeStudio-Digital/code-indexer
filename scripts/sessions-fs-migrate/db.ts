import { createRequire } from 'node:module';
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import type DatabaseConstructor from 'better-sqlite3';
import type { SqliteDatabase } from './model.js';

const localRequire = createRequire(import.meta.url);

export function loadDatabaseConstructor(): typeof DatabaseConstructor {
  return localRequire('better-sqlite3') as typeof DatabaseConstructor;
}

export function openDatabase(
  path: string,
  options: { readonly?: boolean; fileMustExist?: boolean } = {},
): SqliteDatabase {
  const Database = loadDatabaseConstructor();
  const db = new Database(path, {
    readonly: options.readonly ?? false,
    fileMustExist: options.fileMustExist ?? true,
    timeout: 30_000,
  });
  db.pragma('busy_timeout = 30000');
  if (!options.readonly) db.pragma('foreign_keys = ON');
  return db;
}

export function tableExists(db: SqliteDatabase, table: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(table));
}

export function tableColumns(db: SqliteDatabase, table: string): string[] {
  if (!tableExists(db, table)) return [];
  return (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
    .map((row) => row.name);
}

export function tableRowCount(db: SqliteDatabase, table: string, whereSql?: string): number {
  if (!tableExists(db, table)) return 0;
  const where = whereSql ? ` WHERE ${whereSql}` : '';
  const row = db.prepare(`SELECT COUNT(1) AS count FROM "${table}"${where}`).get() as {
    count: number | bigint;
  };
  return Number(row.count);
}

export function quoteIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`unsafe SQLite identifier: ${value}`);
  }
  return `"${value}"`;
}

export function checkpointWal(db: SqliteDatabase): void {
  const rows = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{
    busy?: number;
    log?: number;
    checkpointed?: number;
  }>;
  if (rows.some((row) => Number(row.busy ?? 0) !== 0)) {
    throw new Error(`WAL checkpoint could not acquire an exclusive checkpoint: ${JSON.stringify(rows)}`);
  }
}

export function assertDatabaseIntegrity(db: SqliteDatabase): void {
  const integrity = db.pragma('integrity_check') as Array<Record<string, unknown>>;
  const messages = integrity.flatMap((row) => Object.values(row).map(String));
  if (messages.length !== 1 || messages[0].toLowerCase() !== 'ok') {
    throw new Error(`SQLite integrity_check failed: ${JSON.stringify(integrity.slice(0, 20))}`);
  }
  const foreignKeys = db.pragma('foreign_key_check') as unknown[];
  if (foreignKeys.length > 0) {
    throw new Error(`SQLite foreign_key_check failed: ${JSON.stringify(foreignKeys.slice(0, 20))}`);
  }
}

/**
 * Stable source identity for resume protection. Apply mode checkpoints WAL
 * first, then hashes the complete main database. File mtimes are deliberately
 * excluded: a no-op checkpoint/open may change metadata without changing the
 * source rows and must not fork a second UUID map.
 */
export function databaseFingerprint(path: string): string {
  if (!existsSync(path)) throw new Error(`database does not exist: ${path}`);
  const fd = openSync(path, 'r');
  try {
    const stats = fstatSync(fd);
    const hash = createHash('sha256').update(`sqlite-bytes:${stats.size}\0`);
    const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

export function dbFileBytes(path: string): number {
  return statSync(path).size
    + (existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0)
    + (existsSync(`${path}-shm`) ? statSync(`${path}-shm`).size : 0);
}
