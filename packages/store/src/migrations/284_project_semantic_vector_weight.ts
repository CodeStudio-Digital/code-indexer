import type { Migration } from './types.js';

export const projectSemanticVectorWeight284: Migration = {
  version: 284,
  name: 'project_semantic_vector_weight',
  scope: 'central',
  up(db) {
    db.exec('ALTER TABLE projects ADD COLUMN semantic_vector_weight REAL NOT NULL DEFAULT 1 CHECK (semantic_vector_weight > 0)');
  },
};
