import { clone } from '@bufbuild/protobuf';
import {
  agentV1Artifact,
  agentV1Common,
  agentV1Runtime,
  agentV1Supervisor,
} from '@mcp/agent-runtime-contracts';
import type {
  HostDataHydrationRequest,
  HostHydrationSource,
} from '../ipc/HostDataHydration.js';
import { AttemptControlAdapterError } from './AttemptControlAdapterError.js';
import type { DurableAttemptBindingPlan } from './DurableAttemptControlBinding.js';
import {
  closeHydrationSource,
  validateShadowAttemptDataPlan,
} from './ShadowAttemptDataPlanValidation.js';

export interface ShadowAttemptDataPlanInput {
  readonly launch: agentV1Supervisor.LaunchAttemptProcess;
  readonly hostHello: agentV1Runtime.HostHello;
  readonly expectedSnapshots: readonly agentV1Common.SnapshotRef[];
  readonly expectedArtifacts: readonly agentV1Artifact.ArtifactRef[];
  readonly requiredContainmentLevel: agentV1Common.ContainmentLevel;
  readonly requiredEnforcedLimits:
    readonly agentV1Common.ResourceLimitKind[];
  readonly specDeadlineAtUnixMs: bigint;
  readonly transferId: string;
  readonly source: HostHydrationSource;
}

export interface ShadowAttemptDataPlan
extends DurableAttemptBindingPlan {
  readonly endpointId: string;
  readonly connectionId: string;
  readonly connectionToken: Uint8Array;
  readonly protocolVersion: number;
  readonly effectiveLimits: agentV1Common.FrameLimits;
  readonly hydration: Omit<HostDataHydrationRequest, 'signal'>;
}

export function snapshotShadowAttemptDataPlan(
  input: ShadowAttemptDataPlanInput,
): ShadowAttemptDataPlan {
  let connectionToken: Uint8Array | undefined;
  let activationAuthoritySeal:
    agentV1Common.ActivationAuthoritySeal | undefined;
  try {
    const launch = input.launch;
    const validated = validateShadowAttemptDataPlan(input);
    const endpoints = validated.endpoints;
    const data = endpoints.data;
    const effectiveLimits = validated.effectiveLimits;
    connectionToken = data.connectionToken.slice();
    activationAuthoritySeal = clone(
      agentV1Common.ActivationAuthoritySealSchema,
      launch.activationAuthoritySeal!,
    );
    return Object.freeze({
      identity: clone(
        agentV1Common.AttemptIdentitySchema,
        validated.identity,
      ),
      resourceBudget: clone(
        agentV1Common.ResourceBudgetSchema,
        validated.resourceBudget,
      ),
      hardDeadlineAtUnixMs: launch.hardDeadlineAtUnixMs,
      expectedEndpointIds: Object.freeze(endpoints.ids),
      expectedRunnerProvenance: clone(
        agentV1Supervisor.ExpectedRuntimeProvenanceSchema,
        validated.expectedRunnerProvenance,
      ),
      specDeadlineAtUnixMs: input.specDeadlineAtUnixMs,
      activationAuthoritySeal,
      requiredContainmentLevel: input.requiredContainmentLevel,
      requiredEnforcedLimits: Object.freeze([
        ...input.requiredEnforcedLimits,
      ]),
      endpointId: data.endpointId,
      connectionId: data.connectionId,
      connectionToken,
      protocolVersion: validated.protocolVersion,
      effectiveLimits,
      hydration: Object.freeze({
        transferId: input.transferId,
        maximumChunkBytes: effectiveLimits.maxChunkBytes,
        maxIpcBytes: validated.resourceBudget.maxIpcBytes,
        maxIpcFrames: validated.resourceBudget.maxIpcFrames,
        maxArtifactBytes: validated.resourceBudget.maxArtifactBytes,
        maxSpoolBytes: validated.resourceBudget.maxSpoolBytes,
        source: validated.source,
      }),
    });
  } catch (cause) {
    connectionToken?.fill(0);
    activationAuthoritySeal?.activationNonceSha256.fill(0);
    closeHydrationSource(input.source, cause);
    throw new AttemptControlAdapterError(
      'invalid_provision',
      'shadow data lifecycle plan is invalid',
      { cause },
    );
  }
}

export function scrubShadowAttemptDataPlan(
  plan: ShadowAttemptDataPlan | undefined,
  cause?: unknown,
  close = true,
): void {
  if (!plan) return;
  plan.connectionToken.fill(0);
  plan.activationAuthoritySeal.activationNonceSha256.fill(0);
  if (close) closeHydrationSource(plan.hydration.source, cause);
}
