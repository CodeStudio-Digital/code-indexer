import type { Migration } from './index.js';

export const appStudioProductModel212: Migration = {
  version: 212,
  name: 'app_studio_product_model',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_studio_product_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_session_id INTEGER NOT NULL REFERENCES app_studio_sessions(id) ON DELETE CASCADE,
        base_revision_id INTEGER REFERENCES app_studio_product_revisions(id) ON DELETE SET NULL,
        base_spec_revision_id INTEGER REFERENCES app_studio_spec_revisions(id) ON DELETE SET NULL,
        result_spec_revision_id INTEGER REFERENCES app_studio_spec_revisions(id) ON DELETE SET NULL,
        revision_number INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('draft','approved','superseded','rejected')) DEFAULT 'draft',
        complexity TEXT NOT NULL CHECK(complexity IN ('simple','standard','complex','very-complex')),
        research_fingerprint TEXT NOT NULL DEFAULT '',
        product_json TEXT NOT NULL,
        created_by TEXT NOT NULL DEFAULT 'agent',
        coder_session_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        approved_at TEXT,
        UNIQUE(app_session_id, revision_number)
      );
      CREATE INDEX IF NOT EXISTS idx_app_studio_product_session
        ON app_studio_product_revisions(app_session_id, revision_number DESC);
      CREATE INDEX IF NOT EXISTS idx_app_studio_product_spec
        ON app_studio_product_revisions(base_spec_revision_id, result_spec_revision_id);
    `);
  },
};
