import type { agentV1Common } from '@mcp/agent-runtime-contracts';
import { AttemptFrameBootstrapError } from './AttemptFrameBootstrapError.js';

const MAX_UINT64 = (1n << 64n) - 1n;

export interface HostHeartbeatPolicy {
  readonly intervalMs: bigint;
  readonly timeoutMs: bigint;
}

export interface HostFeaturePolicy {
  readonly allowedFeatureBits: bigint;
  readonly requiredFeatureBits: bigint;
}

export function validateNegotiationPolicy(
  heartbeat: HostHeartbeatPolicy,
  features: HostFeaturePolicy,
  budget: agentV1Common.ResourceBudget,
): void {
  if (
    heartbeat.intervalMs <= 0n
    || heartbeat.timeoutMs <= heartbeat.intervalMs
    || heartbeat.timeoutMs > budget.maxWallMs
    || heartbeat.timeoutMs > MAX_UINT64
  ) {
    throw policyError(
      'invalid_heartbeat_policy',
      'launch heartbeat policy is invalid',
    );
  }
  if (
    !validFeatureBits(features.allowedFeatureBits)
    || !validFeatureBits(features.requiredFeatureBits)
    || (
      features.requiredFeatureBits
      & features.allowedFeatureBits
    ) !== features.requiredFeatureBits
  ) {
    throw policyError(
      'invalid_feature_policy',
      'launch feature policy is invalid',
    );
  }
}

export function assertSupportedFeatures(
  supportedFeatureBits: bigint,
  policy: HostFeaturePolicy,
): void {
  if (!validFeatureBits(supportedFeatureBits)) {
    throw policyError(
      'invalid_feature_policy',
      'AgentHello feature bits are invalid',
    );
  }
  if (
    (policy.requiredFeatureBits & supportedFeatureBits)
      !== policy.requiredFeatureBits
  ) {
    throw policyError(
      'required_feature_missing',
      'AgentHello lacks a launch-required feature',
    );
  }
}

export function negotiatedAllowedFeatureBits(
  supportedFeatureBits: bigint,
  policy: HostFeaturePolicy,
): bigint {
  assertSupportedFeatures(supportedFeatureBits, policy);
  return supportedFeatureBits & policy.allowedFeatureBits;
}

function validFeatureBits(value: bigint): boolean {
  return value >= 0n && value <= MAX_UINT64;
}

function policyError(
  code: ConstructorParameters<typeof AttemptFrameBootstrapError>[0],
  message: string,
): AttemptFrameBootstrapError {
  return new AttemptFrameBootstrapError(code, message);
}
