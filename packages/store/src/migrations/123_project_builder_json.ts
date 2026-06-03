/**
 * Migration 123 — Builder projects.
 *
 * A "Builder project" is a normal host project (real `root_path` on disk)
 * that was scaffolded as a V0-style frontend builder: React+Vite+Tailwind+
 * shadcn pre-instrumented with the element-selection source-stamp. The
 * builder config — the scaffold stack and the dev-server port we pinned in
 * its vite.config — lives in this JSON column. NULL means "not a builder
 * project" (the vast majority).
 *
 *   builder_json = '{"stack":"react-ts","port":5180}'
 *
 * The project view reads it to (a) render the live-preview pane beside the
 * chat and (b) default the chat agent to `builder`.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const projectBuilderJson123: Migration = {
  version: 123,
  name: 'project_builder_json',
  up: (db: DB): void => {
    db.exec(`ALTER TABLE projects ADD COLUMN builder_json TEXT;`);
  },
};
