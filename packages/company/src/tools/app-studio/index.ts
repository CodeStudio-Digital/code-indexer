/**
 * Public entry point for the App Studio tools (Code Studio para leigos).
 *
 * `buildAppStudioTools(projectId)` é registrado na sessão single de um
 * projeto-workspace app (`projects.builder_json.kind === 'app'`); store
 * bindings continuam sendo fiados no boot (server.ts main +
 * coder-worker/company-worker por causa de worker_threads).
 *
 * The agent-facing tools are:
 *   - app_get_pipeline    — etapas + corrente + roadmap + resumo da spec.
 *   - app_get_spec        — a AppSpec completa.
 *   - app_get_spec_history— revisões/evoluções da spec.
 *   - app_save_spec       — valida e grava a spec da entrevista (+roadmap).
 *   - app_propose_spec_revision — evolução versionada (auto-abre a evolução).
 *     (app_create_evolution NÃO é tool de agente: redundante com a rota HTTP
 *      da UI e com o auto-create do propose; modelos fracos a confundiam com
 *      app_provision_db e entravam em loop. Criação de evolução: só UI/rota.)
 *   - app_spec_audit      — auditoria deterministica da qualidade da spec.
 *   - app_submit_stage    — gate determinístico → review → STOP.
 *   - app_record_feature  — registra deliverable (cobertura do roadmap).
 *   - app_list_features   — cobertura registrados × roadmap.
 *   - app_get_db_assets   — estado real dos assets de migração e seed.
 *   - app_save_db_migration — uma evolução aditiva e versionada do schema.
 *   - app_save_db_seed    — substitui o seed canônico com backup.
 *   - app_save_tdd_test   — testes de banco limitados a tests/worker.
 *   - app_provision_db    — migrations no banco LOCAL + db.json do gate.
 */
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { appStudioBinding } from '@mcp/company/tools/app-studio/binding.js';
import { appGetPipeline } from '@mcp/company/tools/app-studio/app-get-pipeline.js';
import { appGetSpec } from '@mcp/company/tools/app-studio/app-get-spec.js';
import { appGetSpecHistory } from '@mcp/company/tools/app-studio/app-get-spec-history.js';
import { appSaveSpec } from '@mcp/company/tools/app-studio/app-save-spec.js';
import { appProposeSpecRevision } from '@mcp/company/tools/app-studio/app-propose-spec-revision.js';
import { appSpecAudit } from '@mcp/company/tools/app-studio/app-spec-audit.js';
import { appSubmitStage } from '@mcp/company/tools/app-studio/app-submit-stage.js';
import { appRecordFeature } from '@mcp/company/tools/app-studio/app-record-feature.js';
import { appListFeatures } from '@mcp/company/tools/app-studio/app-list-features.js';
import { appProvisionDb } from '@mcp/company/tools/app-studio/app-provision-db.js';
import { appGetArchitecture } from '@mcp/company/tools/app-studio/app-get-architecture.js';
import { appSaveArchitecture } from '@mcp/company/tools/app-studio/app-save-architecture.js';
import { appArchitectureAudit } from '@mcp/company/tools/app-studio/app-architecture-audit.js';
import { appFetchArchitectureDoc, appSearchArchitectureDocs } from '@mcp/company/tools/app-studio/app-architecture-docs.js';
import { appRunTestCycle } from '@mcp/company/tools/app-studio/app-run-test-cycle.js';
import { appGetContext } from '@mcp/company/tools/app-studio/app-get-context.js';
import { appSaveDbMigration } from '@mcp/company/tools/app-studio/app-save-db-migration.js';
import { appGetDbAssets } from '@mcp/company/tools/app-studio/app-get-db-assets.js';
import { appSaveDbSeed } from '@mcp/company/tools/app-studio/app-save-db-seed.js';
import { appSaveTddTest } from '@mcp/company/tools/app-studio/app-save-tdd-test.js';
import { appGetUx, appGetWireframe, appSaveUx, appSaveWireframe, appUxAudit, appWireframeAudit } from '@mcp/company/tools/app-studio/app-experience.js';
import { appCompleteBuildTask, appGetBuildPlan, appSubmitBuildGroup } from '@mcp/company/tools/app-studio/app-build-plan.js';
import { appFetchUxReference } from '@mcp/company/tools/app-studio/app-ux-reference.js';

export { setAppStudioStore, getAppStudioStore } from '@mcp/company/tools/app-studio/store-binding.js';
export {
  ensureAppStudioDbConnection,
  getAppStudioDbClientStore,
  setAppStudioDbClientStore,
} from '@mcp/company/tools/app-studio/db-client-bridge.js';
export { appStudioBinding } from '@mcp/company/tools/app-studio/binding.js';
export type { AppToolBinding } from '@mcp/company/tools/app-studio/binding.js';

export function buildAppStudioTools(projectId: number): CoderTool[] {
  const binding = appStudioBinding(projectId);
  return [
    appGetContext(binding),
    appGetPipeline(binding),
    appGetSpec(binding),
    appGetSpecHistory(binding),
    appSaveSpec(binding),
    appProposeSpecRevision(binding),
    appSpecAudit(binding),
    appGetArchitecture(binding),
    appSaveArchitecture(binding),
    appArchitectureAudit(binding),
    appSearchArchitectureDocs,
    appFetchArchitectureDoc,
    appRunTestCycle(binding),
    appGetUx(binding),
    appSaveUx(binding),
    appUxAudit(binding),
    appFetchUxReference,
    appGetWireframe(binding),
    appSaveWireframe(binding),
    appWireframeAudit(binding),
    appGetBuildPlan(binding),
    appCompleteBuildTask(binding),
    appSubmitBuildGroup(binding),
    appGetDbAssets(binding),
    appSaveDbMigration(binding),
    appSaveDbSeed(binding),
    appSaveTddTest(binding),
    appSubmitStage(binding),
    appRecordFeature(binding),
    appListFeatures(binding),
    appProvisionDb(binding),
  ];
}
