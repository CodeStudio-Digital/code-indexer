/**
 * Migration 195 — append-only session event log (Codex parity).
 *
 * We have isolated append-only audit tables (`company_service_transitions`
 * mig 188, `session_file_edits` mig 79) but no generalized session-level event
 * trail for replay/debugging/compliance. Codex keeps an append-only rollout
 * (`.referece/codex/codex-rs/rollout/src/recorder.rs`) separate from queryable
 * state. This is the queryable half: one row per notable session event.
 *
 * Schema mirrors `company_service_transitions` (mig 188): a small, generic
 * (kind, from_state → to_state, reason, actor, at_ms) shape. `kind` is TEXT
 * without a CHECK on purpose — the event vocabulary evolves in application code.
 * No FK to `coder_sessions`: the trail must survive session-row cleanup.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const sessionEvents195: Migration = {
  version: 195,
  name: 'session_events',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  INTEGER NOT NULL,
        kind        TEXT NOT NULL,
        from_state  TEXT,
        to_state    TEXT,
        reason      TEXT,
        actor       TEXT NOT NULL,
        at_ms       INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_events_session_kind
        ON session_events(session_id, kind, at_ms DESC);
    `);
  },
};
