import { clone } from '@bufbuild/protobuf';
import { agentV1Capability as wire } from '@mcp/agent-runtime-contracts';
import type { HostDataBoundContext } from '../ipc/HostDataAttemptChannelValidation.js';
import { attemptIdentityEqual } from '../ipc/FrameHeaderValidation.js';
import { CapabilityGatewayError } from './CapabilityGatewayError.js';
import { validateCapabilityExecute } from './CapabilityExecutionValidation.js';
import type { HostCapabilityExecutor, ValidatedCapabilityPrepare } from './CapabilityGatewayTypes.js';

export async function validateCapabilityReadBatch(value: wire.CapabilityReadBatchExecute,
  context: HostDataBoundContext, now: () => bigint,
  lookup: (id: string) => { request: ValidatedCapabilityPrepare; result: Promise<wire.CapabilityUpdate> } | undefined,
  executor?: HostCapabilityExecutor) {
  const batch = clone(wire.CapabilityReadBatchExecuteSchema, value);
  if (!batch.identity || !attemptIdentityEqual(batch.identity, context.identity)
    || batch.runtimeInstanceId !== context.runtimeInstanceId || !batch.batchId || batch.batchId.length > 1024
    || batch.members.length < 2 || batch.members.length > 4
    || new Set(batch.members.map((member) => member.operationId)).size !== batch.members.length
    || new Set(batch.members.map((member) => member.toolUseId)).size !== batch.members.length) throw invalid();
  let providerOperationId: string | undefined;
  for (const member of batch.members) {
    const prepared = lookup(member.operationId);
    if (!prepared) throw invalid();
    providerOperationId ??= prepared.request.providerOperationId;
    if (prepared.request.providerOperationId !== providerOperationId) throw invalid();
    const decision = await prepared.result;
    if (decision.decision.case !== 'accepted') throw invalid();
    const grant = decision.decision.value;
    validateCapabilityExecute(member, context, prepared.request, grant, now());
    if (prepared.request.mutates || grant.mutates || grant.executionClass !== wire.CapabilityExecutionClass.HOST_CAPABILITY
      || !executor?.isParallelSafe?.(prepared.request, grant)) throw invalid();
  }
  return batch;
}

function invalid() { return new CapabilityGatewayError('operation_conflict', 'Host read batch is not independently certified and bounded'); }
