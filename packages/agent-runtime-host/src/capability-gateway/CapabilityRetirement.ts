import { agentV1Capability as capability, agentV1SessionStore as store } from '@mcp/agent-runtime-contracts';
import { CapabilityGatewayError } from './CapabilityGatewayError.js';

/** Check the durable engine terminal against the Host decision/result before
 * releasing potentially large input/result buffers. An uncertain effect is
 * also retired: its tombstone permanently prohibits another dispatch. */
export function validateCapabilityRetirement(record: store.EngineEventRecordV1,
  decision: capability.CapabilityUpdate, result?: capability.CapabilityExecutionResult): void {
  const body = record.body;
  if (body.case === 'capabilityRefused') {
    const rejected = decision.decision;
    if (rejected.case !== 'rejected' || result || body.value.toolUseId !== decision.toolUseId
      || body.value.decisionId !== rejected.value.decisionId
      || body.value.reasonCode !== rejected.value.reasonCode
      || body.value.policyVersion !== rejected.value.policyVersion
      || body.value.decidedAtUnixMs !== rejected.value.decidedAtUnixMs) throw conflict();
    return;
  }
  if (body.case !== 'capabilityTerminal' || decision.decision.case !== 'accepted') throw conflict();
  const terminal = body.value;
  const grant = decision.decision.value;
  if (terminal.toolUseId !== decision.toolUseId || terminal.grantId !== grant.grantId) throw conflict();
  if (!result) {
    if (grant.executionClass === capability.CapabilityExecutionClass.NATIVE_READ) return;
    if (terminal.classification === store.EngineCapabilityTerminalClassificationV1.CANCELLED
      && terminal.reasonCode === 'authority_revoked_before_effect') return;
    throw conflict();
  }
  const outcome = result.outcome;
  const classification = {
    succeeded: store.EngineCapabilityTerminalClassificationV1.SUCCEEDED,
    failed: store.EngineCapabilityTerminalClassificationV1.FAILED,
    cancelled: store.EngineCapabilityTerminalClassificationV1.CANCELLED,
    outcomeUnknown: store.EngineCapabilityTerminalClassificationV1.OUTCOME_UNKNOWN,
  };
  if (!outcome.case || terminal.classification !== classification[outcome.case]
    || terminal.durationMs !== outcome.value.durationMs) throw conflict();
  if (outcome.case === 'succeeded') {
    if (terminal.resultSchemaId !== outcome.value.schemaId || terminal.resultSchemaVersion !== outcome.value.schemaVersion
      || terminal.resultBytes !== outcome.value.bytesEmitted || terminal.truncated !== outcome.value.truncated
      || !Buffer.from(terminal.resultSha256).equals(Buffer.from(outcome.value.resultSha256))) throw conflict();
  } else if (terminal.reasonCode !== outcome.value.reasonCode) throw conflict();
}

function conflict() { return new CapabilityGatewayError('operation_conflict', 'capability retirement contradicts its decision or execution'); }
