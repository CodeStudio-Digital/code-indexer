/**
 * Migration 026 — Track last-turn input tokens for context window display.
 *
 * The cumulative total_input_tokens grows quadratically because each API turn
 * re-sends the full conversation history. This column stores the most recent
 * turn's input_tokens so the UI can show actual context-window usage (e.g.
 * "180k / 200k") instead of the misleading cumulative sum.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const lastTurnTokens026 = {
  version: 26,
  name: 'last_turn_tokens',
  up(db: DB) {
    db.exec(`
      ALTER TABLE coder_sessions
        ADD COLUMN last_turn_input_tokens INTEGER NOT NULL DEFAULT 0;
    `);
  },
};
