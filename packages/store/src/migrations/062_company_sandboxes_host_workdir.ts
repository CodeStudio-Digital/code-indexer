import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

function hasColumn(db: DB, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

export const companySandboxesHostWorkdir062 = {
  version: 62,
  name: 'company_sandboxes_host_workdir',
  up(db: DB) {
    if (!hasColumn(db, 'company_sandboxes', 'host_workdir_mount')) {
      db.exec(`ALTER TABLE company_sandboxes ADD COLUMN host_workdir_mount TEXT`);
    }
  },
};
