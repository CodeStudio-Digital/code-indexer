/**
 * Migration 095 — `selected_skill_ids_json` column on coder_messages.
 *
 * Persists the list of skills the user manually pre-selected in the chat
 * sidebar at send time, decoupled from the message text itself. Before this
 * migration the picked skill bodies were concatenated into `content_json`
 * via an `<active_skills>` block, which left the user transcript bloated
 * with thousands of tokens of skill instructions on every turn.
 *
 * The new column stores a JSON array of skill IDs (e.g. `["unity-scene-audit",
 * "deploy-to-vercel"]`) or NULL when no picks were made. The runner reads
 * this on each turn, resolves the skill bodies fresh from the skill store,
 * and injects an `<active_skills>` block into the trailing user message at
 * `assembleMessagesForChat` time — same per-turn mechanism the
 * `<active-context>` block already uses. The block is never persisted, so
 * the message row stays small and the UI bubble shows only the user's text
 * plus a row of audit pills.
 *
 * Default NULL — pre-migration messages have no picks; the runner treats
 * a NULL column as "no skills injected for this turn" and behaves exactly
 * like the legacy path.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const coderMessageSelectedSkills095: Migration = {
  version: 95,
  name: 'coder_message_selected_skills',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'coder_messages', 'selected_skill_ids_json', 'TEXT');
  },
};
