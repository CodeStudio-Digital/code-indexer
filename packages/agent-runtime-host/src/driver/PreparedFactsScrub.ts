import type { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import type {
  PreparedDurabilityFacts,
} from './HostLifecycleTypes.js';

export function scrubPrepareAttempt(
  prepare: agentV1Runtime.PrepareAttempt,
): void {
  prepare.encodedSpec.fill(0);
  prepare.encodedSpec = new Uint8Array();
  prepare.expectedSpecSha256.fill(0);
  prepare.expectedSpecSha256 = new Uint8Array();
  for (const snapshot of prepare.expectedSnapshots) {
    snapshot.contentSha256.fill(0);
  }
  prepare.expectedSnapshots.length = 0;
}

export function scrubPreparedDurabilityFacts(
  facts: PreparedDurabilityFacts,
): void {
  scrubPrepareAttempt(facts.prepare);
  facts.prepared.specSha256.fill(0);
  facts.prepared.specSha256 = new Uint8Array();
  for (const snapshot of facts.prepared.loadedSnapshots) {
    snapshot.contentSha256.fill(0);
  }
  facts.prepared.loadedSnapshots.length = 0;
  for (const artifact of facts.prepared.validatedArtifacts) {
    artifact.contentSha256.fill(0);
  }
  facts.prepared.validatedArtifacts.length = 0;
  facts.prepared.effectiveResourceBudget = undefined;
  facts.prepared.effectiveContainment = undefined;
}
