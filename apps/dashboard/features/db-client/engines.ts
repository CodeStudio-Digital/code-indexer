/**
 * Engine registry for the database client. v1 ships PostgreSQL, MySQL/MariaDB
 * and SQLite (drivers bundled). Later engines (SQL Server, MongoDB, Redis,
 * Oracle) are listed but disabled until their drivers ship (P4).
 */
import type { DbEngine } from './types.js';

/** Engine category — drives which UI surface (tables/SQL vs documents vs key-value) renders. */
type EngineKind = 'relational' | 'document' | 'keyvalue';

interface EngineMeta {
  id: DbEngine;
  label: string;
  defaultPort?: number;
  /** SQLite-style file-path connection instead of host/port. */
  usesFile?: boolean;
  /** Available in this build (driver bundled). */
  available: boolean;
  /** Engine category — relational reuses the full tree/query/structure pipeline. */
  engineKind: EngineKind;
  /** Driver is fetched on demand (not bundled) — gate `available` by install status. */
  lazyDriver?: boolean;
}

const ENGINES: EngineMeta[] = [
  { id: 'postgres', label: 'PostgreSQL', defaultPort: 5432, available: true, engineKind: 'relational' },
  { id: 'mysql', label: 'MySQL', defaultPort: 3306, available: true, engineKind: 'relational' },
  { id: 'mariadb', label: 'MariaDB', defaultPort: 3306, available: true, engineKind: 'relational' },
  { id: 'sqlite', label: 'SQLite', usesFile: true, available: true, engineKind: 'relational' },
  { id: 'mssql', label: 'SQL Server', defaultPort: 1433, available: true, engineKind: 'relational' },
  { id: 'oracle', label: 'Oracle', defaultPort: 1521, available: true, engineKind: 'relational', lazyDriver: true },
  { id: 'mongodb', label: 'MongoDB', defaultPort: 27017, available: true, engineKind: 'document', lazyDriver: true },
  { id: 'redis', label: 'Redis', defaultPort: 6379, available: true, engineKind: 'keyvalue', lazyDriver: true },
];

export const AVAILABLE_ENGINES = ENGINES.filter((e) => e.available);

export function engineMeta(id: DbEngine): EngineMeta | undefined {
  return ENGINES.find((e) => e.id === id);
}

export function engineLabel(id: DbEngine): string {
  return engineMeta(id)?.label ?? id;
}

export function engineKindFor(id: DbEngine): EngineKind {
  return engineMeta(id)?.engineKind ?? 'relational';
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
    case 'mssql':
      return ['INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'BIT', 'NVARCHAR(255)', 'VARCHAR(255)', 'NVARCHAR(MAX)', 'NCHAR(10)', 'TEXT', 'DATE', 'DATETIME2', 'DATETIMEOFFSET', 'TIME', 'DECIMAL(18,2)', 'FLOAT', 'REAL', 'MONEY', 'UNIQUEIDENTIFIER', 'VARBINARY(MAX)'];
    case 'oracle':
      return ['NUMBER', 'NUMBER(10)', 'NUMBER(10,2)', 'VARCHAR2(255)', 'NVARCHAR2(255)', 'CHAR(10)', 'CLOB', 'NCLOB', 'DATE', 'TIMESTAMP', 'TIMESTAMP WITH TIME ZONE', 'FLOAT', 'BINARY_DOUBLE', 'BINARY_FLOAT', 'RAW(2000)', 'BLOB'];
    default:
      return [];
  }
}
