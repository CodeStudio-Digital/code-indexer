import type { Migration } from './types.js';
export type { Migration } from './types.js';
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
type DB = InstanceType<typeof DatabaseConstructor>;
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
import { sshHosts173 } from './173_ssh_hosts.js';
import { dbClient174 } from './174_db_client.js';
import { modelContextWindowOverride175 } from './175_model_context_window_override.js';
import { projectLoose176 } from './176_project_loose.js';
import { sessionResponseLanguage177 } from './177_session_response_language.js';
import { sessionOutputStyle178 } from './178_session_output_style.js';
import { chromeServiceImageBump161_179 } from './179_chrome_service_image_bump_161.js';
import { sessionPreflightSeed180 } from './180_session_preflight_seed.js';
import { agentMemory181 } from './181_agent_memory.js';
import { projectWslRuntimeVersions182 } from './182_project_wsl_runtime_versions.js';
import { projectWslPackageManagers183 } from './183_project_wsl_package_managers.js';
import { agentInboxThreading184 } from './184_agent_inbox_threading.js';
import { memoryDistillDiagnostics185 } from './185_memory_distill_diagnostics.js';
import { coderToolCallsErrorClass186 } from './186_coder_tool_calls_error_class.js';
import { symbolsNamespace187 } from './187_symbols_namespace.js';
import { serviceHealthTransitionsLogs188 } from './188_service_health_transitions_logs.js';
import { qaRunProgressAndErrorClass189 } from './189_qa_run_progress_and_error_class.js';
import { retireCompanySessionDatabases191 } from './191_retire_company_session_databases.js';
import { companySessionEnvScope192 } from './192_company_session_env_scope.js';
import { projectIndexIgnorePatterns193 } from './193_project_index_ignore_patterns.js';
import { sessionConfigLock194 } from './194_session_config_lock.js';
import { sessionEvents195 } from './195_session_events.js';
import { sshSecrets197 } from './197_ssh_secrets.js';
import { sshHostShared198 } from './198_ssh_host_shared.js';
import { appStudio200 } from './200_app_studio.js';
import { appStudioBlueprint201 } from './201_app_studio_blueprint.js';
import { qualitySystemError202 } from './202_quality_system_error.js';
import { appStudioSpecRevisions203 } from './203_app_studio_spec_revisions.js';
import { appStudioArchitecture204 } from './204_app_studio_architecture.js';
import { appStudioPipelineRepairs205 } from './205_app_studio_pipeline_repairs.js';
import { codeAgentOptimizationTelemetry206 } from './206_code_agent_optimization_telemetry.js';
import { appStudioOrphanSpecRevisions207 } from './207_app_studio_orphan_spec_revisions.js';
import { coderSessionChapters208 } from './208_coder_session_chapters.js';
import { coderTelemetryEligibleToolsRepair209 } from './209_coder_telemetry_eligible_tools_repair.js';
import { coderToolCallGuardTelemetry210 } from './210_coder_tool_call_guard_telemetry.js';
import { appStudioExperience211 } from './211_app_studio_experience.js';
import { appStudioProductModel212 } from './212_app_studio_product_model.js';
import { coderToolOutputFormat213 } from './213_coder_tool_output_format.js';
import { docIngestGenerations214 } from './214_doc_ingest_generations.js';
import { docRagTelemetryCache215 } from './215_doc_rag_telemetry_cache.js';
import { docIngestPauseWorkers216 } from './216_doc_ingest_pause_workers.js';
import { coderCompactionReliability217 } from './217_coder_compaction_reliability.js';
import { appStudioWorkflowV5218 } from './218_app_studio_workflow_v5.js';
import { appStudioWorkItemIdentity219 } from './219_app_studio_work_item_identity.js';
import { appStudioImpactV5220 } from './220_app_studio_impact_v5.js';
import { appStudioAgentConfig221 } from './221_app_studio_agent_config.js';
import { coderRoundFileSnapshots222 } from './222_coder_round_file_snapshots.js';
import { projectEditorConfig223 } from './223_project_editor_config.js';
import { reviewAiNative224 } from './224_review_ai_native.js';
import { externalSessionImports225 } from './225_external_session_imports.js';
import { sessionThinkingEnabled226 } from './226_session_thinking_enabled.js';
import { semanticIndexing227 } from './227_semantic_indexing.js';
import { investigationEmbeddingFingerprint228 } from './228_investigation_embedding_fingerprint.js';
import { distributeInvestigationVectors229 } from './229_distribute_investigation_vectors.js';
import { semanticLocalQ8Auto230 } from './230_semantic_local_q8_auto.js';
import { splitSemanticKnowledge238 } from './238_split_semantic_knowledge.js';
import { subagentResearchPolicy239 } from './239_subagent_research_policy.js';
import { mcpConnectionProfiles240 } from './240_mcp_connection_profiles.js';
import { sessionExecutionMode241 } from './241_session_execution_mode.js';
import { repairLegacyKimiCodeProvider242 } from './242_repair_legacy_kimi_code_provider.js';
import { kimiCodeApiKeyOnly243 } from './243_kimi_code_api_key_only.js';
import { semanticItemsIdentityLookup244 } from './244_semantic_items_identity_lookup.js';
import { docChunksEnrichmentLookup245 } from './245_doc_chunks_enrichment_lookup.js';
import { perfIndexes246 } from './246_perf_indexes.js';
import { qualityProviderRequestsRepair247 } from './247_quality_provider_requests_repair.js';
import { subagentRunLifecycle248 } from './248_subagent_run_lifecycle.js';
import { sessionFilesystemRoots249 } from './249_session_filesystem_roots.js';
import { projectLspProfileOverrides250 } from './250_project_lsp_profile_overrides.js';
import { controlPlaneFoundation251 } from './251_control_plane_foundation.js';
import { controlPlaneAlignment252 } from './252_control_plane_alignment.js';
import { providerAttemptTelemetry253 } from './253_provider_attempt_telemetry.js';
import { enableCodexSpark254 } from './254_enable_codex_spark.js';
import { policyEngine255 } from './255_policy_engine.js';
import { policyComparisonLatency256 } from './256_policy_comparison_latency.js';
import { agentRunChildCardinality257 } from './257_agent_run_child_cardinality.js';
import { pendingAgentTransition258 } from './258_pending_agent_transition.js';
import { coderOrchestrationCheckpoints259 } from './259_coder_orchestration_checkpoints.js';
import { masterPromptDeliveryAuthority260 } from './260_master_prompt_delivery_authority.js';
import { pipelineBindingCleanup261 } from './261_pipeline_binding_cleanup.js';
import { retireQualityClassifiers262 } from './262_retire_quality_classifiers.js';
import { filesystemSessionCutover263 } from './263_filesystem_session_cutover.js';
import { structuralRunPhaseTelemetry264 } from './264_structural_run_phase_telemetry.js';
import { removeAgentPipelines265 } from './265_remove_agent_pipelines.js';
import { removeDeadCodeRunSettings266 } from './266_remove_dead_code_run_settings.js';
import { retireSpriteAndDesignSystem267 } from './267_retire_sprite_and_design_system.js';
import { semanticJobLookup268 } from './268_semantic_job_lookup.js';
import { symbolReferenceKind269 } from './269_symbol_reference_kind.js';
import { retireAppStudioSkill270 } from './270_retire_app_studio_skill.js';
import { structuralState271 } from './271-structural-state.js';
import { pathCandidates272 } from './272-path-candidates.js';
import { structuralBuild273 } from './273-structural-build.js';
import { mcpOAuthResource274 } from './274_mcp_oauth_resource.js';
import { agentMemoryEvolution275 } from './275_agent_memory_evolution.js';
import { worktreeProjects276 } from './276_worktree_projects.js';
import { semanticRecovery277 } from './277_semantic_recovery.js';
import { bundledGraniteEmbedding278 } from './278_bundled_granite_embedding.js';
import { symbolReferenceTargetIndex279 } from './279_symbol_reference_target_index.js';
import { fileContentFtsExclusion280 } from './280_file_content_fts_exclusion.js';
import { symbolFileLookup281 } from './281_symbol_file_lookup.js';
import { projectSemanticFolders282 } from './282_project_semantic_folders.js';
import { projectSemanticTargets283 } from './283_project_semantic_targets.js';
import { projectSemanticVectorWeight284 } from './284_project_semantic_vector_weight.js';
import { modelCatalogSearch285 } from './285_model_catalog_search.js';
import { structuralLastChecked231 } from './231_structural_last_checked.js';
import { removeCodeLlmIndex232 } from './232_remove_code_llm_index.js';
import { removeLegacyVectorLedgers233 } from './233_remove_legacy_vector_ledgers.js';
import { qualityHybrid234 } from './234_quality_hybrid.js';
import { appStudioCompanyRuntime235 } from './235_app_studio_company_runtime.js';
import { companyAgentRunLifecycleStatuses236 } from './236_company_agent_run_lifecycle_statuses.js';
import { appStudioV6Reset237 } from './237_app_studio_v6_reset.js';



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
  sshHosts173,
  dbClient174,
  modelContextWindowOverride175,
  projectLoose176,
  sessionResponseLanguage177,
  sessionOutputStyle178,
  chromeServiceImageBump161_179,
  sessionPreflightSeed180,
  agentMemory181,
  projectWslRuntimeVersions182,
  projectWslPackageManagers183,
  agentInboxThreading184,
  memoryDistillDiagnostics185,
  coderToolCallsErrorClass186,
  symbolsNamespace187,
  serviceHealthTransitionsLogs188,
  qaRunProgressAndErrorClass189,
  retireCompanySessionDatabases191,
  companySessionEnvScope192,
  projectIndexIgnorePatterns193,
  sessionConfigLock194,
  sessionEvents195,
  sshSecrets197,
  sshHostShared198,
  appStudio200,
  appStudioBlueprint201,
  qualitySystemError202,
  appStudioSpecRevisions203,
  appStudioArchitecture204,
  appStudioPipelineRepairs205,
  codeAgentOptimizationTelemetry206,
  appStudioOrphanSpecRevisions207,
  coderSessionChapters208,
  coderTelemetryEligibleToolsRepair209,
  coderToolCallGuardTelemetry210,
  appStudioExperience211,
  appStudioProductModel212,
  coderToolOutputFormat213,
  docIngestGenerations214,
  docRagTelemetryCache215,
  docIngestPauseWorkers216,
  coderCompactionReliability217,
  appStudioWorkflowV5218,
  appStudioWorkItemIdentity219,
  appStudioImpactV5220,
  appStudioAgentConfig221,
  coderRoundFileSnapshots222,
  projectEditorConfig223,
  reviewAiNative224,
  externalSessionImports225,
  sessionThinkingEnabled226,
  semanticIndexing227,
  investigationEmbeddingFingerprint228,
  distributeInvestigationVectors229,
  semanticLocalQ8Auto230,
  structuralLastChecked231,
  removeCodeLlmIndex232,
  removeLegacyVectorLedgers233,
  qualityHybrid234,
  appStudioCompanyRuntime235,
  companyAgentRunLifecycleStatuses236,
  appStudioV6Reset237,
  splitSemanticKnowledge238,
  subagentResearchPolicy239,
  mcpConnectionProfiles240,
  sessionExecutionMode241,
  repairLegacyKimiCodeProvider242,
  kimiCodeApiKeyOnly243,
  semanticItemsIdentityLookup244,
  docChunksEnrichmentLookup245,
  perfIndexes246,
  qualityProviderRequestsRepair247,
  subagentRunLifecycle248,
  sessionFilesystemRoots249,
  projectLspProfileOverrides250,
  controlPlaneFoundation251,
  controlPlaneAlignment252,
  providerAttemptTelemetry253,
  enableCodexSpark254,
  policyEngine255,
  policyComparisonLatency256,
  agentRunChildCardinality257,
  pendingAgentTransition258,
  coderOrchestrationCheckpoints259,
  masterPromptDeliveryAuthority260,
  pipelineBindingCleanup261,
  retireQualityClassifiers262,
  filesystemSessionCutover263,
  structuralRunPhaseTelemetry264,
  removeAgentPipelines265,
  removeDeadCodeRunSettings266,
  retireSpriteAndDesignSystem267,
  semanticJobLookup268,
  symbolReferenceKind269,
  retireAppStudioSkill270,
  structuralState271,
  pathCandidates272,
  structuralBuild273,
  mcpOAuthResource274,
  agentMemoryEvolution275,
  worktreeProjects276,
  semanticRecovery277,
  bundledGraniteEmbedding278,
  symbolReferenceTargetIndex279,
  fileContentFtsExclusion280,
  symbolFileLookup281,
  projectSemanticFolders282,
  projectSemanticTargets283,
  projectSemanticVectorWeight284,
  modelCatalogSearch285,
];

/**
 * Ensure the `schema_version` table exists and apply any pending migrations.
 * Safe to call on both fresh and existing databases.
 */
export function runMigrations(db: DB, options: { scope?: 'central' | 'project' } = {}): { applied: number[]; current: number } {
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
      if (options.scope === 'project' && migration.scope === 'central') {
        db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(migration.version, migration.name);
      } else if (migration.outsideTransaction) {
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
