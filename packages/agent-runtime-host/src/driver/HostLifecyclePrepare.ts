import { clone } from '@bufbuild/protobuf';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import type { EstablishedAttemptChannel } from '../ipc/EstablishedAttemptChannel.js';
import type { PreparedAttemptReceipt } from './HostLifecycleReceipts.js';
import { receiveCommittedPrepared } from './HostLifecycleReceive.js';
import { sendPrepareAttempt } from './HostLifecycleSend.js';
import type { PreparedFactsExpectation } from './HostLifecycleTypes.js';
import { validatePrepareAgainstExpectation } from './PreparedFactsValidation.js';

export interface HostLifecyclePrepareOptions {
  readonly channel: EstablishedAttemptChannel;
  readonly connectionId: string;
  readonly value: agentV1Runtime.PrepareAttempt;
  readonly expectation: PreparedFactsExpectation;
  readonly timeoutMs: number;
  readonly hydrate?: () => Promise<void>;
  readonly issueReceipt: (facts: {
    connectionId: string;
    prepareMessageId: string;
    preparedMessageId: string;
    prepare: agentV1Runtime.PrepareAttempt;
    prepared: agentV1Runtime.AttemptPrepared;
  }) => PreparedAttemptReceipt;
}

/** Commits Prepare, completes Data hydration, then admits Prepared. */
export async function executeHostLifecyclePrepare(
  options: HostLifecyclePrepareOptions,
): Promise<PreparedAttemptReceipt> {
  const prepare = clone(
    agentV1Runtime.PrepareAttemptSchema,
    options.value,
  );
  validatePrepareAgainstExpectation(prepare, options.expectation);
  const outbound = await sendPrepareAttempt(
    options.channel,
    prepare,
    options.timeoutMs,
  );
  await options.hydrate?.();
  const committed = await receiveCommittedPrepared(
    options.channel,
    options.expectation,
  );
  return options.issueReceipt({
    connectionId: options.connectionId,
    prepareMessageId: outbound.outboundMessageId(),
    preparedMessageId: committed.messageId,
    prepare,
    prepared: committed.prepared,
  });
}
