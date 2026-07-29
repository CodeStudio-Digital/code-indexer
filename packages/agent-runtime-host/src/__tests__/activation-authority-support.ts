import { createHash } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { agentV1Common } from '@mcp/agent-runtime-contracts';

export const ACTIVATION_AGENT_RUN_VERSION = 11n;
export const ACTIVATION_ATTEMPT_VERSION = 13n;
export const ACTIVATION_NONCE = new Uint8Array(32).fill(7);

export function activationAuthoritySeal(
  overrides: Partial<agentV1Common.ActivationAuthoritySeal> = {},
): agentV1Common.ActivationAuthoritySeal {
  return create(agentV1Common.ActivationAuthoritySealSchema, {
    agentRunVersion: ACTIVATION_AGENT_RUN_VERSION,
    attemptVersion: ACTIVATION_ATTEMPT_VERSION,
    activationNonceSha256: new Uint8Array(
      createHash('sha256').update(ACTIVATION_NONCE).digest(),
    ),
    ...overrides,
  });
}
