/**
 * Engine registry for the database client. v1 ships PostgreSQL, MySQL/MariaDB
 * and SQLite (drivers bundled). Later engines (SQL Server, MongoDB, Redis,
 * Oracle) are listed but disabled until their drivers ship (P4).
 */
import type { DbEngine } from './types.js';

export interface EngineMeta {
  id: DbEngine;
  label: string;
  defaultPort?: number;
  /** SQLite-style file-path connection instead of host/port. */
  usesFile?: boolean;
  /** Available in this build (driver bundled). */
  available: boolean;
}

export const ENGINES: EngineMeta[] = [
  { id: 'postgres', label: 'PostgreSQL', defaultPort: 5432, available: true },
  { id: 'mysql', label: 'MySQL', defaultPort: 3306, available: true },
  { id: 'mariadb', label: 'MariaDB', defaultPort: 3306, available: true },
  { id: 'sqlite', label: 'SQLite', usesFile: true, available: true },
  { id: 'mssql', label: 'SQL Server', defaultPort: 1433, available: false },
  { id: 'mongodb', label: 'MongoDB', defaultPort: 27017, available: false },
  { id: 'redis', label: 'Redis', defaultPort: 6379, available: false },
  { id: 'oracle', label: 'Oracle', defaultPort: 1521, available: false },
];

export const AVAILABLE_ENGINES = ENGINES.filter((e) => e.available);

export function engineMeta(id: DbEngine): EngineMeta | undefined {
  return ENGINES.find((e) => e.id === id);
}

export function engineLabel(id: DbEngine): string {
  return engineMeta(id)?.label ?? id;
}

/** Common column types per engine — populate the structure editor's type dropdown (free-text still allowed). */
export function commonTypes(id: DbEngine): string[] {
  switch (id) {
    case 'postgres':
      return ['integer', 'bigint', 'smallint', 'serial', 'bigserial', 'text', 'varchar(255)', 'char(10)', 'boolean', 'date', 'timestamp', 'timestamptz', 'numeric(10,2)', 'real', 'double precision', 'json', 'jsonb', 'uuid', 'bytea'];
    case 'mysql':
    case 'mariadb':
      return ['INT', 'BIGINT', 'TINYINT', 'SMALLINT', 'VARCHAR(255)', 'TEXT', 'CHAR(10)', 'BOOLEAN', 'DATE', 'DATETIME', 'TIMESTAMP', 'DECIMAL(10,2)', 'FLOAT', 'DOUBLE', 'JSON', 'BLOB', 'ENUM'];
    case 'sqlite':
      return ['INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC'];
    default:
      return [];
  }
}
