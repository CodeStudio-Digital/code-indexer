/**
 * Exhaustive, explicit SQLite disposition contract for the big-bang cut.
 *
 * Never infer session tables from a name pattern. A schema table that is not
 * declared here is treated as essential and is left untouched. The fresh-schema
 * guard separately rejects newly introduced session-scoped tables/columns.
 */
export interface DropTableDisposition {
  kind: 'drop';
  table: string;
  exportOwner: 'coder' | 'company' | 'app_studio' | 'sprite' | 'design';
}

export interface DeleteRowsDisposition {
  kind: 'delete_rows';
  table: string;
  whereSql: string;
  /**
   * Columns required to evaluate whereSql on legacy per-project schemas.
   * Central migration schemas are current, but project DBs can predate a
   * mixed-table discriminator.
   */
  predicateColumns?: readonly string[];
  /**
   * Explicitly declares that an older schema without predicateColumns cannot
   * contain matching rows. Missing columns otherwise fail closed.
   */
  missingPredicateMeansNoMatch?: boolean;
  dropColumns?: readonly string[];
  reason: string;
}

export interface PostCutRowGuard {
  table: string;
  whereSql: string;
  insertWhenSql: string;
  updateWhenSql: string;
  predicateColumns?: readonly string[];
  missingPredicateMeansNoMatch?: boolean;
}

export type TableDisposition = DropTableDisposition | DeleteRowsDisposition;

export interface SessionOrphanParentRule {
  kind: 'session';
  column: string;
  sessionKind: 'coder' | 'company' | 'app_studio' | 'sprite';
  when?: {
    column: string;
    values: readonly string[];
  };
}

export interface EncodedSessionOrphanParentRule {
  kind: 'encoded_session';
  column: string;
  prefix: string;
  sessionKind: 'coder' | 'company' | 'app_studio' | 'sprite';
}

export interface RecordOrphanParentRule {
  kind: 'record';
  column: string;
  targetTable: string;
  targetColumn: string;
}

export interface InverseRecordOrphanParentRule {
  kind: 'inverse_record';
  column: string;
  sourceTable: string;
  sourceColumn: string;
}

export interface RootlessOrphanParentRule {
  kind: 'rootless';
  columns: readonly string[];
}

export type LegacyOrphanParentRule =
  | SessionOrphanParentRule
  | EncodedSessionOrphanParentRule
  | RecordOrphanParentRule
  | InverseRecordOrphanParentRule
  | RootlessOrphanParentRule;

export interface LegacyOrphanCleanupDisposition {
  table: string;
  /** Ordered authoritative ownership parents; later entries are fallbacks. */
  parents: readonly LegacyOrphanParentRule[];
  reason: string;
}

const coderTables = [
  'coder_sessions',
  'coder_messages',
  'coder_tool_calls',
  'coder_session_chapters',
  'coder_plans',
  'coder_tasks_state',
  'coder_turn_telemetry',
  'coder_session_inputs',
  'coder_session_memory',
  'coder_subagent_runs',
  'coder_subagent_tool_calls',
  'coder_session_groups',
  'coder_task_runs',
  'coder_task_run_items',
  'coder_session_index',
  'coder_session_projects',
  'coder_session_filesystem_roots',
  'coder_provider_attempts',
  'coder_pending_agent_transitions',
  'coder_orchestration_checkpoints',
  'coder_session_chapters_fts',
  'coder_session_chapters_fts_config',
  'coder_session_chapters_fts_data',
  'coder_session_chapters_fts_docsize',
  'coder_session_chapters_fts_idx',
  'session_events',
  'coder_compaction_attempts',
  'session_file_baselines',
  'session_file_edits',
  'session_file_hunk_decisions',
  'session_file_round_snapshots',
  'session_file_round_hunk_decisions',
  'session_file_round_review_findings',
  'session_file_review_comments',
  'session_file_review_runs',
  'session_disabled_tools',
  'session_intent_contracts',
  'review_comment_fates',
  'skill_session_config',
  'skill_usage_log',
  'control_plane_sessions',
  'session_commands',
  'agent_runs',
  'agent_run_attempts',
  'runtime_events',
  'runtime_projection_cursors',
  'control_plane_divergences',
  'policy_decisions',
  'policy_decision_comparisons',
  'policy_grants',
  'resolved_capability_sets',
  'mcp_agent_runs',
] as const;

const companyTables = [
  'company_sessions',
  'company_session_projects',
  'company_session_envs',
  'company_session_databases',
  'company_session_archives',
  'company_sandboxes',
  'company_sandbox_services',
  'company_board',
  'company_local_projects',
  'company_fronts',
  'company_agent_runs',
  'company_service_transitions',
  'company_service_logs',
  'company_master_prompts',
  'kanban_cards',
  'kanban_card_agents',
  'kanban_card_dependencies',
  'kanban_checklist_items',
  'kanban_comments',
  'agent_inbox',
  'agent_board_watermarks',
  'agent_supervision',
  'agent_supervision_incidents',
  'qa_test_runs',
  'qa_test_results',
  'docs_research_sessions',
] as const;

const designTables = [
  'design_system_sessions',
  'design_system_versions',
  'design_system_components',
] as const;

const appStudioTables = [
  'app_studio_sessions',
  'app_studio_features',
  'app_studio_spec_revisions',
  'app_studio_evolutions',
  'app_studio_architecture_revisions',
  'app_studio_pipeline_repairs',
  'app_studio_product_revisions',
  'app_studio_ux_revisions',
  'app_studio_wireframe_revisions',
  'app_studio_build_groups',
  'app_studio_build_task_evidence',
  'app_studio_plan_revisions',
  'app_studio_deployments',
  'app_studio_decisions',
  'app_studio_events',
  'app_studio_workflow_snapshots',
  'app_studio_delivery_blueprints',
  'app_studio_work_items',
  'app_studio_work_item_runs',
  'app_studio_approvals',
  'app_studio_decision_requests',
  'app_studio_workflow_events',
] as const;

const spriteTables = [
  'sprite_projects',
  'sprite_assets',
  'sprite_asset_versions',
  'sprite_references',
  'sprite_generation_jobs',
  'sprite_animations',
  'sprite_frames',
] as const;

export const TABLE_DISPOSITIONS: readonly TableDisposition[] = [
  ...coderTables.map((table) => ({ kind: 'drop' as const, table, exportOwner: 'coder' as const })),
  ...companyTables.map((table) => ({ kind: 'drop' as const, table, exportOwner: 'company' as const })),
  ...designTables.map((table) => ({ kind: 'drop' as const, table, exportOwner: 'design' as const })),
  ...appStudioTables.map((table) => ({ kind: 'drop' as const, table, exportOwner: 'app_studio' as const })),
  ...spriteTables.map((table) => ({ kind: 'drop' as const, table, exportOwner: 'sprite' as const })),
  {
    kind: 'delete_rows',
    table: 'coder_investigations',
    whereSql: 'project_id IS NULL AND session_id IS NOT NULL',
    dropColumns: ['session_id'],
    reason: 'project investigation ledger rows remain reusable; only truly session-only rows move to a bundle',
  },
  {
    kind: 'delete_rows',
    table: 'pipeline_provider_bindings',
    whereSql: "scope_type = 'session'",
    reason: 'global and template bindings remain; session overrides move to the owning bundle',
  },
  {
    kind: 'delete_rows',
    table: 'company_drive_files',
    whereSql: "scope_key LIKE 'ses:%'",
    dropColumns: ['owner_agent_run_id'],
    reason: 'template drive metadata remains reusable; per-session drive files move to the Company bundle',
  },
  {
    kind: 'delete_rows',
    table: 'agent_memory_events',
    whereSql: 'session_id IS NOT NULL',
    dropColumns: ['session_id'],
    reason: 'project/global memory telemetry remains; session telemetry moves to metrics/events in the bundle',
  },
  {
    kind: 'delete_rows',
    table: 'pipeline_telemetry',
    whereSql: 'session_id IS NOT NULL OR company_session_id IS NOT NULL',
    dropColumns: ['session_id', 'company_session_id'],
    reason: 'session and Company execution metrics move to bundle metrics; unrelated global telemetry remains',
  },
  {
    kind: 'delete_rows',
    table: 'sub_agent_result_cache',
    whereSql: 'session_id IS NOT NULL',
    dropColumns: ['session_id'],
    reason: 'session-owned subagent cache entries move to the bundle; reusable global cache entries remain',
  },
  {
    kind: 'delete_rows',
    table: 'counterfactual_logs',
    whereSql: 'session_id IS NOT NULL OR company_session_id IS NOT NULL',
    dropColumns: ['session_id', 'company_session_id'],
    reason: 'session-owned counterfactual records move to bundle metrics/events',
  },
  {
    kind: 'delete_rows',
    table: 'quality_classifications',
    whereSql: 'session_id IS NOT NULL OR company_session_id IS NOT NULL OR agent_run_id IN (SELECT id FROM company_agent_runs)',
    dropColumns: ['session_id', 'company_session_id'],
    reason: 'session and Company quality decisions move to bundle metrics/events',
  },
  {
    kind: 'delete_rows',
    table: 'quality_interventions',
    whereSql: 'session_id IS NOT NULL OR company_session_id IS NOT NULL OR agent_run_id IN (SELECT id FROM company_agent_runs)',
    dropColumns: ['session_id', 'company_session_id'],
    reason: 'session and Company quality interventions move to bundle events',
  },
  {
    kind: 'delete_rows',
    table: 'builder_checkpoints',
    whereSql: 'session_id IS NOT NULL',
    dropColumns: ['session_id'],
    reason: 'project checkpoints remain; session-owned checkpoints move to checkpoints/ in the bundle',
  },
  {
    kind: 'delete_rows',
    table: 'memory_distill_log',
    whereSql: 'session_id IS NOT NULL',
    dropColumns: ['session_id'],
    reason: 'project memory distillation history remains; session-owned history moves to memory/ in the bundle',
  },
  {
    kind: 'delete_rows',
    table: 'mcp_connection_profiles',
    whereSql: 'session_id IS NOT NULL',
    dropColumns: ['session_id'],
    reason: 'global MCP profile configuration remains; legacy session binding moves to the bundle',
  },
] as const;

/**
 * Rows listed here may be absent from the filesystem export only after the
 * migrator proves that every declared parent is absent or itself orphaned.
 * They are legacy residue left behind when older code deleted the root session
 * without cascading. The migrator records count/bytes/hash per table and fails
 * closed for an unowned row from any table not declared here.
 */
export const LEGACY_ORPHAN_CLEANUP_DISPOSITIONS:
readonly LegacyOrphanCleanupDisposition[] = [
  {
    table: 'agent_board_watermarks',
    parents: [
      { kind: 'session', column: 'company_session_id', sessionKind: 'company' },
      {
        kind: 'record',
        column: 'agent_run_id',
        targetTable: 'company_agent_runs',
        targetColumn: 'id',
      },
    ],
    reason: 'legacy Company rows can outlive both the Company session and its agent run',
  },
  {
    table: 'agent_supervision',
    parents: [
      { kind: 'session', column: 'company_session_id', sessionKind: 'company' },
      {
        kind: 'record',
        column: 'agent_run_id',
        targetTable: 'company_agent_runs',
        targetColumn: 'id',
      },
    ],
    reason: 'legacy Company supervision can outlive both the Company session and its agent run',
  },
  {
    table: 'agent_supervision_incidents',
    parents: [
      { kind: 'session', column: 'company_session_id', sessionKind: 'company' },
      {
        kind: 'record',
        column: 'agent_run_id',
        targetTable: 'company_agent_runs',
        targetColumn: 'id',
      },
      {
        kind: 'rootless',
        columns: ['company_session_id', 'agent_run_id'],
      },
    ],
    reason: 'legacy Company incidents can outlive both the Company session and their agent run',
  },
  {
    table: 'coder_investigations',
    parents: [
      { kind: 'session', column: 'session_id', sessionKind: 'coder' },
    ],
    reason: 'only session-only investigations whose deleted root no longer exists are cleanup residue',
  },
  {
    table: 'coder_session_groups',
    parents: [
      {
        kind: 'inverse_record',
        column: 'id',
        sourceTable: 'coder_sessions',
        sourceColumn: 'group_id',
      },
    ],
    reason: 'an unused legacy session group has no surviving session projection',
  },
  {
    table: 'coder_subagent_runs',
    parents: [
      { kind: 'session', column: 'session_id', sessionKind: 'coder' },
    ],
    reason: 'legacy subagent runs can outlive their deleted coder session',
  },
  {
    table: 'coder_subagent_tool_calls',
    parents: [
      { kind: 'session', column: 'session_id', sessionKind: 'coder' },
      {
        kind: 'record',
        column: 'run_id',
        targetTable: 'coder_subagent_runs',
        targetColumn: 'run_id',
      },
    ],
    reason: 'legacy subagent tool calls can outlive both their coder session and subagent run',
  },
  {
    table: 'coder_turn_telemetry',
    parents: [
      { kind: 'session', column: 'session_id', sessionKind: 'coder' },
    ],
    reason: 'legacy telemetry did not cascade when its coder session was deleted',
  },
  {
    table: 'company_drive_files',
    parents: [
      {
        kind: 'encoded_session',
        column: 'scope_key',
        prefix: 'ses:',
        sessionKind: 'company',
      },
      {
        kind: 'record',
        column: 'owner_agent_run_id',
        targetTable: 'company_agent_runs',
        targetColumn: 'id',
      },
    ],
    reason: 'legacy Company drive metadata can outlive both its session scope and owner run',
  },
  {
    table: 'counterfactual_logs',
    parents: [
      { kind: 'session', column: 'session_id', sessionKind: 'coder' },
      { kind: 'session', column: 'company_session_id', sessionKind: 'company' },
    ],
    reason: 'legacy counterfactual telemetry can outlive its coder or Company session',
  },
  {
    table: 'memory_distill_log',
    parents: [
      { kind: 'session', column: 'session_id', sessionKind: 'coder' },
    ],
    reason: 'legacy session-owned memory telemetry can outlive its coder session',
  },
  {
    table: 'pipeline_telemetry',
    parents: [
      { kind: 'session', column: 'session_id', sessionKind: 'coder' },
      { kind: 'session', column: 'company_session_id', sessionKind: 'company' },
    ],
    reason: 'legacy pipeline telemetry can outlive its coder or Company session',
  },
  {
    table: 'policy_decisions',
    parents: [
      { kind: 'session', column: 'legacy_session_id', sessionKind: 'coder' },
      {
        kind: 'record',
        column: 'session_id',
        targetTable: 'control_plane_sessions',
        targetColumn: 'session_id',
      },
      {
        kind: 'record',
        column: 'command_id',
        targetTable: 'session_commands',
        targetColumn: 'command_id',
      },
      {
        kind: 'record',
        column: 'agent_run_id',
        targetTable: 'agent_runs',
        targetColumn: 'agent_run_id',
      },
    ],
    reason: 'legacy policy decisions can outlive every control-plane parent',
  },
  {
    table: 'policy_decision_comparisons',
    parents: [
      {
        kind: 'record',
        column: 'decision_id',
        targetTable: 'policy_decisions',
        targetColumn: 'decision_id',
      },
      {
        kind: 'record',
        column: 'session_id',
        targetTable: 'control_plane_sessions',
        targetColumn: 'session_id',
      },
    ],
    reason: 'legacy policy comparisons can outlive both their decision and control-plane session',
  },
  {
    table: 'session_events',
    parents: [
      { kind: 'session', column: 'session_id', sessionKind: 'coder' },
    ],
    reason: 'legacy lifecycle events did not cascade when their coder session was deleted',
  },
  {
    table: 'session_file_baselines',
    parents: [
      {
        kind: 'session',
        column: 'session_id',
        sessionKind: 'coder',
        when: { column: 'session_kind', values: ['coder'] },
      },
      {
        kind: 'session',
        column: 'session_id',
        sessionKind: 'company',
        when: { column: 'session_kind', values: ['company'] },
      },
    ],
    reason: 'legacy file baselines can outlive their typed session root',
  },
  {
    table: 'session_file_edits',
    parents: [
      {
        kind: 'record',
        column: 'baseline_id',
        targetTable: 'session_file_baselines',
        targetColumn: 'id',
      },
    ],
    reason: 'legacy file edits can outlive an orphaned baseline',
  },
  {
    table: 'session_file_hunk_decisions',
    parents: [
      {
        kind: 'record',
        column: 'baseline_id',
        targetTable: 'session_file_baselines',
        targetColumn: 'id',
      },
    ],
    reason: 'legacy hunk decisions can outlive an orphaned baseline',
  },
  {
    table: 'session_file_review_comments',
    parents: [
      {
        kind: 'record',
        column: 'baseline_id',
        targetTable: 'session_file_baselines',
        targetColumn: 'id',
      },
      {
        kind: 'record',
        column: 'run_id',
        targetTable: 'session_file_review_runs',
        targetColumn: 'id',
      },
    ],
    reason: 'legacy review comments can outlive every review/baseline parent',
  },
  {
    table: 'session_file_review_runs',
    parents: [
      {
        kind: 'session',
        column: 'session_id',
        sessionKind: 'coder',
        when: { column: 'session_kind', values: ['coder'] },
      },
      {
        kind: 'session',
        column: 'session_id',
        sessionKind: 'company',
        when: { column: 'session_kind', values: ['company'] },
      },
    ],
    reason: 'legacy file review runs can outlive their typed session root',
  },
  {
    table: 'sub_agent_result_cache',
    parents: [
      { kind: 'session', column: 'session_id', sessionKind: 'coder' },
    ],
    reason: 'legacy session-scoped subagent cache can outlive its coder session',
  },
] as const;

export const DROP_TABLES = TABLE_DISPOSITIONS
  .filter((item): item is DropTableDisposition => item.kind === 'drop')
  .map((item) => item.table);

export const DELETE_ROW_DISPOSITIONS = TABLE_DISPOSITIONS
  .filter((item): item is DeleteRowsDisposition => item.kind === 'delete_rows');

/**
 * Mixed tables that keep their global/template rows after the cut but whose
 * remaining schema can still represent legacy session state. Migration 263
 * installs write guards for these predicates and the startup invariant checks
 * them on every database open.
 */
export const POST_CUT_ROW_GUARDS: readonly PostCutRowGuard[] = [
  {
    table: 'pipeline_provider_bindings',
    whereSql: "scope_type = 'session'",
    insertWhenSql: "NEW.scope_type = 'session'",
    updateWhenSql: "NEW.scope_type = 'session'",
  },
  {
    table: 'company_drive_files',
    whereSql: "scope_key LIKE 'ses:%'",
    insertWhenSql: "NEW.scope_key LIKE 'ses:%'",
    updateWhenSql: "NEW.scope_key LIKE 'ses:%'",
  },
];

/** Virtual/materialized projections whose canonical source is exported elsewhere. */
export const REDUNDANT_PROJECTION_TABLES = [
  'coder_session_chapters_fts',
  'coder_session_chapters_fts_config',
  'coder_session_chapters_fts_data',
  'coder_session_chapters_fts_docsize',
  'coder_session_chapters_fts_idx',
] as const;

export const SQLITE_ESSENTIAL_EXPLICIT_KEEP = [
  'projects',
  'schema_version',
  'project_db_meta',
  'provider_configs',
  'provider_models',
  'oauth_clients',
  'oauth_auth_codes',
  'oauth_tokens',
  'oauth_refresh_tokens',
  'mcp_server_configs',
  'mcp_server_tools',
  'embedding_configs',
  'embedding_store_configs',
  'vector_store_configs',
  'reranker_configs',
  'model_prices',
  'models_cache',
  'api_tokens',
  'semantic_profiles',
  'semantic_model_catalog',
  'semantic_generations',
  'semantic_namespace_generations',
  'semantic_items',
  'semantic_jobs',
  'auth_audit_log',
  'app_settings',
  'company_templates',
  'skill_definitions',
  'coder_phase_profiles',
  'coder_investigations',
  'pipeline_provider_bindings',
  'capability_descriptors',
  'agent_memory',
  'agent_memory_events',
  'snapshots',
  'snapshot_files',
  'snapshot_versions',
  'runs',
  'costs',
  'project_cost_rollup',
  'pipeline_telemetry',
  'sub_agent_result_cache',
  'counterfactual_logs',
  'quality_classifications',
  'quality_interventions',
  'company_drive_files',
  'builder_checkpoints',
  'memory_distill_log',
  'mcp_connection_profiles',
] as const;

const forbiddenColumnRules: Readonly<Record<string, readonly string[]>> = {
  coder_investigations: ['session_id'],
  agent_memory_events: ['session_id'],
  pipeline_telemetry: ['session_id', 'company_session_id'],
  sub_agent_result_cache: ['session_id'],
  counterfactual_logs: ['session_id', 'company_session_id'],
  quality_classifications: ['session_id', 'company_session_id'],
  quality_interventions: ['session_id', 'company_session_id'],
  company_drive_files: ['owner_agent_run_id'],
  builder_checkpoints: ['session_id'],
  memory_distill_log: ['session_id'],
  mcp_connection_profiles: ['session_id'],
};

export interface SchemaTable {
  name: string;
  columns: readonly string[];
}

const SESSION_SCOPE_COLUMNS = new Set([
  'session_id',
  'company_session_id',
  'coder_session_id',
  'legacy_session_id',
  'parent_coder_session_id',
  'app_session_id',
  'sprite_project_id',
]);

export function assertDispositionManifest(): void {
  const seen = new Set<string>();
  for (const item of TABLE_DISPOSITIONS) {
    if (!/^[a-z][a-z0-9_]*$/.test(item.table)) {
      throw new Error(`unsafe table identifier in disposition manifest: ${item.table}`);
    }
    if (seen.has(item.table)) throw new Error(`duplicate table disposition: ${item.table}`);
    seen.add(item.table);
    if (item.kind === 'delete_rows') {
      if (!item.whereSql.trim()) throw new Error(`empty row predicate for ${item.table}`);
      if (/;\s*\S/.test(item.whereSql) || /--|\/\*/.test(item.whereSql)) {
        throw new Error(`unsafe row predicate for ${item.table}`);
      }
    }
  }
  for (const guard of POST_CUT_ROW_GUARDS) {
    if (!seen.has(guard.table)) {
      throw new Error(`post-cut row guard has no table disposition: ${guard.table}`);
    }
    for (const sql of [guard.whereSql, guard.insertWhenSql, guard.updateWhenSql]) {
      if (!sql.trim() || /;\s*\S/.test(sql) || /--|\/\*/.test(sql)) {
        throw new Error(`unsafe post-cut row guard for ${guard.table}`);
      }
    }
  }
  const orphanTables = new Set<string>();
  for (const disposition of LEGACY_ORPHAN_CLEANUP_DISPOSITIONS) {
    if (!seen.has(disposition.table)) {
      throw new Error(
        `legacy orphan cleanup has no table disposition: ${disposition.table}`,
      );
    }
    if (orphanTables.has(disposition.table)) {
      throw new Error(`duplicate legacy orphan cleanup disposition: ${disposition.table}`);
    }
    orphanTables.add(disposition.table);
    if (disposition.parents.length === 0) {
      throw new Error(`legacy orphan cleanup has no parent proof: ${disposition.table}`);
    }
    for (const parent of disposition.parents) {
      const identifiers = parent.kind === 'rootless'
        ? [...parent.columns]
        : parent.kind === 'inverse_record'
        ? [parent.column, parent.sourceTable, parent.sourceColumn]
        : parent.kind === 'record'
          ? [parent.column, parent.targetTable, parent.targetColumn]
          : [parent.column];
      for (const identifier of identifiers) {
        if (!/^[a-z][a-z0-9_]*$/.test(identifier)) {
          throw new Error(
            `unsafe identifier in legacy orphan cleanup for ${disposition.table}: ${identifier}`,
          );
        }
      }
      if (parent.kind === 'rootless' && parent.columns.length === 0) {
        throw new Error(
          `empty rootless parent proof in legacy orphan cleanup for ${disposition.table}`,
        );
      }
      if (parent.kind === 'session' && parent.when) {
        if (!/^[a-z][a-z0-9_]*$/.test(parent.when.column)) {
          throw new Error(
            `unsafe discriminator in legacy orphan cleanup for ${disposition.table}: ${parent.when.column}`,
          );
        }
        if (parent.when.values.length === 0) {
          throw new Error(
            `empty discriminator values in legacy orphan cleanup for ${disposition.table}`,
          );
        }
      }
    }
  }
  const keep = new Set<string>(SQLITE_ESSENTIAL_EXPLICIT_KEEP);
  const overlap = DROP_TABLES.filter((table) => keep.has(table));
  if (overlap.length > 0) {
    throw new Error(`DROP and KEEP dispositions overlap: ${overlap.join(', ')}`);
  }
}

/**
 * Fresh-schema regression guard. It intentionally uses explicit vocabulary,
 * never a DROP-time wildcard. A newly created operational table/column fails CI
 * until it is moved to filesystem storage or explicitly classified as essential.
 */
export function findForbiddenSessionSchema(schema: readonly SchemaTable[]): string[] {
  const declaredDrops = new Set(DROP_TABLES);
  const violations: string[] = [];
  for (const table of schema) {
    if (declaredDrops.has(table.name)) {
      violations.push(`forbidden session table: ${table.name}`);
    }
    const forbiddenColumns = forbiddenColumnRules[table.name] ?? [];
    for (const column of table.columns) {
      if (forbiddenColumns.includes(column)) {
        violations.push(`forbidden session column: ${table.name}.${column}`);
      }
    }
  }
  return violations;
}

/**
 * Source-schema audit: every table carrying an operational session locator
 * must have an explicit DROP or mixed-row disposition. This never drives
 * deletion; it only prevents the manifest from silently overlooking new schema.
 */
export function findUnclassifiedSessionSchema(schema: readonly SchemaTable[]): string[] {
  const classified = new Set(TABLE_DISPOSITIONS.map((item) => item.table));
  const violations: string[] = [];
  for (const table of schema) {
    const scopedColumns = table.columns.filter((column) => SESSION_SCOPE_COLUMNS.has(column));
    if (scopedColumns.length > 0 && !classified.has(table.name)) {
      violations.push(
        `unclassified session schema: ${table.name} (${scopedColumns.join(', ')})`,
      );
    }
  }
  return violations;
}

assertDispositionManifest();
