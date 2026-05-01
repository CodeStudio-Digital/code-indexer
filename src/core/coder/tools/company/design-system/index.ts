/**
 * Public entry point for Design System Creator company tools.
 *
 * Mirrors the QA module's surface: a single `buildDesignSystemTools`
 * factory + the store binding setter that `server.ts` calls at boot.
 *
 * The agent-facing tools are:
 *   - ds_get_session_info     — what package/stack/version are we on?
 *   - ds_record_component     — extractor / components-builder logs each
 *                                component or page template into the
 *                                active draft.
 *   - ds_validate_manifest    — blocks shallow extractor manifests before
 *                                builders turn them into broken code.
 *   - ds_validate_stories     — Phase 2 gate: every argTypes/args/options
 *                                must match Props + manifest props_schema
 *                                (the "Button v1.2.2" defence).
 *   - ds_audit_package        — deterministic pre-publish package checks.
 *   - ds_set_version_status   — master flips a draft to 'failed' (only).
 *   - ds_publish_version      — master finalises: hash, bump, publish to
 *                                Verdaccio, persist artefacts.
 */
import type { CoderTool } from '../../../core/tool.js';
import type { CompanyOrchestrator } from '../../../company/orchestrator.js';
import { dsGetSessionInfo } from './ds-get-session-info.js';
import { dsRecordComponent } from './ds-record-component.js';
import { dsValidateManifest } from './ds-validate-manifest.js';
import { dsValidateStories } from './ds-validate-stories.js';
import { dsAuditPackage } from './ds-audit-package.js';
import { dsSetVersionStatus } from './ds-set-version-status.js';
import { dsPublishVersion } from './ds-publish-version.js';

export {
  setDesignSystemStore,
  getDesignSystemStore,
  setSkillStore as setDesignSystemSkillStore,
} from './store-binding.js';
export { dsGetSessionInfo } from './ds-get-session-info.js';
export { dsRecordComponent, ensureDraftVersion } from './ds-record-component.js';
export { dsValidateManifest } from './ds-validate-manifest.js';
export { dsValidateStories } from './ds-validate-stories.js';
export { dsAuditPackage } from './ds-audit-package.js';
export { dsSetVersionStatus } from './ds-set-version-status.js';
export { dsPublishVersion } from './ds-publish-version.js';

export function buildDesignSystemTools(
  orchestrator: CompanyOrchestrator,
  agentRole: string,
  agentRunId: number | null,
): CoderTool[] {
  return [
    dsGetSessionInfo(orchestrator, agentRole, agentRunId),
    dsRecordComponent(orchestrator, agentRole, agentRunId),
    dsValidateManifest(orchestrator, agentRole, agentRunId),
    dsValidateStories(orchestrator, agentRole, agentRunId),
    dsAuditPackage(orchestrator, agentRole, agentRunId),
    dsSetVersionStatus(orchestrator, agentRole, agentRunId),
    dsPublishVersion(orchestrator, agentRole, agentRunId),
  ];
}
