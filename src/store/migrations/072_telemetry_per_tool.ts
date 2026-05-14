/**
 * Migration 072 — Per-tool-call enrichment + cost/system-prompt fields on turn telemetry.
 *
 * Background: telemetry today captures aggregate per-turn data (069) and
 * per-tool-call basics (004). To answer "which tool burned the most tokens",
 * "are tool outputs getting truncated", "what fraction of input is the system
 * prompt vs history vs tools", and "what does this session actually cost in
 * USD", we need a few extra columns. All nullable/default — fully
 * backward-compatible.
 *
 * coder_tool_calls additions:
 *   - output_chars         materialized size of result_text at write time
 *   - truncated            1 if the bridge clamped the output (MCP_OUTPUT_HARD_CAP, READ_FILE_HARD_MAX)
 *   - phase                detected phase ('triage'|'search'|'plan'|'patch'|'finalize'|'review'),
 *                          populated by the PhaseRouter (Camada 2). Indexed for breakdowns.
 *   - turn_telemetry_id    FK to coder_turn_telemetry(id) for clean JOINs without
 *                          reconstructing via tool_use_id.
 *
 * coder_turn_telemetry additions:
 *   - system_prompt_chars  size of the system prompt in chars on this turn —
 *                          isolates the system-prompt slice of input. Proves Camada 3.
 *   - tools_def_chars      serialized tools array size sent to the provider —
 *                          the other big slice of input.
 *   - estimated_cost_usd   per-turn USD cost computed from model-registry pricing.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function columnExists(db: DB, table: string, column: string): boolean {
  const rows = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

export const telemetryPerTool072: Migration = {
  version: 72,
  name: 'telemetry_per_tool',
  up: (db: DB): void => {
    // coder_tool_calls — per-call enrichment
    if (!columnExists(db, 'coder_tool_calls', 'output_chars')) {
      db.exec(`ALTER TABLE coder_tool_calls ADD COLUMN output_chars INTEGER`);
    }
    if (!columnExists(db, 'coder_tool_calls', 'truncated')) {
      db.exec(`ALTER TABLE coder_tool_calls ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0`);
    }
    if (!columnExists(db, 'coder_tool_calls', 'phase')) {
      db.exec(`ALTER TABLE coder_tool_calls ADD COLUMN phase TEXT`);
    }
    if (!columnExists(db, 'coder_tool_calls', 'turn_telemetry_id')) {
      db.exec(`ALTER TABLE coder_tool_calls ADD COLUMN turn_telemetry_id INTEGER`);
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_coder_tool_calls_phase
        ON coder_tool_calls(phase);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_coder_tool_calls_turn_telemetry
        ON coder_tool_calls(turn_telemetry_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_coder_tool_calls_tool_name
        ON coder_tool_calls(tool_name);
    `);

    // coder_turn_telemetry — input breakdown + cost
    if (!columnExists(db, 'coder_turn_telemetry', 'system_prompt_chars')) {
      db.exec(`ALTER TABLE coder_turn_telemetry ADD COLUMN system_prompt_chars INTEGER`);
    }
    if (!columnExists(db, 'coder_turn_telemetry', 'tools_def_chars')) {
      db.exec(`ALTER TABLE coder_turn_telemetry ADD COLUMN tools_def_chars INTEGER`);
    }
    if (!columnExists(db, 'coder_turn_telemetry', 'estimated_cost_usd')) {
      db.exec(`ALTER TABLE coder_turn_telemetry ADD COLUMN estimated_cost_usd REAL`);
    }
  },
};
