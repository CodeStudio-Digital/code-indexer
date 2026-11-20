import type { Migration } from './types.js';

export const projectSemanticTargets283: Migration = {
  version: 283,
  name: 'project_semantic_targets',
  scope: 'central',
  up(db) {
    db.exec(`CREATE TABLE project_semantic_targets (
      project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      embedding_target TEXT NOT NULL,
      reranker_target TEXT NOT NULL
    )`);
  },
};
