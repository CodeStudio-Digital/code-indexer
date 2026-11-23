import type { Migration } from './types.js';

export const projectAutoIndex288: Migration = {
  version: 288,
  name: 'project_auto_index',
  runsOnTrimmedProject: true,
  up(db) {
    if (!db.prepare("SELECT 1 FROM pragma_table_info('projects') WHERE name='auto_index_enabled'").get()) {
      db.exec('ALTER TABLE projects ADD COLUMN auto_index_enabled INTEGER NOT NULL DEFAULT 1 CHECK (auto_index_enabled IN (0,1))');
    }
  },
};
