/**
 * Schema migration runner.
 *
 * Migrations are versioned SQL changes applied in order. Each migration runs
 * exactly once per database. The current version is tracked in the
 * `schema_version` table.
 *
 * Convention:
 *   - File name: NNN_description.ts (e.g. 001_baseline.ts)
 *   - Export: { version: number, name: string, up(db): void }
 *
 * To add a migration:
 *   1. Create a new file `NNN_description.ts` with the next version number.
 *   2. Import it here and add it to the MIGRATIONS array in order.
 *   3. Migrations are idempotent at the runner level — already-applied
 *      migrations are skipped.
 */
import type DatabaseConstructor from 'better-sqlite3';
import { baseline001 } from './001_baseline.js';
import { symbolStableId002 } from './002_symbol_stable_id.js';
import { snapshotFiles003 } from './003_snapshot_files.js';
import { coderSessions004 } from './004_coder_sessions.js';
import { coderCacheTokens005 } from './005_coder_cache_tokens.js';
import { adminProviders006 } from './006_admin_providers.js';
import { coderPlans007 } from './007_coder_plans.js';
import { coderTasks008 } from './008_coder_tasks.js';
import { sessionsArchiveAndGroups009 } from './009_sessions_archive_and_groups.js';
import { sessionFavorites010 } from './010_session_favorites.js';
import { vectorStoreConfigs011 } from './011_vector_store_configs.js';
import { embeddingHash012 } from './012_embedding_hash.js';
import { coderTodosAndWorktree013 } from './013_coder_todos_and_worktree.js';
import { toolConfigs014 } from './014_tool_configs.js';
import { mcpServers015 } from './015_mcp_servers.js';
import { skills016 } from './016_skills.js';
import { mcpServerTools017 } from './017_mcp_server_tools.js';
import { companyAgents018 } from './018_company_agents.js';
import { companyStatusMessage019 } from './019_company_status_message.js';
import { structureHash020 } from './020_structure_hash.js';
import { structureEmbedding021 } from './021_structure_embedding.js';
import { projectGroup022 } from './022_project_group.js';
import { cloudcodeSession023 } from './023_cloudcode_session.js';
import { kanban024 } from './024_kanban.js';
import { fallbackConfig025 } from './025_fallback_config.js';
import { lastTurnTokens026 } from './026_last_turn_tokens.js';
import { projectSettings027 } from './027_project_settings.js';
import { apiTokens028 } from './028_api_tokens.js';
import { oauthServer029 } from './029_oauth_server.js';
import { mcpClientOauth030 } from './030_mcp_client_oauth.js';
import { coderSessionAgent031 } from './031_coder_session_agent.js';
import { masterPrompts032 } from './032_master_prompts.js';
import { skillSourceRef033 } from './033_skill_source_ref.js';
import { companySandboxes034 } from './034_company_sandboxes.js';
import { companySandboxServices035 } from './035_company_sandbox_services.js';
import { companySessionEnvs036 } from './036_company_session_envs.js';
import { serviceHostWorkdir037 } from './037_service_host_workdir.js';
import { companyArchives038 } from './038_company_archives.js';
import { companySessionEnvSource039 } from './039_company_session_env_source.js';
import { generalAi041 } from './041_general_ai.js';
import { companySessionDatabases040 } from './040_company_session_databases.js';
import { companyLocalProjects042 } from './042_company_local_projects.js';
import { qaTestRuns043 } from './043_qa_test_runs.js';
import { chromeService045 } from './045_chrome_service.js';
import { qaArtifacts046 } from './046_qa_artifacts.js';
import { qaKanbanAndPersistedPath047 } from './047_qa_kanban_and_persisted_path.js';
import { designSystems048 } from './048_design_systems.js';
import { verdaccioConfig049 } from './049_verdaccio_config.js';
import { verdaccioBootstrapPassword050 } from './050_verdaccio_bootstrap_password.js';
import { designSystemMcpInstall051 } from './051_design_system_mcp_install.js';
import { providerModelMetadata052 } from './052_provider_model_metadata.js';
import { coderSessionResponseId053 } from './053_coder_session_response_id.js';
import { skillContextModeV2 } from './054_skill_context_mode_v2.js';
import { skillTrigger } from './055_skill_trigger.js';
import { skillUsageOutcome } from './056_skill_usage_outcome.js';
import { sessionTemperature057 } from './057_session_temperature.js';
import { pipelines058 } from './058_pipelines.js';
import { agentInbox059 } from './059_agent_inbox.js';
import { qaTestRunsLastErrorBackfill060 } from './060_qa_test_runs_last_error_backfill.js';
import { coderSessionInputs061 } from './061_coder_session_inputs.js';
import { companySandboxesHostWorkdir062 } from './062_company_sandboxes_host_workdir.js';
import { externalMount063 } from './063_external_mount.js';
import { attachedServices064 } from './064_attached_services.js';
import { companyFronts065 } from './065_company_fronts.js';
import { companySubsessions067 } from './067_company_subsessions.js';
import { companyDriveFiles066 } from './066_company_drive_files.js';
import { coderSessionGoal068 } from './068_coder_session_goal.js';
import { coderTurnTelemetry069 } from './069_coder_turn_telemetry.js';
import { indexHygiene070 } from './070_index_hygiene.js';
import { fileIndexTier071 } from './071_file_index_tier.js';
import { telemetryPerTool072 } from './072_telemetry_per_tool.js';
import { phaseProfiles073 } from './073_phase_profiles.js';
import { sessionBaseCommit074 } from './074_session_base_commit.js';
import { coderMessageMeta075 } from './075_coder_message_meta.js';
import { snapshotEmbeddingHash076 } from './076_snapshot_embedding_hash.js';
import { pipelinesChat077 } from './077_pipelines_chat.js';
import { sessionUnrestrictedToolOutput078 } from './078_session_unrestricted_tool_output.js';
import { sessionFileSnapshots079 } from './079_session_file_snapshots.js';
import { subAgentResultCache081 } from './081_sub_agent_result_cache.js';
import { embeddingLsh082 } from './082_embedding_lsh.js';
import { qualityClassifications083 } from './083_quality_classifications.js';
import { counterfactualLogs084 } from './084_counterfactual_logs.js';
import { pipelineFoundation085 } from './085_pipeline_foundation.js';
import { docCorpus086 } from './086_doc_corpus.js';
import { companySessionArchivedAt087 } from './087_company_session_archived_at.js';
import { vectorTombstones088 } from './088_vector_tombstones.js';
import { docSourcesRequiredPath089 } from './089_doc_sources_required_path.js';
import { qualityInterventions090 } from './090_quality_interventions.js';
import { companySessionRecoveredAt091 } from './091_company_session_recovered_at.js';
import { docSourcesLlmLinks092 } from './092_doc_sources_llm_links.js';
import { turnRequestResponseMeta093 } from './093_turn_request_response_meta.js';
import { masterInboxSentinel094 } from './094_master_inbox_sentinel.js';
import { coderMessageSelectedSkills095 } from './095_coder_message_selected_skills.js';
import { docSourceSuggestions096 } from './096_doc_source_suggestions.js';
import { docsResearchSessions097 } from './097_docs_research_sessions.js';
import { docRerankCache098 } from './098_doc_rerank_cache.js';
import { docSourcesForceBrowser099 } from './099_doc_sources_force_browser.js';
import { chromeServiceImageBump100 } from './100_chrome_service_image_bump.js';
import { docSourcesBrowserSeedOnly101 } from './101_doc_sources_browser_seed_only.js';
import { docSourcesFolder103 } from './103_doc_sources_folder.js';
import { coderToolCallsOutputCharsShaped102 } from './102_coder_tool_calls_output_chars_shaped.js';
import { apiTokensTier104 } from './104_api_tokens_tier.js';
import { appSettings105 } from './105_app_settings.js';
import { agentBoardWatermarks106 } from './106_agent_board_watermarks.js';
import { agentSupervision107 } from './107_agent_supervision.js';
import { coderTaskRuns108 } from './108_coder_task_runs.js';
import { rerankerConfigs109 } from './109_reranker_configs.js';
import { sessionSnapshotReviews110 } from './110_session_snapshot_reviews.js';
import { modelPrices111 } from './111_model_prices.js';
import { installedPlugins112 } from './112_installed_plugins.js';
import { embeddingFingerprint113 } from './113_embedding_fingerprint.js';
import { snapshotMemory114 } from './114_snapshot_memory.js';
import { memoryEnabled115 } from './115_memory_enabled.js';
import { pluginPermissions116 } from './116_plugin_permissions.js';
import { pluginStorage117 } from './117_plugin_storage.js';
import { projectNodeVersion118 } from './118_project_node_version.js';
import { pipelineProjectScope119 } from './119_pipeline_project_scope.js';
import { projectRunnerShell120 } from './120_project_runner_shell.js';
import { trainingDatasets121 } from './121_training_datasets.js';
import { coderBuilderConfig122 } from './122_coder_builder_config.js';
import { projectBuilderJson123 } from './123_project_builder_json.js';
import { coderToolCallRefusalKind124 } from './124_coder_tool_call_refusal_kind.js';
import { coderSessionMemory125 } from './125_coder_session_memory.js';
import { coderInvestigations126 } from './126_coder_investigations.js';
import { investigationEmbedding127 } from './127_investigation_embedding.js';
import { sessionSummaryBoundary128 } from './128_session_summary_boundary.js';
import { sessionCompactionSummary129 } from './129_session_compaction_summary.js';
import { sessionCompactionCounts130 } from './130_session_compaction_counts.js';
import { sessionToolPermissions131 } from './131_session_tool_permissions.js';
import { designSystemStudio132 } from './132_design_system_studio.js';
import { coderToolCallsParent133 } from './133_coder_tool_calls_parent.js';
import { projectDocCollections134 } from './134_project_doc_collections.js';
import { modelMaxTools135 } from './135_model_max_tools.js';
import { memoryDistill136 } from './136_memory_distill.js';
import { filesMtime137 } from './137_files_mtime.js';
import { runPhaseTelemetry138 } from './138_run_phase_telemetry.js';
import { structuralIndex139 } from './139_structural_index.js';
import { fileContentsFts140 } from './140_file_contents_fts.js';
import { symbolsColExported141 } from './141_symbols_col_exported.js';
import { sessionToolProfile142 } from './142_session_tool_profile.js';
import { turnCacheDiagnostics143 } from './143_turn_cache_diagnostics.js';
import { builderCheckpoints144 } from './144_builder_checkpoints.js';
import { userMemory145 } from './145_user_memory.js';
import { snapshotArchive146 } from './146_snapshot_archive.js';
import { apiCollections147 } from './147_api_collections.js';
import { apiRequestHistory148 } from './148_api_request_history.js';
import { docTyping149 } from './149_doc_typing.js';
import { sessionReasoningEffort150 } from './150_session_reasoning_effort.js';
import { sessionPlanDepth151 } from './151_session_plan_depth.js';
import { globalSessions152 } from './152_global_sessions.js';
import { sessionToolOutputCapLevel153 } from './153_session_tool_output_cap_level.js';
import { snapshotProjectScope154 } from './154_snapshot_project_scope.js';
import { projectSynthetic155 } from './155_project_synthetic.js';
import { apiRequestPostmanOverhaul156 } from './156_api_request_postman_overhaul.js';
import { projectLanguageLevels157 } from './157_project_language_levels.js';
import { apiRequestFolder158 } from './158_api_request_folder.js';
import { apiCollectionFolders159 } from './159_api_collection_folders.js';
import { fileLocalHistory160 } from './160_file_local_history.js';
import { projectDbSplit161 } from './161_project_db_split.js';
import { telemetryProjectId162 } from './162_telemetry_project_id.js';
import { dropSessionSplitScaffolding164 } from './164_drop_session_split_scaffolding.js';
import { vectorsSplit165 } from './165_vectors_split.js';
import { dbPurgedAt166 } from './166_db_purged_at.js';
import { projectRuntimeVersions167 } from './167_project_runtime_versions.js';
import { projectRuntimeConfig168 } from './168_project_runtime_config.js';
import { projectPackageManagers169 } from './169_project_package_managers.js';
import { projectGitRemote170 } from './170_project_git_remote.js';
import { apiDocFields171 } from './171_api_doc_fields.js';
import { apiDocPagesExamples172 } from './172_api_doc_pages_examples.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export interface Migration {
  version: number;
  name: string;
  up: (db: DB) => void;
  /**
   * Opt-out do auto-wrap em `db.transaction()`. Necessário para
   * migrations que precisam toggar `PRAGMA foreign_keys = OFF` — esse
   * pragma é silenciosamente ignorado dentro de uma transação ativa
   * (`SQLITE_LOCKED` ao tentar DROP de tabelas com FK).
   *
   * Quando true, a migration é responsável por:
   *   1. PRAGMA foreign_keys = OFF (se precisar)
   *   2. Sua própria transação (BEGIN/COMMIT) ou `db.transaction()` interno
   *   3. PRAGMA foreign_key_check para verificar integridade
   *   4. PRAGMA foreign_keys = ON (restaurar)
   *
   * O runner ainda registra a versão em `schema_version` num INSERT
   * autônomo APÓS `up()` retornar com sucesso — então uma migration
   * que falha no meio precisa restaurar o estado ela mesma (ROLLBACK
   * + foreign_keys=ON) antes de propagar o erro.
   *
   * Usar com cautela: o ponto inteiro do wrap em transação é
   * atomicidade. Só dispense quando a operação não cabe (recreate-table
   * com FK, multi-step que precisa de PRAGMA fora-de-tx, etc).
   */
  outsideTransaction?: boolean;
}

export const MIGRATIONS: Migration[] = [
  baseline001,
  symbolStableId002,
  snapshotFiles003,
  coderSessions004,
  coderCacheTokens005,
  adminProviders006,
  coderPlans007,
  coderTasks008,
  sessionsArchiveAndGroups009,
  sessionFavorites010,
  vectorStoreConfigs011,
  embeddingHash012,
  coderTodosAndWorktree013,
  toolConfigs014,
  mcpServers015,
  skills016,
  mcpServerTools017,
  companyAgents018,
  companyStatusMessage019,
  structureHash020,
  structureEmbedding021,
  projectGroup022,
  cloudcodeSession023,
  kanban024,
  fallbackConfig025,
  lastTurnTokens026,
  projectSettings027,
  apiTokens028,
  oauthServer029,
  mcpClientOauth030,
  coderSessionAgent031,
  masterPrompts032,
  skillSourceRef033,
  companySandboxes034,
  companySandboxServices035,
  companySessionEnvs036,
  serviceHostWorkdir037,
  companyArchives038,
  companySessionEnvSource039,
  companySessionDatabases040,
  generalAi041,
  companyLocalProjects042,
  qaTestRuns043,
  chromeService045,
  qaArtifacts046,
  qaKanbanAndPersistedPath047,
  designSystems048,
  verdaccioConfig049,
  verdaccioBootstrapPassword050,
  designSystemMcpInstall051,
  providerModelMetadata052,
  coderSessionResponseId053,
  skillContextModeV2,
  skillTrigger,
  skillUsageOutcome,
  sessionTemperature057,
  pipelines058,
  agentInbox059,
  qaTestRunsLastErrorBackfill060,
  coderSessionInputs061,
  companySandboxesHostWorkdir062,
  externalMount063,
  attachedServices064,
  companyFronts065,
  companyDriveFiles066,
  companySubsessions067,
  coderSessionGoal068,
  coderTurnTelemetry069,
  indexHygiene070,
  fileIndexTier071,
  telemetryPerTool072,
  phaseProfiles073,
  sessionBaseCommit074,
  coderMessageMeta075,
  snapshotEmbeddingHash076,
  pipelinesChat077,
  sessionUnrestrictedToolOutput078,
  sessionFileSnapshots079,
  subAgentResultCache081,
  embeddingLsh082,
  qualityClassifications083,
  counterfactualLogs084,
  pipelineFoundation085,
  docCorpus086,
  companySessionArchivedAt087,
  vectorTombstones088,
  docSourcesRequiredPath089,
  qualityInterventions090,
  companySessionRecoveredAt091,
  docSourcesLlmLinks092,
  turnRequestResponseMeta093,
  masterInboxSentinel094,
  coderMessageSelectedSkills095,
  docSourceSuggestions096,
  docsResearchSessions097,
  docRerankCache098,
  docSourcesForceBrowser099,
  chromeServiceImageBump100,
  docSourcesBrowserSeedOnly101,
  coderToolCallsOutputCharsShaped102,
  docSourcesFolder103,
  apiTokensTier104,
  appSettings105,
  agentBoardWatermarks106,
  agentSupervision107,
  coderTaskRuns108,
  rerankerConfigs109,
  sessionSnapshotReviews110,
  modelPrices111,
  installedPlugins112,
  embeddingFingerprint113,
  snapshotMemory114,
  memoryEnabled115,
  pluginPermissions116,
  pluginStorage117,
  projectNodeVersion118,
  pipelineProjectScope119,
  projectRunnerShell120,
  trainingDatasets121,
  coderBuilderConfig122,
  projectBuilderJson123,
  coderToolCallRefusalKind124,
  coderSessionMemory125,
  coderInvestigations126,
  investigationEmbedding127,
  sessionSummaryBoundary128,
  sessionCompactionSummary129,
  sessionCompactionCounts130,
  sessionToolPermissions131,
  designSystemStudio132,
  coderToolCallsParent133,
  projectDocCollections134,
  modelMaxTools135,
  memoryDistill136,
  filesMtime137,
  runPhaseTelemetry138,
  structuralIndex139,
  fileContentsFts140,
  symbolsColExported141,
  sessionToolProfile142,
  turnCacheDiagnostics143,
  builderCheckpoints144,
  userMemory145,
  snapshotArchive146,
  apiCollections147,
  apiRequestHistory148,
  docTyping149,
  sessionReasoningEffort150,
  sessionPlanDepth151,
  globalSessions152,
  sessionToolOutputCapLevel153,
  snapshotProjectScope154,
  projectSynthetic155,
  apiRequestPostmanOverhaul156,
  projectLanguageLevels157,
  apiRequestFolder158,
  apiCollectionFolders159,
  fileLocalHistory160,
  projectDbSplit161,
  telemetryProjectId162,
  dropSessionSplitScaffolding164,
  vectorsSplit165,
  dbPurgedAt166,
  projectRuntimeVersions167,
  projectRuntimeConfig168,
  projectPackageManagers169,
  projectGitRemote170,
  apiDocFields171,
  apiDocPagesExamples172,
];

/**
 * Ensure the `schema_version` table exists and apply any pending migrations.
 * Safe to call on both fresh and existing databases.
 */
export function runMigrations(db: DB): { applied: number[]; current: number } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const appliedRows = db
    .prepare('SELECT version FROM schema_version ORDER BY version')
    .all() as { version: number }[];
  const appliedSet = new Set(appliedRows.map((r) => r.version));

  const applied: number[] = [];
  const sorted = [...MIGRATIONS].sort((a, b) => a.version - b.version);

  for (const migration of sorted) {
    if (appliedSet.has(migration.version)) continue;

    try {
      if (migration.outsideTransaction) {
        // Migration auto-gerencia sua própria transação + PRAGMAs.
        // Geralmente recreate-table com `foreign_keys=OFF` (ver
        // migration 103). O registro em schema_version vai num INSERT
        // separado APÓS sucesso — se a migration crashar no meio, NÃO
        // marcamos como aplicada e o boot re-tenta.
        migration.up(db);
        db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(
          migration.version,
          migration.name
        );
      } else {
        const tx = db.transaction(() => {
          migration.up(db);
          db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(
            migration.version,
            migration.name
          );
        });
        tx();
      }
      applied.push(migration.version);
    } catch (e) {
      const err = e as Error;
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed: ${err.message}`
      );
    }
  }

  const currentRow = db
    .prepare('SELECT MAX(version) as v FROM schema_version')
    .get() as { v: number | null };
  return { applied, current: currentRow.v ?? 0 };
}

/**
 * Return the current schema version, or 0 if migrations have not run yet.
 */
export function getSchemaVersion(db: DB): number {
  try {
    const row = db
      .prepare('SELECT MAX(version) as v FROM schema_version')
      .get() as { v: number | null };
    return row.v ?? 0;
  } catch {
    return 0;
  }
}
