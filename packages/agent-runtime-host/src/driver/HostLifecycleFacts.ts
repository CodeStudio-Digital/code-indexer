import { detachedMessage } from '../ipc/DetachedMessage.js';
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
    prepare: detachedMessage(
      agentV1Runtime.PrepareAttemptSchema,
      facts.prepare,
    ),
    prepared: detachedMessage(
      agentV1Runtime.AttemptPreparedSchema,
      facts.prepared,
    ),
  });
}
