import { clone } from '@bufbuild/protobuf';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import type {
  PreparedDurabilityFacts,
} from './HostLifecycleTypes.js';

export function clonePreparedDurabilityFacts(
  facts: PreparedDurabilityFacts,
): PreparedDurabilityFacts {
  return Object.freeze({
    connectionId: facts.connectionId,
    prepareMessageId: facts.prepareMessageId,
    preparedMessageId: facts.preparedMessageId,
    prepare: clone(
      agentV1Runtime.PrepareAttemptSchema,
      facts.prepare,
    ),
    prepared: clone(
      agentV1Runtime.AttemptPreparedSchema,
      facts.prepared,
    ),
  });
}
