import type {
  CompanyRuntimeKind,
  CompanySessionCapabilities,
} from '@mcp/company/types.js';
import type { AutonomyConfig } from '@mcp/company/services/autonomy/autonomy-config.js';

export type CompanyGenericSurface = 'kanban' | 'scheduler';

export interface CompanyServiceWiringPlan {
  initializeCompanyKanban: boolean;
  initializeCompanyScheduler: boolean;
  allowIncidentKanbanCards: boolean;
}

/** Stable error for a generic Company surface excluded by runtime capability. */
export class CompanyCapabilityUnavailableError extends Error {
  readonly code = 'COMPANY_CAPABILITY_UNAVAILABLE';

  constructor(
    readonly surface: CompanyGenericSurface,
    runtimeKind: CompanyRuntimeKind,
  ) {
    super(`Company ${surface} is unavailable for runtime '${runtimeKind}'.`);
    this.name = 'CompanyCapabilityUnavailableError';
  }
}

/** Constructor-level plan consumed by worker wiring (not merely tool/UI flags). */
export function resolveCompanyServiceWiringPlan(
  capabilities: CompanySessionCapabilities,
): CompanyServiceWiringPlan {
  const initializeCompanyKanban = capabilities.allowCompanyKanban;
  return {
    initializeCompanyKanban,
    initializeCompanyScheduler:
      initializeCompanyKanban && capabilities.allowCompanyScheduler,
    allowIncidentKanbanCards: initializeCompanyKanban,
  };
}

/** Resolve the immutable capability envelope from server-owned linkage. */
export function resolveCompanySessionCapabilities(
  runtimeKind: CompanyRuntimeKind,
  appStudioSessionId: string | null = null,
): CompanySessionCapabilities {
  if (runtimeKind === 'app_studio') {
    const linked = appStudioSessionId != null;
    return {
      runtimeKind,
      appStudioSessionId,
      promptProfile: 'app_studio',
      toolProfile: 'app_studio',
      autonomyPolicy: 'controlled_app_work',
      workSource: 'app_workflow',
      // Fail closed when the DB linkage is incomplete: the Company worker may
      // still expose lifecycle/recovery, but no App mutation surface starts.
      allowAppTools: linked,
      allowCompanyKanban: false,
      allowCompanyScheduler: false,
      allowAppScheduler: linked,
      allowFreeSubordinateSpawn: false,
    };
  }
  return {
    runtimeKind: 'company',
    appStudioSessionId: null,
    promptProfile: 'company',
    toolProfile: 'company',
    autonomyPolicy: 'company',
    workSource: 'company_kanban',
    allowAppTools: false,
    allowCompanyKanban: true,
    allowCompanyScheduler: true,
    allowAppScheduler: false,
    allowFreeSubordinateSpawn: true,
  };
}

/**
 * Apply the server-owned autonomy ceiling. App users may still freeze the
 * team, toggle its ready-work scheduler and lower the concurrency budget, but
 * generic Company defaults can never auto-approve every specialist or reset
 * Company Kanban cards behind the App workflow.
 */
export function constrainAutonomyForCapabilities(
  capabilities: CompanySessionCapabilities,
  configured: AutonomyConfig,
): AutonomyConfig {
  if (capabilities.autonomyPolicy !== 'controlled_app_work') return configured;
  return {
    ...configured,
    autoApproveRoles: null,
    orphanReset: false,
    wipLimits: {},
  };
}
