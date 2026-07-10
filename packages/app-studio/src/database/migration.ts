import { sqlHasStatements } from '../pipeline/gate-checks.js';

const FORBIDDEN_SQL = /\b(?:ATTACH|DETACH|VACUUM|PRAGMA\s+(?:writable_schema|journal_mode))\b/i;

export function normalizeMigrationSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

export function validateAppMigrationSql(sql: string): string | null {
  if (!sqlHasStatements(sql)) return 'sql must contain at least one SQL statement.';
  if (FORBIDDEN_SQL.test(sql)) return 'sql contains a command that is unsafe or unsupported in an App Studio D1 migration.';
  if (!/\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|TRIGGER|VIEW)\b/i.test(sql)) {
    return 'A schema migration must contain CREATE, ALTER or DROP for a table, index, trigger or view.';
  }
  return null;
}

export function nextMigrationFilename(existing: string[], name: string): string {
  const max = existing.reduce((value, filename) => {
    const match = /^(\d+)_/.exec(filename);
    return match ? Math.max(value, Number(match[1])) : value;
  }, 0);
  return `${String(max + 1).padStart(4, '0')}_${normalizeMigrationSlug(name)}.sql`;
}
