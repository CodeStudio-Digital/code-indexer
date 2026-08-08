import type {
  CompanyRuntimeKind,
  CompanySessionCapabilities,
} from '@mcp/company-contracts';

/**
 * Minimal Company context needed to decide whether the coder-local ephemeral
 * agent runtime may be registered. Keeping this decision outside the large
 * runCoder assembly makes the App capability boundary directly testable.
 */
export interface EphemeralSubagentCompanyContext {
  isMaster: boolean;
  runtimeKind?: CompanyRuntimeKind;
  capabilities?: CompanySessionCapabilities;
}

/**
 * Solo coder sessions and generic Company specialists retain spawn_agent.
 * Company Masters delegate through their persistent lifecycle, while App
 * specialists must never escape into the global ephemeral/subagent model
 * override. The runtime-kind fallback keeps old/incomplete App contexts
 * fail-closed even before their derived capabilities have been attached.
 */
export function shouldEnableEphemeralSubagents(
  companyContext: EphemeralSubagentCompanyContext | null | undefined,
  globallyDisabled = false,
): boolean {
  if (globallyDisabled) return false;
  if (!companyContext) return true;
  if (companyContext.isMaster) return false;
  return companyContext.capabilities?.allowFreeSubordinateSpawn
    ?? companyContext.runtimeKind !== 'app_studio';
}
