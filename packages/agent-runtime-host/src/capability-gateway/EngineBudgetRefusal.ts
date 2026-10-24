import type { agentV1SessionStore as wire } from '@mcp/agent-runtime-contracts';

/** Recognizes an engine-owned stop, never a Host policy decision or a grant. */
export function isEngineBudgetRefusal(record: wire.EngineEventRecordV1, now: bigint): boolean {
  return isEngineStopRefusal(record, now, 'tool-budget:', 'sealed-run-tree-budget:v1', 'max_tool_calls');
}

/** A workspace boundary may only refuse unopened invocations. As with a
 * budget stop, this cannot create a grant or authorize a physical effect. */
export function isEngineWorkspaceRefusal(record: wire.EngineEventRecordV1, now: bigint): boolean {
  return isEngineStopRefusal(record, now, 'workspace-transition:', 'sealed-workspace-transition:v1', 'workspace_transition');
}

function isEngineStopRefusal(record: wire.EngineEventRecordV1, now: bigint,
  namespace: string, policy: string, reason: string): boolean {
  if (record.body.case !== 'capabilityRefused' || !record.identity) return false;
  const value = record.body.value;
  const prefix = namespace + record.identity.attemptId + ':';
  if (value.policyVersion !== policy || value.reasonCode !== reason
    || !value.decisionId.startsWith(prefix) || value.decidedAtUnixMs <= 0n || value.decidedAtUnixMs > now + 50n
    || !value.toolUseId || value.toolUseId.includes('\0')) return false;
  const ordinal = value.decisionId.slice(prefix.length).match(/^([1-9][0-9]*):(0|[1-9][0-9]*)$/);
  if (!ordinal || BigInt(ordinal[1]) > 18_446_744_073_709_551_615n || BigInt(ordinal[2]) >= 256n) return false;
  const providers = ['provider-turn:' + record.identity.attemptId + (ordinal[1] === '1' ? '' : ':' + ordinal[1])];
  if (ordinal[1] === '1') providers.push('codex-turn:' + record.identity.attemptId);
  return providers.some(provider => value.operationId === 'capability:' + Buffer.byteLength(provider) + ':' + provider + ':' + value.toolUseId);
}
