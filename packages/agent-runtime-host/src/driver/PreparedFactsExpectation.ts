import { clone } from '@bufbuild/protobuf';
import {
  agentV1Artifact,
  agentV1Common,
} from '@mcp/agent-runtime-contracts';
import { assertFrameIdentifier } from '../ipc/FrameHeaderValidation.js';
import { deriveLaunchLimits } from '../ipc/HostLaunchProvisionValidation.js';
import { HostLifecycleDriverError } from './HostLifecycleDriverError.js';
import {
  validateContainmentExpectation,
} from './PreparedContainmentValidation.js';
import {
  validateArtifactManifest,
  validateSnapshotManifest,
} from './PreparedManifestValidation.js';
import type {
  PreparedFactsExpectation,
} from './PreparedFactsTypes.js';

export function snapshotPreparedFactsExpectation(
  value: PreparedFactsExpectation,
): PreparedFactsExpectation {
  validate(value);
  return Object.freeze({
    expectedSnapshots: Object.freeze(value.expectedSnapshots.map(
      (snapshot) => clone(agentV1Common.SnapshotRefSchema, snapshot),
    )),
    expectedArtifacts: Object.freeze(value.expectedArtifacts.map(
      (artifact) => clone(agentV1Artifact.ArtifactRefSchema, artifact),
    )),
    resourceBudget: clone(
      agentV1Common.ResourceBudgetSchema,
      value.resourceBudget,
    ),
    requiredContainmentLevel: value.requiredContainmentLevel,
    requiredEnforcedLimits: Object.freeze([
      ...value.requiredEnforcedLimits,
    ]),
    runtimeInstanceId: value.runtimeInstanceId,
    ownerSessionId: value.ownerSessionId,
  });
}

function validate(value: PreparedFactsExpectation): void {
  try {
    assertFrameIdentifier(
      value.runtimeInstanceId,
      'prepared runtime instance',
    );
    assertFrameIdentifier(value.ownerSessionId, 'prepared owner session');
    deriveLaunchLimits(value.resourceBudget);
    if (
      value.resourceBudget.maxArtifactBytes
        > value.resourceBudget.maxSpoolBytes
    ) throw new RangeError('artifact budget exceeds spool budget');
    validateContainmentExpectation(
      value.requiredContainmentLevel,
      value.requiredEnforcedLimits,
    );
    validateSnapshotManifest(
      value.expectedSnapshots,
      value.expectedSnapshots,
    );
    validateArtifactManifest(
      value.expectedArtifacts,
      value.expectedArtifacts,
      value.ownerSessionId,
      value.resourceBudget,
    );
  } catch (cause) {
    throw new HostLifecycleDriverError(
      'invalid_prepared_expectation',
      'prepared expectation authority is invalid',
      { cause },
    );
  }
}
