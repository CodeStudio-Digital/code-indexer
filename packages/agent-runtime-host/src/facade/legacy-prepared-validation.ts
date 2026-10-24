import { createHash } from 'node:crypto';
import { AgentRuntimeHostError } from '../errors.js';
import type { PreparedLegacyAgentAttempt } from './types.js';

/** Same code-point ordering as the control-plane admission ledger. */
export function legacyPreparationDigest(value: unknown): string {
  const sort = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sort);
    if (!entry || typeof entry !== 'object') return entry;
    return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .filter(([, item]) => item !== undefined).map(([key, item]) => [key, sort(item)]));
  };
  return createHash('sha256').update(JSON.stringify(sort(value))).digest('hex');
}

export function assertLegacyPreparation(prepared: PreparedLegacyAgentAttempt): void {
  const { authority, admission, preparation: facts, run, routing } = prepared;
  const digest = legacyPreparationDigest(facts);
  const same = (a: unknown, b: unknown) => legacyPreparationDigest(a) === legacyPreparationDigest(b);
  if (admission.schemaVersion !== 1 || facts.schemaVersion !== 1
    || admission.runtimeGeneration !== 'legacy_ts' || routing.preference !== 'legacy_required'
    || admission.sessionId !== authority.sessionId || facts.sessionId !== authority.sessionId
    || admission.agentRunId !== authority.agentRunId || facts.agentRunId !== authority.agentRunId
    || admission.attemptId !== authority.attemptId || admission.executorOwnerId !== authority.executorOwnerId
    || !Number.isSafeInteger(admission.fencingEpoch) || BigInt(admission.fencingEpoch) !== authority.fencingEpoch
    || !/^events\/attempt-preparations\/[a-f0-9-]{36}\.json$/.test(admission.preparationRef)
    || admission.preparationSha256 !== digest
    || Buffer.from(prepared.expectedSpecSha256).toString('hex') !== digest
    || !facts.runnerRunId?.trim() || !/^[a-f0-9]{64}$/.test(facts.systemPromptSha256)
    || run.effectiveProvider !== facts.provider || run.effectiveModel !== facts.model
    || run.effectiveReasoningEffort !== facts.reasoningEffort
    || run.effectivePreset !== facts.agentDefinitionId
    || run.capabilitySetRef !== facts.capabilitySet.ref
    || run.environmentId !== `environment:${legacyPreparationDigest(facts.environment)}`
    || run.policySnapshotRef !== `${admission.preparationRef}#policy`
    || run.presetResolutionRef !== `${admission.preparationRef}#agentDefinitionId`
    || facts.capabilitySet.agentRunId !== run.agentRunId
    || facts.capabilitySet.hash !== legacyPreparationDigest(facts.capabilityDescriptors)
    || facts.capabilitySet.ref !== `capset:${facts.capabilitySet.hash}`
    || !same(facts.capabilitySet.registered, facts.capabilityDescriptors.map((item) => item.capabilityId))
    || routing.eligibility.environmentKind !== facts.environment.kind
    || routing.eligibility.capabilityProfile !== facts.capabilityProfile
    || routing.eligibility.capabilityCatalogVersion !== facts.capabilitySet.catalogVersion
    || !same(routing.eligibility.capabilityIds, facts.capabilitySet.eligible)) {
    throw new AgentRuntimeHostError('prepared_attempt_mismatch',
      'Legacy preparation does not match the admitted facts, resolution, or authority');
  }
}
