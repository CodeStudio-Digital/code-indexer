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
