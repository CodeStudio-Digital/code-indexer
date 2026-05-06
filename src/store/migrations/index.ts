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

type DB = InstanceType<typeof DatabaseConstructor>;

export interface Migration {
  version: number;
  name: string;
  up: (db: DB) => void;
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

    const tx = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(
        migration.version,
        migration.name
      );
    });

    try {
      tx();
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
