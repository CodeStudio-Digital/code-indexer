import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { masterPrompts032 } from '../032_master_prompts.js';
import { masterPromptDeliveryAuthority260 } from '../260_master_prompt_delivery_authority.js';

describe('migration 260 - master prompt delivery authority', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE company_sessions (id INTEGER PRIMARY KEY)`);
    masterPrompts032.up(db);
  });

  it('adds a durable delivery ledger and backfills answered prompts as delivered', () => {
    db.exec(`
      INSERT INTO company_sessions (id) VALUES (1);
      INSERT INTO company_master_prompts (
        company_session_id, kind, body, status, answer, resolved_at
      ) VALUES (1, 'question', 'why?', 'answered', 'because', datetime('now'));
    `);

    masterPromptDeliveryAuthority260.up(db);

    expect(db.prepare(`
      SELECT delivery_status, delivery_token, delivery_payload_hash
        FROM company_master_prompts
    `).get()).toEqual({
      delivery_status: 'delivered',
      delivery_token: null,
      delivery_payload_hash: null,
    });
  });

  it('is idempotent for rolling/partial fixtures', () => {
    masterPromptDeliveryAuthority260.up(db);
    expect(() => masterPromptDeliveryAuthority260.up(db)).not.toThrow();
  });
});
