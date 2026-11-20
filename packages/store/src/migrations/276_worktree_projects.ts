import type { Migration } from './types.js';

export const worktreeProjects276: Migration = {
  version: 276,
  name: 'worktree_projects',
  runsOnTrimmedProject: true,
  up(db) {
    const columns = db.prepare('PRAGMA table_info(projects)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'worktree_parent_id')) {
      db.exec('ALTER TABLE projects ADD COLUMN worktree_parent_id INTEGER REFERENCES projects(id) ON DELETE CASCADE');
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_worktree
      ON projects(worktree_parent_id, root_path) WHERE worktree_parent_id IS NOT NULL`);
  },
};
