import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { err, ok } from '@mcp/code-agent/core/tool.js';
import { auditAppArchitecture } from '@mcp/app-studio/architecture/audit.js';
import { parseAppArchitecturePlan } from '@mcp/app-studio/architecture/types.js';
import { currentStage, parsePipelineState } from '@mcp/app-studio/pipeline/stages.js';
import { listSqlMigrations } from '@mcp/app-studio/pipeline/gate-checks.js';
import { appSeedHash } from '@mcp/app-studio/database/seed.js';
import { readDbStatus } from '@mcp/app-studio/status-files.js';
import { auditAppSpec } from '@mcp/app-studio/spec/audit.js';
import { parseAppSpec } from '@mcp/app-studio/spec/types.js';
import { auditAppUxBrief, auditAppWireframePlan } from '@mcp/app-studio/experience/audit.js';
import { parseAppUxBrief, parseAppWireframePlan } from '@mcp/app-studio/experience/types.js';
import { resolveHostPath } from '@mcp/company/tools/design-system/ds-publish-version.js';
import type { AppToolBinding } from './binding.js';
import { getAppStudioStore } from './store-binding.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    focus: {
      type: 'string',
      enum: ['spec', 'architecture', 'database', 'ux', 'wireframe', 'execution'],
      description: 'Optional specialist focus used to tailor the recommended next actions.',
    },
  },
  additionalProperties: false,
};

export function appGetContext(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_get_context',
    description:
      'Get one compact, authoritative App Studio context snapshot: current stage/status, spec and architecture revision state, database status, capabilities and safe next actions. Call this FIRST instead of guessing which write tool is valid.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async (args, ctx) => {
      try {
        const store = getAppStudioStore();
        if (!store) return err('app_get_context: AppStudioStore not wired. Restart the API worker and retry once.');
        const session = binding.resolveAppSession(store);
        if (!session) {
          return err(
            `No AppStudioSession bound to ${binding.describeBinding()}. Open this specialist from the App Studio project, not from a generic project chat.`,
          );
        }

        const state = parsePipelineState(session.pipeline_json);
        const current = state ? currentStage(state) : null;
        const spec = parseAppSpec(session.spec_json);
        const specRevision = store.getLatestApprovedSpecRevision(session.id);
        const specRevisions = store.listSpecRevisions(session.id);
        const pendingSpecRevision = store.getPendingSpecRevision(session.id);
        const architectureRevision = store.getLatestArchitectureRevision(session.id);
        const architecture = parseAppArchitecturePlan(architectureRevision?.architecture_json);
        const uxRevision = store.getLatestUxRevision(session.id);
        const ux = parseAppUxBrief(uxRevision?.ux_json);
        const wireframeRevision = store.getLatestWireframeRevision(session.id);
        const wireframe = parseAppWireframePlan(wireframeRevision?.wireframe_json);
        const resolved = resolveHostPath('.', ctx);
        const workspaceDir = resolved.kind === 'ok' ? resolved.path : null;
        const focus = typeof args.focus === 'string' ? args.focus : null;
        const discovery = state?.stages.find((stage) => stage.id === 'discovery') ?? null;
        const migrationFiles = workspaceDir ? listSqlMigrations(workspaceDir) : [];
        const dbStatus = workspaceDir ? readDbStatus(workspaceDir) : null;
        const currentSeedHash = workspaceDir ? appSeedHash(workspaceDir) : null;
        const pendingMigrations = migrationFiles.filter((name) => !dbStatus?.applied.includes(name));
        const seedNeedsSync = !!currentSeedHash && (!dbStatus?.seeded || dbStatus.seed_hash !== currentSeedHash);
        const databaseUpToDate = !!dbStatus?.local_ready && pendingMigrations.length === 0 && !seedNeedsSync && !dbStatus.last_error_phase;

        const capabilities = {
          save_initial_spec: !!state && discovery?.status !== 'approved',
          propose_spec_revision: discovery?.status === 'approved',
          spec_revision_waiting_for_user_approval: !!pendingSpecRevision,
          save_architecture: current?.id === 'architecture' && current.status !== 'review',
          save_ux: current?.id === 'ux' && current.status !== 'review',
          save_wireframe: current?.id === 'wireframe' && current.status !== 'review' && uxRevision?.status === 'approved',
          write_database_migration: current?.id === 'database' && current.status !== 'review' && dbStatus?.last_error_phase !== 'seed',
          replace_database_seed: current?.id === 'database' && current.status !== 'review',
          query_local_database: true,
          submit_current_stage: !!current && current.status !== 'review' && current.id !== 'launch',
          waiting_for_user_approval: current?.status === 'review',
        };

        const recommendedActions: string[] = [];
        if (!state) recommendedActions.push('Ask the user to initialize the App Studio pipeline from the journey panel.');
        else if (!spec) recommendedActions.push('Interview the user, then save the complete initial plan with app_save_spec.');
        else if (focus === 'architecture' && pendingSpecRevision) recommendedActions.push(`Stop architecture work. Spec revision v${pendingSpecRevision.revision_number} must be approved or rejected in Versions/Changes first.`);
        else if (focus === 'architecture' && current?.status === 'review') recommendedActions.push('Do not change the architecture while it awaits approval. If the user explicitly requested a product requirement change, propose a versioned spec revision; otherwise summarize the architecture and wait.');
        else if (current?.status === 'review') recommendedActions.push(`Stop changing '${current.id}'; summarize it and wait for the user to approve or reopen the stage.`);
        else if (focus === 'spec' && capabilities.propose_spec_revision) recommendedActions.push('Use app_propose_spec_revision; do not overwrite the approved spec.');
        else if (focus === 'spec') recommendedActions.push('Use app_save_spec, run app_spec_audit, then submit discovery when the user confirms.');
        else if (focus === 'architecture') recommendedActions.push('Research official docs, save the architecture, audit it, then submit architecture.');
        else if (focus === 'ux') recommendedActions.push('Read the approved plan, architecture and data. Guide the user through exactly three directions, save and audit the UX brief, then submit ux.');
        else if (focus === 'wireframe') recommendedActions.push('Read the approved UX direction and model every flow, screen state, data binding, browser test and ordered build group before submitting wireframe.');
        else if (focus === 'database' && dbStatus?.last_error_phase === 'seed') {
          recommendedActions.push(
            currentSeedHash && currentSeedHash !== dbStatus.seed_hash
              ? 'The canonical seed changed after the last seed failure. Retry app_provision_db; do not create a migration.'
              : 'The schema phase already finished but canonical examples failed. Call app_get_db_assets, replace seeds/seed.sql with app_save_db_seed, then retry app_provision_db. Do not create a migration.',
          );
        }
        else if (focus === 'database' && migrationFiles.length === 0 && capabilities.write_database_migration) recommendedActions.push('No schema migration exists. Compare the approved spec with the real schema, create the initial additive migration, save the canonical seed separately, then provision.');
        else if (focus === 'database' && pendingMigrations.length > 0) recommendedActions.push(`There are ${pendingMigrations.length} existing pending migration(s). Inspect them with app_get_db_assets before provisioning; do not create another migration.`);
        else if (focus === 'database' && databaseUpToDate) recommendedActions.push('The local database assets are synchronized. Inspect the real schema and a small sample with db_schema/read-only db_query. If they match the approved spec, submit database without creating or reapplying anything.');
        else if (focus === 'database' && capabilities.write_database_migration) recommendedActions.push('Call app_get_db_assets and inspect the real schema first. Create one additive migration only for a confirmed difference between the approved spec and actual schema.');
        else if (focus === 'database') recommendedActions.push('Analyze with db_schema/db_query. If the plan must change, propose a spec revision; database writes are unavailable until the database stage is current.');
        else if (current) recommendedActions.push(`Work only on the current '${current.id}' stage and submit it when its deterministic gate passes.`);

        return ok(JSON.stringify({
          app: { id: session.id, name: session.name, slug: session.app_slug, project_id: session.project_id, db_engine: session.db_engine },
          pipeline: {
            current: current ? { id: current.id, status: current.status, feedback: current.feedback, gate: current.gate } : null,
            stages: state?.stages.map((stage) => ({ id: stage.id, status: stage.status })) ?? [],
          },
          spec: {
            exists: !!spec,
            approved_revision_id: specRevision?.id ?? null,
            pending_revision: pendingSpecRevision ? { id: pendingSpecRevision.id, number: pendingSpecRevision.revision_number, status: pendingSpecRevision.status } : null,
            latest_revision: specRevisions[0] ? { id: specRevisions[0].id, status: specRevisions[0].status, number: specRevisions[0].revision_number } : null,
            summary: spec?.summary ?? null,
            counts: spec ? { features: spec.features.length, screens: spec.screens.length, entities: spec.database.entities.length, behaviors: spec.behaviors?.length ?? 0 } : null,
            audit: spec ? auditAppSpec(spec) : null,
          },
          architecture: {
            revision: architectureRevision ? { id: architectureRevision.id, number: architectureRevision.revision_number, status: architectureRevision.status, spec_revision_id: architectureRevision.spec_revision_id } : null,
            audit: architecture ? auditAppArchitecture(architecture, spec) : null,
          },
          ux: {
            revision: uxRevision ? { id: uxRevision.id, number: uxRevision.revision_number, status: uxRevision.status, spec_revision_id: uxRevision.spec_revision_id, architecture_revision_id: uxRevision.architecture_revision_id } : null,
            audit: ux ? auditAppUxBrief(ux) : null,
          },
          wireframe: {
            revision: wireframeRevision ? { id: wireframeRevision.id, number: wireframeRevision.revision_number, status: wireframeRevision.status, ux_revision_id: wireframeRevision.ux_revision_id } : null,
            counts: wireframe ? { flows: wireframe.flows.length, screens: wireframe.screens.length, groups: wireframe.build_groups.length, tasks: wireframe.tasks.length, tests: wireframe.tdd_cases.length } : null,
            audit: wireframe ? auditAppWireframePlan(wireframe, spec, architecture) : null,
          },
          database: {
            workspace_available: !!workspaceDir,
            migrations: migrationFiles,
            pending_migrations: pendingMigrations,
            seed_hash: currentSeedHash,
            seed_needs_sync: seedNeedsSync,
            up_to_date: databaseUpToDate,
            local_status: dbStatus,
          },
          capabilities,
          recommended_actions: recommendedActions,
        }, null, 2));
      } catch (e) {
        return err(`app_get_context failed: ${(e as Error).message}`);
      }
    },
  };
}
