import { timingSafeEqual } from 'node:crypto';
import { toBinary } from '@bufbuild/protobuf';
import {
  agentV1Common,
  type agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import { HostLifecycleDriverError } from './HostLifecycleDriverError.js';
import {
  validatePreparedContainment,
} from './PreparedContainmentValidation.js';
import {
  validateArtifactManifest,
  validateSnapshotManifest,
} from './PreparedManifestValidation.js';
import type {
  PreparedFactsExpectation,
} from './HostLifecycleTypes.js';

export function validatePreparedFacts(
  prepared: agentV1Runtime.AttemptPrepared,
  expected: PreparedFactsExpectation,
): void {
  if (prepared.runtimeInstanceId !== expected.runtimeInstanceId) {
    throw mismatch('AttemptPrepared runtime authority mismatches launch');
  }
  validateSnapshotManifest(
    prepared.loadedSnapshots,
    expected.expectedSnapshots,
  );
  validateArtifactManifest(
    prepared.validatedArtifacts,
    expected.expectedArtifacts,
    expected.ownerSessionId,
    expected.resourceBudget,
  );
  if (
    !prepared.effectiveResourceBudget
    || !sameBytes(
      toBinary(
        agentV1Common.ResourceBudgetSchema,
        prepared.effectiveResourceBudget,
      ),
      toBinary(agentV1Common.ResourceBudgetSchema, expected.resourceBudget),
    )
  ) {
    throw mismatch('AttemptPrepared effective resource budget mismatches launch');
  }
  validatePreparedContainment(prepared.effectiveContainment, expected);
}

export function validatePrepareAgainstExpectation(
  prepare: agentV1Runtime.PrepareAttempt,
  expected: PreparedFactsExpectation,
): void {
  if (prepare.identity?.sessionId !== expected.ownerSessionId) {
    throw mismatch('PrepareAttempt owner mismatches lifecycle launch');
  }
  validateSnapshotManifest(
    prepare.expectedSnapshots,
    expected.expectedSnapshots,
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength
    && timingSafeEqual(left, right)
  );
}

function mismatch(message: string): HostLifecycleDriverError {
  return new HostLifecycleDriverError('prepared_facts_mismatch', message);
}
