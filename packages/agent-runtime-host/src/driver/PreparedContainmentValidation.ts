import { agentV1Common } from '@mcp/agent-runtime-contracts';
import {
  assertContainmentExpectation,
  assertContainmentProof,
} from '../ipc/ContainmentProofValidation.js';
import { HostLifecycleDriverError } from './HostLifecycleDriverError.js';
import type {
  PreparedFactsExpectation,
} from './PreparedFactsTypes.js';

export function validatePreparedContainment(
  actual: agentV1Common.ContainmentReport | undefined,
  expected: PreparedFactsExpectation,
): void {
  try {
    assertContainmentProof(actual, {
      requiredLevel: expected.requiredContainmentLevel,
      requiredLimits: expected.requiredEnforcedLimits,
    });
  } catch {
    throw mismatch();
  }
}

export function validateContainmentExpectation(
  level: agentV1Common.ContainmentLevel,
  limits: readonly agentV1Common.ResourceLimitKind[],
): void {
  try {
    assertContainmentExpectation(level, limits);
  } catch {
    throw mismatch();
  }
}

function mismatch(): HostLifecycleDriverError {
  return new HostLifecycleDriverError(
    'prepared_facts_mismatch',
    'AttemptPrepared effective containment mismatches launch',
  );
}
