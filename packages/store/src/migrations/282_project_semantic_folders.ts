import type { Migration } from './types.js';

export const projectSemanticFolders282: Migration = {
  version: 282,
  name: 'project_semantic_folders',
  scope: 'central',
  up(db) {
    db.exec(`
      ALTER TABLE projects ADD COLUMN semantic_index_folders TEXT NOT NULL DEFAULT '[]';
      UPDATE projects SET semantic_index_folders = '["."]'
      WHERE EXISTS (
        SELECT 1 FROM semantic_namespace_generations n
        WHERE n.namespace = 'code:p' || projects.id
          AND (n.active_generation_id IS NOT NULL OR n.building_generation_id IS NOT NULL)
      ) OR EXISTS (
        SELECT 1 FROM semantic_jobs j
        WHERE j.namespace = 'semantic:reindex:code:p' || projects.id
          AND j.status IN ('pending', 'running', 'paused')
      );
    `);
  },
};
