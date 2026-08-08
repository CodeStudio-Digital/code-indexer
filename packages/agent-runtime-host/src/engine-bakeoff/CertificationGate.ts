import type { OssEngineRunResult } from './types.js';

export type OssEngineCertificationStatus =
  | 'rejected'
  | 'read_only_spike_ready'
  | 'toolhost_spike_ready';

export interface OssEngineCertificationInput {
  result: OssEngineRunResult;
  expectedToolCalls?: number;
  dynamicToolApiStable: boolean;
  supervisorOwned?: boolean;
  processTreeReaped: boolean;
  resourceLimitsEnforced: boolean;
}

export interface OssEngineCertificationReport {
  status: OssEngineCertificationStatus;
  blockers: readonly string[];
  observations: readonly string[];
}

export function certifyOssEngineRun(
  input: OssEngineCertificationInput,
): OssEngineCertificationReport {
  const blockers: string[] = [];
  const observations: string[] = [];
  const { metrics } = input.result;

  if (input.result.status === 'failed') blockers.push('turn_failed');
  if (input.supervisorOwned === false) {
    blockers.push('durable_supervisor_ownership_not_proven');
  }
  if (metrics.observedBypassToolCount > 0) blockers.push('tool_host_bypass_observed');
  if (!metrics.temporaryStateDeleted) blockers.push('temporary_engine_state_not_deleted');
  if (!input.processTreeReaped) blockers.push('process_tree_not_reaped');
  if (!input.resourceLimitsEnforced) blockers.push('resource_limits_not_enforced');
  if (input.expectedToolCalls !== undefined && metrics.toolCallCount !== input.expectedToolCalls) {
    blockers.push('tool_call_count_mismatch');
  }
  if (!input.dynamicToolApiStable) observations.push('dynamic_tool_api_is_experimental');
  if (metrics.deniedBuiltInRequestCount > 0) {
    observations.push('built_in_requests_denied_fail_closed');
  }

  if (blockers.length > 0) return { status: 'rejected', blockers, observations };
  return {
    status: input.dynamicToolApiStable ? 'toolhost_spike_ready' : 'read_only_spike_ready',
    blockers,
    observations,
  };
}
