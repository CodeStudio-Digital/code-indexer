/**
 * Migration 122 — decoupled Builder sessions.
 *
 * A "Builder" session (the focused, V0-style frontend builder) is just a
 * regular `coder_sessions` row that additionally has a bound sandbox
 * container and runs the `builder` agent. The builder config — the
 * scaffold stack and whether studio instrumentation (element selection)
 * is on — lives in this JSON column. NULL means "not a builder session"
 * (the overwhelming majority of coder sessions).
 *
 *   builder_json = '{"stack":"react-ts","studio":true}'
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const coderBuilderConfig122: Migration = {
  version: 122,
  name: 'coder_builder_config',
  up: (db: DB): void => {
    db.exec(`ALTER TABLE coder_sessions ADD COLUMN builder_json TEXT;`);
  },
};
