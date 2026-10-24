import type { AppStudioWorkItem } from '@mcp/store/app-studio-store.js';
import type { AllowedModel, AgentRunStatus, CompanyAgentDispatchSource, RoleSkills } from '@mcp/company/types.js';
export interface AppRoleRuntime {
  provider?: string;
  model?: string;
  tier?: string;
  skills?: RoleSkills;
  systemPromptOverride?: string;
  projectIds?: number[];
  temperature?: number;
  thinking?: boolean;
  thinkingBudgetTokens?: number;
  reasoningEffort?: string;
  enabled?: boolean;
  fallbackModels?: AllowedModel[];
}

export type MaybePromise<T> = T | Promise<T>;

export interface AppSubordinateSnapshot {
  agentRunId: string;
  role: string;
  status: AgentRunStatus;
  projectIds: number[];
  provider: string;
  model: string;
  coderSessionId: string;
  isAlive: boolean;
}

export interface AppDispatchCapacity {
  concurrencyLimit: number;
  activeConcurrent: number;
  maxSubordinates: number | null;
  activeSubordinates: number;
}

export interface AppAgentRuntimeProvenance {
  configuredProvider: string;
  configuredModel: string;
  effectiveProvider: string;
  effectiveModel: string;
  dispatchSource: CompanyAgentDispatchSource;
  fallbackReason: string | null;
}

export interface AppCompanyDispatchHost {
  getRoleDefaults(role: string): MaybePromise<AppRoleRuntime | null>;
  listSubordinates(): MaybePromise<AppSubordinateSnapshot[]>;
  spawnSubordinate(spec: {
    role: string;
    task: string;
    projectId?: number;
    wait?: boolean;
    dispatchSource?: CompanyAgentDispatchSource;
  }): Promise<{ agentRunId: string; coderSessionId: string; status: AgentRunStatus }>;
  reactivateSubordinate(
    agentRunId: string,
    message: string,
    attachments?: never[],
    thinking?: boolean,
  ): Promise<boolean>;
  /**
   * Live capacity snapshot from the owning Company runtime. Waiting agents
   * still consume the global maxSubordinates budget, but can be reactivated
   * without allocating another global slot.
   */
  getAppDispatchCapacity(): MaybePromise<AppDispatchCapacity>;
  getAppAgentRuntimeProvenance(
    agentRunId: string,
  ): MaybePromise<AppAgentRuntimeProvenance | null>;
}

export interface AppCompanyDispatchResult {
  workItemId: string;
  role: string;
  outcome: 'spawned' | 'reused' | 'skipped' | 'blocked';
  code?: 'OUTCOME_UNKNOWN';
  workItemRunId?: string;
  companyAgentRunId?: string;
  coderSessionId?: string;
  detail?: string;
}

export type AppWorkItem = Omit<AppStudioWorkItem,
  'depends_on_json' | 'source_ids_json' | 'acceptance_json' | 'evidence_json' | 'file_scope_json'
> & {
  depends_on: string[];
  source_ids: string[];
  acceptance: string[];
  evidence: Array<Record<string, unknown>>;
  file_scope: string[];
};
