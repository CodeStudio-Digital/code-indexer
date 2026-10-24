import { createHash } from 'node:crypto';
import type { AgentRun, CoderAttemptAdmissionV1, CoderAttemptPreparationV1, EnvironmentId } from '@mcp/agent-runtime-contracts';
import type { ControlPlaneFileRepository } from '@mcp/session-storage';
import { hashControlPlanePayload, stableControlPlaneJson, type ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';

export function preparationId(attemptId: string): string {
  const bytes = createHash('sha256').update(`coder-attempt-preparation:v1:${attemptId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validateFacts(facts: CoderAttemptPreparationV1, context: ControlPlaneRunContext): void {
  if (Buffer.byteLength(stableControlPlaneJson(facts)) > 8 * 1024 * 1024) {
    throw new Error('Attempt preparation exceeds the 8 MiB admission limit');
  }
  if (facts.schemaVersion !== 1 || facts.sessionId !== context.sessionId
    || facts.agentRunId !== context.agentRunId || facts.capabilitySet?.agentRunId !== context.agentRunId
    || !facts.runnerRunId?.trim()
    || !facts.provider?.trim() || !facts.model?.trim() || !facts.agentDefinitionId?.trim()
    || !/^[a-f0-9]{64}$/.test(facts.systemPromptSha256)
    || !facts.capabilityProfile?.trim() || !facts.environment?.cwd?.trim()
    || !['host', 'worktree', 'container', 'remote'].includes(facts.environment.kind)
    || !facts.policy?.permissionMode?.trim() || typeof facts.policy.planMode !== 'boolean'
    || typeof facts.policy.specMode !== 'boolean' || !Array.isArray(facts.capabilityDescriptors)
    || facts.capabilityDescriptors.length > 10_000) {
    throw new Error('Attempt preparation has invalid identity or unresolved configuration');
  }
  const set = facts.capabilitySet;
  const ids = facts.capabilityDescriptors.map((item) => item.capabilityId);
  const digest = hashControlPlanePayload(facts.capabilityDescriptors);
  if (set.hash !== digest || set.ref !== `capset:${digest}` || !set.catalogVersion?.trim()
    || new Set(ids).size !== ids.length
    || JSON.stringify(set.registered) !== JSON.stringify(ids)
    || !Array.isArray(set.visible) || !Array.isArray(set.eligible) || !Array.isArray(set.disabled)
    || [...set.visible, ...set.eligible, ...set.disabled.map((item) => item.capabilityId)].some((id) => !ids.includes(id))) {
    throw new Error('Attempt capability snapshot does not match its descriptor digest');
  }
}

/** Called inside the session authority's mutation queue. The immutable record is
 * committed first; a failed projection can be repaired by an exact replay. */
export async function commitCoderAttemptPreparation(input: {
  repository: ControlPlaneFileRepository;
  context: ControlPlaneRunContext;
  preparation: CoderAttemptPreparationV1;
  run: AgentRun;
  updateRun: (run: AgentRun) => Promise<unknown>;
  assertCurrent: () => Promise<unknown>;
}): Promise<CoderAttemptAdmissionV1> {
  const { repository, context, preparation, run } = input;
  validateFacts(preparation, context);
  const id = preparationId(String(context.attemptId));
  const preparationSha256 = hashControlPlanePayload(preparation);
  const admission: CoderAttemptAdmissionV1 = {
    schemaVersion: 1, sessionId: context.sessionId, agentRunId: context.agentRunId,
    attemptId: context.attemptId, executorOwnerId: context.executorOwnerId,
    fencingEpoch: context.fencingEpoch, preparationSha256,
    preparationRef: `events/attempt-preparations/${id}.json`, runtimeGeneration: 'legacy_ts',
  };
  const data = { checkpointType: 'coder-attempt-preparation-v1', admission, preparation };
  const existing = await repository.get('attemptPreparation', id);
  if (existing) {
    if (hashControlPlanePayload(existing.data) !== hashControlPlanePayload(data)) {
      throw new Error('Attempt preparation is already committed with different facts or authority');
    }
  } else {
    await repository.create('attemptPreparation', {
      id, operationId: id, relations: {
        session: context.sessionId, command: context.commandId, run: context.agentRunId, attempt: context.attemptId,
      }, data,
    });
  }
  const resolution = {
    effectiveProvider: preparation.provider,
    effectiveModel: preparation.model,
    ...(preparation.reasoningEffort ? { effectiveReasoningEffort: preparation.reasoningEffort } : {}),
    effectivePreset: preparation.agentDefinitionId,
    capabilitySetRef: preparation.capabilitySet.ref,
    environmentId: `environment:${hashControlPlanePayload(preparation.environment)}` as EnvironmentId,
    presetResolutionRef: `${admission.preparationRef}#agentDefinitionId`,
    policySnapshotRef: `${admission.preparationRef}#policy`,
  };
  if (Object.entries(resolution).some(([key, value]) => run[key as keyof AgentRun] !== value)) {
    await input.updateRun({ ...run, ...resolution, version: run.version + 1 });
  }
  // Disk I/O may outlast a lease. A durable snapshot alone never authorizes a start.
  await input.assertCurrent();
  return admission;
}
