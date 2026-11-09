import type { Migration } from './types.js';

export const structuralBuild273: Migration = {
  version: 273,
  name: 'structural_build_staging',
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS structural_build_chunks (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      generation TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY(project_id,generation,sequence)
    ) WITHOUT ROWID`);
  },
};
