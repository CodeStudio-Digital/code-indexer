import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
}

/**
 * Policy Engine + Capability Catalog persistence (Fase 2, shadow-only).
 *
 * All tables are additive. They exist so the Policy Engine can run in shadow
 * (recording decisions + comparisons vs. the legacy gate) and so resource
 * grants can be issued and consumed under compare-and-set — none of it is
 * enforced until a later human gate flips CODER_POLICY_ENGINE_ENFORCE.
 *
 * `policy_grants` intentionally has NO foreign key on session/command/run:
 * a grant is a portable capability that outlives the invocation that produced
 * it, and shadow rows may reference entities not present in this DB.
 *
 * Numbered 255 because 253/254 were already taken by unrelated migrations.
 */
export const policyEngine255: Migration = {
  version: 255,
  name: 'policy_engine',
  up(db: DB): void {
    // Policy tables are CENTRAL-only (∈ CENTRAL_DROP_TABLES) — decisions hang off
    // `coder_sessions`, which a per-project DB trims away. Mirrors migration 258.
    if (!tableExists(db, 'coder_sessions')) return;

    db.exec(`
      CREATE TABLE IF NOT EXISTS policy_decisions (
        decision_id TEXT PRIMARY KEY,
        session_id TEXT,
        legacy_session_id INTEGER REFERENCES coder_sessions(id) ON DELETE CASCADE,
        command_id TEXT,
        agent_run_id TEXT,
        tool_use_id TEXT,
        capability_id TEXT NOT NULL,
        capability_version TEXT NOT NULL,
        effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny', 'ask')),
        reason_code TEXT NOT NULL,
        explanation TEXT,
        precedence INTEGER NOT NULL DEFAULT 0,
        sources_json TEXT NOT NULL DEFAULT '[]',
        constraints_json TEXT NOT NULL DEFAULT '[]',
        requires_reevaluation INTEGER NOT NULL DEFAULT 0 CHECK (requires_reevaluation IN (0, 1)),
        effective_input_hash TEXT,
        policy_version TEXT NOT NULL,
        background INTEGER NOT NULL DEFAULT 0 CHECK (background IN (0, 1)),
        audit_json TEXT NOT NULL DEFAULT '{}',
        decided_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_policy_decisions_session_decided
        ON policy_decisions(session_id, decided_at DESC);
      CREATE INDEX IF NOT EXISTS idx_policy_decisions_capability
        ON policy_decisions(capability_id, decided_at DESC);

      CREATE TABLE IF NOT EXISTS policy_decision_comparisons (
        comparison_id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL REFERENCES policy_decisions(decision_id) ON DELETE CASCADE,
        session_id TEXT,
        capability_id TEXT NOT NULL,
        tool_use_id TEXT,
        legacy_effect TEXT NOT NULL CHECK (legacy_effect IN ('allow', 'block')),
        shadow_effect TEXT NOT NULL CHECK (shadow_effect IN ('allow', 'deny', 'ask')),
        agreement INTEGER NOT NULL CHECK (agreement IN (0, 1)),
        divergence_kind TEXT,
        critical INTEGER NOT NULL DEFAULT 0 CHECK (critical IN (0, 1)),
        detail TEXT,
        compared_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_policy_comparisons_agreement
        ON policy_decision_comparisons(agreement, compared_at DESC);
      CREATE INDEX IF NOT EXISTS idx_policy_comparisons_divergence
        ON policy_decision_comparisons(divergence_kind, compared_at DESC);

      CREATE TABLE IF NOT EXISTS policy_grants (
        grant_id TEXT PRIMARY KEY,
        decision_id TEXT,
        subject_json TEXT NOT NULL,
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        constraints_json TEXT NOT NULL DEFAULT '[]',
        duration TEXT NOT NULL CHECK (duration IN ('once', 'session', 'timeboxed', 'persistent')),
        binding_json TEXT,
        effective_input_hash TEXT,
        policy_version TEXT NOT NULL,
        nonce TEXT NOT NULL,
        consumption_status TEXT NOT NULL DEFAULT 'unconsumed'
          CHECK (consumption_status IN ('unconsumed', 'consumed', 'revoked')),
        consumed_by_tool_use_id TEXT,
        consumed_at TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT,
        CHECK (
          (duration = 'once' AND binding_json IS NOT NULL AND expires_at IS NOT NULL)
          OR (duration <> 'once')
        ),
        CHECK (
          (consumption_status = 'consumed' AND consumed_at IS NOT NULL)
          OR (consumption_status <> 'consumed')
        )
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_grants_nonce
        ON policy_grants(nonce);
      CREATE INDEX IF NOT EXISTS idx_policy_grants_consumption
        ON policy_grants(consumption_status, duration);

      CREATE TABLE IF NOT EXISTS capability_descriptors (
        capability_id TEXT NOT NULL,
        version TEXT NOT NULL,
        catalog_version TEXT NOT NULL,
        name TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        metadata_trust TEXT NOT NULL,
        descriptor_json TEXT NOT NULL,
        descriptor_hash TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (capability_id, version, catalog_version)
      );

      CREATE INDEX IF NOT EXISTS idx_capability_descriptors_catalog
        ON capability_descriptors(catalog_version);

      CREATE TABLE IF NOT EXISTS resolved_capability_sets (
        ref TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        catalog_version TEXT NOT NULL,
        agent_run_id TEXT,
        set_json TEXT NOT NULL,
        resolved_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_resolved_capability_sets_run
        ON resolved_capability_sets(agent_run_id, resolved_at DESC);
    `);
  },
};
