import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const projectSettings027 = {
  version: 27,
  name: 'project_settings',
  up(db: DB): void {
    db.exec(`
      ALTER TABLE projects ADD COLUMN embeddings_enabled INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE projects ADD COLUMN search_mode TEXT NOT NULL DEFAULT 'hybrid';
    `);
  },
};
