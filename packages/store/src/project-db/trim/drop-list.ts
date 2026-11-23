/**
 * The CENTRAL tables to DROP from a per-project DB (C2 trim).
 *
 * The project DB is built from the full central schema (initSchema + runMigrations)
 * so it inherits ~110 central-only tables it never uses. Two mechanisms remove them:
 *
 *  1. `CENTRAL_DROP_TABLES` — the DECLARED list. Dropped unconditionally, rows and
 *     all. It is also the contract migrations cite when they add a `tableExists`
 *     guard, and it carries RETIRED tables the current schema no longer creates but
 *     old project DBs still have.
 *  2. `centralTablesIn` — a DERIVED sweep for whatever the declared list missed.
 *     The project KEEP set (the db-split copy manifest) is the single source of
 *     truth for what a project DB may hold: only manifest tables are copied by the
 *     split or bound to `projectScopedDb`, so a table outside it can never
 *     legitimately hold project rows. The sweep only touches EMPTY tables — an
 *     unknown table WITH rows means something wrote to it, so it is left alone
 *     (a missing manifest entry is a bug to fix, not data to delete silently).
 *
 * The declared list had drifted by 18 tables (migrations 240-259) before the sweep
 * existed; the sweep is what makes that drift self-correcting instead of permanent
 * dead weight in every project DB. `assertDisjointFromProject` guards that the
 * declared list never overlaps a project (manifest) table.
 */
import type { DB } from '../../db/types.js';
import { INDEX_TABLES, FEATURE_TABLES } from '../../db-split/manifest.js';

/** External-content FTS vtabs over CENTRAL base tables — dropped before the base
 *  (DROP on the vtab removes its shadow tables). The KEPT code FTS (files_fts/
 *  symbols_fts/file_contents_fts) are NOT here. */
export const CENTRAL_FTS_VTABS = [
  'snapshots_fts', 'doc_chunks_fts', 'coder_session_chapters_fts', 'agent_memory_fts',
] as const;

/**
 * Central tables present in the full schema but never used by a project DB.
 *
 * CONVENTION: any migration that mutates one of these tables (ADD COLUMN, CREATE
 * INDEX, INSERT, …) MUST guard with `tableExists(db, table)` and no-op when absent.
 * A project DB runs the full central migration lineage but trims these tables
 * away, so on upgrade a fresh central-table migration runs against a DB where the
 * table is already gone — an unguarded statement throws `no such table` and
 * crash-loops the boot. See migration 175 (and the guarded helper in mig 065).
 */
export const CENTRAL_DROP_TABLES: readonly string[] = [
  // session runtime + telemetry (central per the final scope decision)
  'coder_sessions', 'coder_messages', 'coder_session_chapters', 'coder_plans', 'coder_tasks_state', 'coder_tool_calls',
  'coder_turn_telemetry', 'coder_investigations', 'coder_session_inputs', 'coder_session_memory',
  'coder_subagent_runs', 'coder_subagent_tool_calls',
  'coder_phase_profiles', 'coder_session_groups', 'coder_task_runs', 'coder_task_run_items',
  'coder_session_index', 'coder_session_projects',
  'session_events', 'coder_compaction_attempts',
  // per-session runtime added after the v2 trim (migrations 249/253/258/259) — all
  // keyed on coder_sessions(id), which is itself central.
  'coder_session_filesystem_roots', 'coder_provider_attempts',
  'coder_pending_agent_transitions', 'coder_orchestration_checkpoints',
  'session_file_baselines', 'session_file_edits', 'session_file_hunk_decisions',
  'session_file_round_snapshots', 'session_file_round_hunk_decisions',
  'session_file_round_review_findings',
  'session_file_review_comments', 'session_file_review_runs', 'session_disabled_tools',
  'session_intent_contracts', 'review_comment_fates',
  // stats (central per Etapa A)
  'runs', 'costs', 'project_cost_rollup',
  // user/project snapshots (central) + memory control plane
  'snapshots', 'snapshot_files', 'snapshot_versions', 'memory_distill_log',
  'agent_memory', 'agent_memory_events',
  // company + kanban
  'company_sessions', 'company_session_projects', 'company_session_envs',
  // tabela aposentada na migration 191 — manter 1 release p/ DBs antigos que ainda a tenham
  'company_session_databases',
  'company_session_archives', 'company_sandboxes', 'company_sandbox_services', 'company_templates',
  'company_board', 'company_drive_files', 'company_local_projects', 'company_fronts', 'company_agent_runs',
  'company_service_transitions', 'company_service_logs',
  'kanban_cards', 'kanban_card_agents', 'kanban_card_dependencies', 'kanban_checklist_items', 'kanban_comments',
  // Retired feature tables may remain in older project databases.
  'design_system_sessions', 'design_system_versions', 'design_system_components',
  // counterfactual
  'counterfactual_logs',
  // docs corpus (global)
  'doc_collections', 'doc_sources', 'doc_chunks', 'doc_chunk_vectors', 'doc_vector_tombstones',
  'doc_rerank_cache', 'docs_research_sessions', 'doc_source_items', 'doc_enrichment_cache',
  'doc_search_events', 'doc_ingest_runs',
  // agents / supervision
  'agent_inbox', 'agent_board_watermarks', 'agent_supervision', 'agent_supervision_incidents',
  'sub_agent_result_cache',
  // providers / auth / mcp / models (global config)
  'provider_configs', 'provider_models', 'oauth_clients', 'oauth_auth_codes', 'oauth_tokens',
  'model_catalog_revision', 'model_catalog_embeddings',
  'oauth_refresh_tokens', 'mcp_server_configs', 'mcp_server_tools', 'mcp_oauth_registrations',
  'mcp_oauth_tokens', 'mcp_oauth_pending', 'embedding_configs', 'embedding_store_configs',
  'vector_store_configs', 'reranker_configs', 'model_prices', 'models_cache', 'api_tokens',
  'semantic_profiles', 'semantic_model_catalog', 'semantic_generations',
  'semantic_namespace_generations', 'semantic_items', 'semantic_jobs',
  'auth_audit_log', 'app_settings', 'company_master_prompts',
  // skills / plugins / misc global
  'skill_definitions', 'skill_session_config', 'skill_usage_log', 'chrome_service_configs',
  'sprite_projects', 'sprite_assets', 'sprite_asset_versions', 'sprite_references',
  'sprite_generation_jobs', 'sprite_animations', 'sprite_frames', 'ssh_secrets',
  'installed_plugins', 'plugin_storage', 'verdaccio_configs', 'disabled_tools_global',
  // guided App Studio lives in the central product DB, never in code-index DBs
  'app_studio_plan_revisions', 'app_studio_deployments', 'app_studio_decisions', 'app_studio_events',
  'app_studio_workflow_snapshots', 'app_studio_delivery_blueprints', 'app_studio_work_items', 'app_studio_work_item_runs',
  'app_studio_approvals', 'app_studio_decision_requests', 'app_studio_workflow_events',
  'app_studio_build_task_evidence', 'app_studio_build_groups', 'app_studio_wireframe_revisions', 'app_studio_ux_revisions', 'app_studio_product_revisions',
  'app_studio_pipeline_repairs', 'app_studio_architecture_revisions', 'app_studio_evolutions', 'app_studio_spec_revisions',
  'app_studio_features', 'app_studio_sessions',
  // QA + pipeline global bindings/telemetry (company-scoped)
  'qa_test_runs', 'qa_test_results', 'pipeline_provider_bindings', 'pipeline_telemetry',
  // MCP connection profiles + async MCP-owned agent runs (240) — global control
  // plane, keyed on api_tokens/principal. `mcp_agent_runs.project_id` is a plain
  // tag on a central row, NOT project scoping (no FK, never copied by the split).
  'mcp_connection_profiles', 'mcp_agent_runs',
  // control plane (251/252/255/256/257) — session/command/run journal, its
  // projection cursors, and the policy/capability catalog. Every row hangs off a
  // control_plane_sessions/coder_sessions id, both central.
  'control_plane_sessions', 'session_commands', 'agent_runs', 'agent_run_attempts',
  'runtime_events', 'runtime_projection_cursors', 'control_plane_divergences',
  'policy_decisions', 'policy_decision_comparisons', 'policy_grants',
  'capability_descriptors', 'resolved_capability_sets',
];

/**
 * Code FTS vtabs that BELONG to the project DB — they and their shadow tables
 * (`<name>_data` / `_idx` / `_content` / `_docsize` / `_config`) survive the trim.
 */
export const PROJECT_FTS_VTABS = ['files_fts', 'symbols_fts', 'file_contents_fts', 'file_paths_fts'] as const;

const PROJECT_FTS_RE = new RegExp(`^(${PROJECT_FTS_VTABS.join('|')})(_[a-z]+)?$`);

/** True for a kept code FTS vtab or one of its shadow tables. */
export function isProjectFts(name: string): boolean { return PROJECT_FTS_RE.test(name); }

function isEmpty(db: DB, table: string): boolean {
  try { return !db.prepare(`SELECT 1 FROM "${table}" LIMIT 1`).get(); }
  catch { return false; } // unreadable/corrupt — leave it alone
}

/**
 * Everything THIS db must lose: the declared list, plus the derived sweep of empty
 * tables outside the project KEEP set (see the header). Virtual tables come first
 * so a central FTS vtab is dropped before anything else — its shadow tables go with
 * it, which is why they are never swept on their own.
 */
export function centralTablesIn(db: DB): string[] {
  const keep = projectKeepTables();
  const declared = new Set<string>(CENTRAL_DROP_TABLES);
  const rows = db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  ).all() as Array<{ name: string; sql: string | null }>;
  const vtabs = rows.filter((r) => /^\s*CREATE\s+VIRTUAL\b/i.test(r.sql ?? '')).map((r) => r.name);
  const isShadow = (n: string): boolean => vtabs.some((v) => n.startsWith(`${v}_`));

  const sweptVtabs: string[] = [];
  const sweptTables: string[] = [];
  for (const { name } of rows) {
    if (declared.has(name) || keep.has(name) || isProjectFts(name)) continue;
    if (vtabs.includes(name)) sweptVtabs.push(name);
    else if (!isShadow(name) && isEmpty(db, name)) sweptTables.push(name);
  }
  return [...sweptVtabs, ...CENTRAL_DROP_TABLES, ...sweptTables];
}

/** Project tables (from the copy manifest) + infra that MUST survive the trim. */
export function projectKeepTables(): Set<string> {
  // Revisions are derived by triggers while copying files; never copy an old generation.
  const keep = new Set<string>(['projects', 'schema_version', 'sqlite_sequence', 'project_db_meta', 'structural_revisions', 'structural_build_chunks']);
  for (const e of [...INDEX_TABLES, ...FEATURE_TABLES]) keep.add(e.table);
  return keep;
}

/** Throw if the drop-list overlaps a project table (guards a classification slip). */
export function assertDisjointFromProject(): void {
  const keep = projectKeepTables();
  const overlap = CENTRAL_DROP_TABLES.filter((t) => keep.has(t));
  if (overlap.length > 0) {
    throw new Error(`[project-db/trim] drop-list overlaps project tables: ${overlap.join(', ')}`);
  }
}
