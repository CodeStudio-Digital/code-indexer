import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { err } from '@mcp/code-agent/core/tool.js';
import { auditAppArchitecture } from '@mcp/app-studio/architecture/audit.js';
import { parseAppArchitecturePlan } from '@mcp/app-studio/architecture/types.js';
import { parseAppWorkflowState } from '@mcp/app-studio/workflow/state.js';
import { listSqlMigrations } from '@mcp/app-studio/verification/workspace-checks.js';
import { appSeedHash } from '@mcp/app-studio/database/seed.js';
import { readDbStatus } from '@mcp/app-studio/status-files.js';
import { auditAppSpec } from '@mcp/app-studio/spec/audit.js';
import { parseAppSpec } from '@mcp/app-studio/spec/types.js';
import { auditAppUxBrief, auditAppWireframePlan } from '@mcp/app-studio/experience/audit.js';
import { parseAppUxBrief, parseAppWireframePlan } from '@mcp/app-studio/experience/types.js';
import { auditAppProductModel } from '@mcp/app-studio/product/audit.js';
import { parseAppProductModel, productModelFingerprint } from '@mcp/app-studio/product/types.js';
import { resolveHostPath } from '@mcp/company/tools/design-system/ds-publish-version.js';
import type { AppToolBinding } from './binding.js';
import { getAppStudioStore } from './store-binding.js';
import { appResult, compactAudit } from './model-output.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    focus: {
      type: 'string',
      enum: ['spec', 'product', 'architecture', 'database', 'ux', 'wireframe', 'execution'],
      description: 'Optional coordinator focus used to tailor the recommended next actions.',
    },
  },
  additionalProperties: false,
};

export function appGetContext(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_get_context',
    description:
      'Get one compact, authoritative App Studio context snapshot: current macro phase, revisions, database status, capabilities and safe next actions. Call this before choosing an artifact write tool.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async (args, ctx) => {
      try {
        const store = getAppStudioStore();
        if (!store) return err('app_get_context: AppStudioStore not wired. Restart the API worker and retry once.');
        const session = binding.resolveAppSession(store);
        if (!session) {
          return err(
            `No AppStudioSession bound to ${binding.describeBinding()}. Use the persistent coordinator attached to the App Studio project.`,
          );
        }

        const state = parseAppWorkflowState(session.pipeline_json);
        const current = state?.phases.find((phase) => phase.status === 'active' || phase.status === 'attention') ?? null;
        const spec = parseAppSpec(session.spec_json);
        const specRevision = store.getLatestApprovedSpecRevision(session.id);
        const specRevisions = store.listSpecRevisions(session.id);
        const pendingSpecRevision = store.getPendingSpecRevision(session.id);
        const architectureRevision = store.getLatestArchitectureRevision(session.id);
        const architecture = parseAppArchitecturePlan(architectureRevision?.architecture_json);
        const productRevision = store.getLatestProductRevision(session.id);
        const product = parseAppProductModel(productRevision?.product_json);
        const uxRevision = store.getLatestUxRevision(session.id);
        const ux = parseAppUxBrief(uxRevision?.ux_json);
        const wireframeRevision = store.getLatestWireframeRevision(session.id);
        const wireframe = parseAppWireframePlan(wireframeRevision?.wireframe_json);
        const resolved = resolveHostPath('.', ctx);
        const workspaceDir = resolved.kind === 'ok' ? resolved.path : null;
        const focus = typeof args.focus === 'string' ? args.focus : null;
        const approvals = store.listApprovals(session.id);
        const latestScope = approvals.filter((item) => item.type === 'scope' && item.status !== 'superseded').sort((a, b) => b.bundle_revision - a.bundle_revision)[0] ?? null;
        const define = state?.phases.find((phase) => phase.id === 'define') ?? null;
        const blueprintPhase = state?.phases.find((phase) => phase.id === 'blueprint') ?? null;
        const buildPhase = state?.phases.find((phase) => phase.id === 'build') ?? null;
        const migrationFiles = workspaceDir ? listSqlMigrations(workspaceDir) : [];
        const dbStatus = workspaceDir ? readDbStatus(workspaceDir) : null;
        const currentSeedHash = workspaceDir ? appSeedHash(workspaceDir) : null;
        const pendingMigrations = migrationFiles.filter((name) => !dbStatus?.applied.includes(name));
        const seedNeedsSync = !!currentSeedHash && (!dbStatus?.seeded || dbStatus.seed_hash !== currentSeedHash);
        const databaseUpToDate = !!dbStatus?.local_ready && pendingMigrations.length === 0 && !seedNeedsSync && !dbStatus.last_error_phase;

        const capabilities = {
          save_initial_spec: !!state && define?.status !== 'complete',
          save_product: define?.status === 'active' || define?.status === 'attention',
          propose_spec_revision: latestScope?.status === 'approved',
          spec_revision_waiting_for_user_approval: !!pendingSpecRevision,
          save_architecture: blueprintPhase?.status === 'active' || blueprintPhase?.status === 'attention',
          save_ux: blueprintPhase?.status === 'active' || blueprintPhase?.status === 'attention',
          save_wireframe: (blueprintPhase?.status === 'active' || blueprintPhase?.status === 'attention') && !!uxRevision,
          write_database_migration: (blueprintPhase?.status === 'active' || buildPhase?.status === 'active') && dbStatus?.last_error_phase !== 'seed',
          replace_database_seed: blueprintPhase?.status === 'active' || buildPhase?.status === 'active',
          query_local_database: true,
          request_macro_approval: !!current && current.status === 'active' && current.id !== 'build',
          waiting_for_user_approval: approvals.some((item) => item.status === 'pending'),
        };

        const recommendedActions: string[] = [];
        if (!state) recommendedActions.push('Open the App Studio journey once to migrate the saved app into workflow v5.');
        else if (!spec) recommendedActions.push('Interview the user, then save the complete initial plan with app_save_spec.');
        else if (focus === 'architecture' && pendingSpecRevision) recommendedActions.push(`Pause only architecture cards tied to spec revision v${pendingSpecRevision.revision_number}; continue independent ready cards while its decision remains pending.`);
        else if (focus === 'spec' && capabilities.propose_spec_revision) recommendedActions.push('Use app_propose_spec_revision; do not overwrite the approved spec.');
        else if (focus === 'spec') recommendedActions.push('Use app_save_spec, run app_spec_audit, finish the product model and request Scope approval once.');
        else if (focus === 'product') recommendedActions.push('Persist domains, capabilities and scenarios, audit, then request the single Scope approval.');
        else if (focus === 'architecture') recommendedActions.push('Research official docs, save and audit architecture, then continue the shared Blueprint without a separate approval.');
        else if (focus === 'ux') recommendedActions.push('Create three directions, save the chosen direction and continue the shared Blueprint without a separate approval.');
        else if (focus === 'wireframe') recommendedActions.push('Model flows and vertical slices, create traceable Kanban cards, then request the single Blueprint approval.');
        else if (focus === 'database' && dbStatus?.last_error_phase === 'seed') {
          recommendedActions.push(
            currentSeedHash && currentSeedHash !== dbStatus.seed_hash
              ? 'The canonical seed changed after the last seed failure. Retry app_provision_db; do not create a migration.'
              : 'The schema phase already finished but canonical examples failed. Call app_get_db_assets, replace seeds/seed.sql with app_save_db_seed, then retry app_provision_db. Do not create a migration.',
          );
        }
        else if (focus === 'database' && migrationFiles.length === 0 && capabilities.write_database_migration) recommendedActions.push('No schema migration exists. Compare the approved spec with the real schema, create the initial additive migration, save the canonical seed separately, then provision.');
        else if (focus === 'database' && pendingMigrations.length > 0) recommendedActions.push(`There are ${pendingMigrations.length} existing pending migration(s). Inspect them with app_get_db_assets before provisioning; do not create another migration.`);
        else if (focus === 'database' && databaseUpToDate) recommendedActions.push('The local database assets are synchronized. Inspect the real schema and a small sample with db_schema/read-only db_query, then record that evidence on the related verification card.');
        else if (focus === 'database' && capabilities.write_database_migration) recommendedActions.push('Call app_get_db_assets and inspect the real schema first. Create one additive migration only for a confirmed difference between the approved spec and actual schema.');
        else if (focus === 'database') recommendedActions.push('Analyze with db_schema/db_query. If Scope must change, create a versioned change card; otherwise work inside the Blueprint/build slice.');
        else if (current) recommendedActions.push(`Work from the '${current.id}' macro phase and continue independent Kanban cards while approvals are pending.`);

        return appResult('App Studio context', {
          app: { id: session.id, name: session.name, slug: session.app_slug, project_id: session.project_id, db_engine: session.db_engine },
          workflow: {
            current: current ? { id: current.id, status: current.status } : null,
            phases: state?.phases.map((phase) => ({ id: phase.id, status: phase.status })) ?? [],
            pending_approvals: approvals.filter((item) => item.status === 'pending').map((item) => ({ id: item.id, type: item.type })),
          },
          spec: {
            exists: !!spec,
            approved_revision_id: specRevision?.id ?? null,
            pending_revision: pendingSpecRevision ? { id: pendingSpecRevision.id, number: pendingSpecRevision.revision_number, status: pendingSpecRevision.status } : null,
            latest_revision: specRevisions[0] ? { id: specRevisions[0].id, status: specRevisions[0].status, number: specRevisions[0].revision_number } : null,
            summary: spec?.summary ?? null,
            counts: spec ? { features: spec.features.length, screens: spec.screens.length, entities: spec.database.entities.length, behaviors: spec.behaviors?.length ?? 0 } : null,
            audit: spec ? compactAudit(auditAppSpec(spec)) : null,
          },
          product: {
            revision: productRevision ? { id: productRevision.id, number: productRevision.revision_number, status: productRevision.status, base_spec_revision_id: productRevision.base_spec_revision_id, result_spec_revision_id: productRevision.result_spec_revision_id } : null,
            counts: product ? { domains: product.domains.length, capabilities: product.capabilities.length, selected: product.capabilities.filter((item) => item.selected).length, scenarios: product.scenarios.length, open_decisions: product.decisions.filter((item) => item.status === 'open').length } : null,
            complexity: product?.complexity ?? null,
            fingerprint: product ? productModelFingerprint(product) : null,
            audit: product ? compactAudit(auditAppProductModel(product)) : null,
          },
          architecture: {
            revision: architectureRevision ? { id: architectureRevision.id, number: architectureRevision.revision_number, status: architectureRevision.status, spec_revision_id: architectureRevision.spec_revision_id } : null,
            audit: architecture ? compactAudit(auditAppArchitecture(architecture, spec, product)) : null,
          },
          ux: {
            revision: uxRevision ? { id: uxRevision.id, number: uxRevision.revision_number, status: uxRevision.status, spec_revision_id: uxRevision.spec_revision_id, architecture_revision_id: uxRevision.architecture_revision_id } : null,
            audit: ux ? compactAudit(auditAppUxBrief(ux)) : null,
          },
          wireframe: {
            revision: wireframeRevision ? { id: wireframeRevision.id, number: wireframeRevision.revision_number, status: wireframeRevision.status, ux_revision_id: wireframeRevision.ux_revision_id } : null,
            counts: wireframe ? { flows: wireframe.flows.length, screens: wireframe.screens.length, slices: wireframe.delivery_slices.length, checklist_items: wireframe.checklist_items.length, tests: wireframe.tdd_cases.length } : null,
            audit: wireframe ? compactAudit(auditAppWireframePlan(wireframe, spec, architecture)) : null,
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
        });
      } catch (e) {
        return err(`app_get_context failed: ${(e as Error).message}`);
      }
    },
  };
}
