import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function hasColumn(db: DB, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some((entry) => entry.name === column);
}

/**
 * Durable authority for non-idempotent master-prompt delivery.
 *
 * A process-local mutex prevents concurrent delivery only while that process
 * is alive. These columns preserve the reservation across a backend restart:
 * an unacknowledged `delivering`/`outcome_unknown` prompt must be reconciled,
 * never automatically replayed into the master.
 */
export const masterPromptDeliveryAuthority260: Migration = {
  version: 260,
  name: 'master_prompt_delivery_authority',
  up(db: DB): void {
    const table = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'company_master_prompts'`,
    ).get();
    if (!table) return;

    if (!hasColumn(db, 'company_master_prompts', 'delivery_status')) {
      db.exec(`
        ALTER TABLE company_master_prompts
        ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'pending'
          CHECK(delivery_status IN ('pending','delivering','outcome_unknown','delivered'))
      `);
    }
    if (!hasColumn(db, 'company_master_prompts', 'delivery_token')) {
      db.exec(`ALTER TABLE company_master_prompts ADD COLUMN delivery_token TEXT`);
    }
    if (!hasColumn(db, 'company_master_prompts', 'delivery_payload_hash')) {
      db.exec(`ALTER TABLE company_master_prompts ADD COLUMN delivery_payload_hash TEXT`);
    }
    if (!hasColumn(db, 'company_master_prompts', 'delivery_started_at')) {
      db.exec(`ALTER TABLE company_master_prompts ADD COLUMN delivery_started_at TEXT`);
    }
    if (!hasColumn(db, 'company_master_prompts', 'delivery_completed_at')) {
      db.exec(`ALTER TABLE company_master_prompts ADD COLUMN delivery_completed_at TEXT`);
    }

    // Existing answered prompts predate the delivery ledger and are already
    // terminal; they must never become claimable after the migration.
    db.exec(`
      UPDATE company_master_prompts
         SET delivery_status = 'delivered',
             delivery_completed_at = COALESCE(delivery_completed_at, resolved_at)
       WHERE status = 'answered' AND delivery_status = 'pending';

      CREATE INDEX IF NOT EXISTS idx_master_prompts_delivery_authority
        ON company_master_prompts(company_session_id, status, delivery_status);
    `);
  },
};
