import type {
  agentV1Artifact,
  agentV1Common,
} from '@mcp/agent-runtime-contracts';

export interface PreparedFactsExpectation {
  readonly expectedSnapshots: readonly agentV1Common.SnapshotRef[];
  readonly expectedArtifacts: readonly agentV1Artifact.ArtifactRef[];
  readonly resourceBudget: agentV1Common.ResourceBudget;
  readonly requiredContainmentLevel: agentV1Common.ContainmentLevel;
  readonly requiredEnforcedLimits:
    readonly agentV1Common.ResourceLimitKind[];
  readonly runtimeInstanceId: string;
  readonly ownerSessionId: string;
}
