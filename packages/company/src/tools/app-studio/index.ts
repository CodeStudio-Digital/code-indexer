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
 *   - app_save_spec       — valida e grava a spec da entrevista (+roadmap).
 *   - app_submit_stage    — gate determinístico → review → STOP.
 *   - app_record_feature  — registra deliverable (cobertura do roadmap).
 *   - app_list_features   — cobertura registrados × roadmap.
 *   - app_provision_db    — migrations no banco LOCAL + db.json do gate.
 */
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { appStudioBinding } from '@mcp/company/tools/app-studio/binding.js';
import { appGetPipeline } from '@mcp/company/tools/app-studio/app-get-pipeline.js';
import { appGetSpec } from '@mcp/company/tools/app-studio/app-get-spec.js';
import { appSaveSpec } from '@mcp/company/tools/app-studio/app-save-spec.js';
import { appSubmitStage } from '@mcp/company/tools/app-studio/app-submit-stage.js';
import { appRecordFeature } from '@mcp/company/tools/app-studio/app-record-feature.js';
import { appListFeatures } from '@mcp/company/tools/app-studio/app-list-features.js';
import { appProvisionDb } from '@mcp/company/tools/app-studio/app-provision-db.js';

export { setAppStudioStore, getAppStudioStore } from '@mcp/company/tools/app-studio/store-binding.js';
export { appStudioBinding } from '@mcp/company/tools/app-studio/binding.js';
export type { AppToolBinding } from '@mcp/company/tools/app-studio/binding.js';

export function buildAppStudioTools(projectId: number): CoderTool[] {
  const binding = appStudioBinding(projectId);
  return [
    appGetPipeline(binding),
    appGetSpec(binding),
    appSaveSpec(binding),
    appSubmitStage(binding),
    appRecordFeature(binding),
    appListFeatures(binding),
    appProvisionDb(binding),
  ];
}
