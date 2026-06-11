/**
 * Public entry point for the Design System tools (DS Studio).
 *
 * `buildDesignSystemStudioTools(projectId)` é registrado na sessão single
 * de um projeto-workspace DS (`projects.builder_json.kind === 'ds'`);
 * store bindings continuam sendo fiados no boot (server.ts main +
 * coder-worker/company-worker por causa de worker_threads).
 *
 * The agent-facing tools are:
 *   - ds_get_session_info     — what package/stack/version are we on?
 *   - ds_record_component     — registra componente aprovado no draft.
 *   - ds_list_components      — draft vs última publicada (sincronia da galeria).
 *   - ds_audit_package        — deterministic pre-publish package checks
 *                                (perfil 'studio' — sem Storybook/bin).
 *   - ds_set_version_status   — flips a draft to 'failed' (only).
 *   - ds_publish_version      — finalises: hash, bump, publish to
 *                                Verdaccio, persist artefacts + skill global.
 */
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { studioBinding } from '@mcp/company/tools/design-system/binding.js';
import { dsGetSessionInfo } from '@mcp/company/tools/design-system/ds-get-session-info.js';
import { dsRecordComponent } from '@mcp/company/tools/design-system/ds-record-component.js';
import { dsListComponents } from '@mcp/company/tools/design-system/ds-list-components.js';
import { dsAuditPackage } from '@mcp/company/tools/design-system/ds-audit-package.js';
import { dsSetVersionStatus } from '@mcp/company/tools/design-system/ds-set-version-status.js';
import { dsPublishVersion } from '@mcp/company/tools/design-system/ds-publish-version.js';

export {
  setDesignSystemStore,
  getDesignSystemStore,
  setSkillStore as setDesignSystemSkillStore,
} from '@mcp/company/tools/design-system/store-binding.js';
export { companyBinding, studioBinding } from '@mcp/company/tools/design-system/binding.js';
export type { DsToolBinding, DsToolProfile } from '@mcp/company/tools/design-system/binding.js';
export { buildDesignSystemConsumerTools } from '@mcp/company/tools/design-system/consumer-tools.js';
export {
  resolveConsumerVersion,
  summarizeProps,
  manifestTokenNames,
  sortComponents,
} from '@mcp/company/tools/design-system/consumer-resolve.js';
export type { DsConsumerBinding } from '@mcp/company/tools/design-system/consumer-resolve.js';
export { dsGetSessionInfo } from '@mcp/company/tools/design-system/ds-get-session-info.js';
export { dsRecordComponent, ensureDraftVersion } from '@mcp/company/tools/design-system/ds-record-component.js';
export { dsListComponents } from '@mcp/company/tools/design-system/ds-list-components.js';
export { dsAuditPackage } from '@mcp/company/tools/design-system/ds-audit-package.js';
export { dsSetVersionStatus } from '@mcp/company/tools/design-system/ds-set-version-status.js';
export { dsPublishVersion } from '@mcp/company/tools/design-system/ds-publish-version.js';

/**
 * DS Studio set — sessão single sobre o projeto-workspace. Sem os gates
 * do pipeline company aposentado (`ds_validate_manifest`/`ds_validate_stories`
 * foram deletados junto com ele): o registro nasce de `ds_record_component`
 * aprovado pelo usuário no preview, e o manifest é warning do audit, não
 * contrato. `companyBinding` permanece exportado só para testes do audit.
 */
export function buildDesignSystemStudioTools(projectId: number): CoderTool[] {
  const binding = studioBinding(projectId);
  return [
    dsGetSessionInfo(binding),
    dsRecordComponent(binding),
    dsListComponents(binding),
    dsAuditPackage(binding),
    dsSetVersionStatus(binding),
    dsPublishVersion(binding),
  ];
}
