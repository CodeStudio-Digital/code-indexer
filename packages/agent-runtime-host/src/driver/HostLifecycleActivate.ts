import type { agentV1Common } from '@mcp/agent-runtime-contracts';
import { scrubActivationAuthoritySeal } from '../ipc/ActivationAuthoritySealValidation.js';
import type { AuthorityClock } from '../ipc/AttemptClock.js';
import type { EstablishedAttemptChannel } from '../ipc/EstablishedAttemptChannel.js';
import { HostAuthorityLifetime } from './HostAuthorityLifetime.js';
import { HostHeartbeatMonitor } from './HostHeartbeatMonitor.js';
import type {
  ActiveAttemptReceipt,
  PreparedAttemptReceipt,
} from './HostLifecycleReceipts.js';
import { HostLifecycleReceiptOwner } from './HostLifecycleReceiptOwner.js';
import { receiveCommittedActivationAck } from './HostLifecycleReceive.js';
import { sendActivateAttempt } from './HostLifecycleSend.js';
import type { PreparedDurabilityPort } from './HostLifecycleTypes.js';
import {
  activeAuthorityFacts,
  snapshotPreparedActivationAuthority,
  validateDurableActivationGrant,
} from './HostLifecycleValidation.js';
import { scrubPreparedDurabilityFacts } from './PreparedFactsScrub.js';

interface HostLifecycleActivateOptions {
  readonly receipt: PreparedAttemptReceipt;
  readonly receipts: HostLifecycleReceiptOwner;
  readonly clock: AuthorityClock;
  readonly maximumDeadlineAtUnixMs: bigint;
  readonly durability: PreparedDurabilityPort;
  readonly activationSeal: agentV1Common.ActivationAuthoritySeal;
  readonly channel: EstablishedAttemptChannel;
  readonly outboundTimeoutMs: number;
  readonly heartbeatTimeoutMs: bigint;
  readonly failOwner: (cause: unknown) => void;
  readonly retainLifetime: (lifetime: HostAuthorityLifetime) => void;
  readonly setPhase: (phase: 'activating' | 'active') => void;
}

export async function executeHostLifecycleActivation(
  options: HostLifecycleActivateOptions,
): Promise<{
  active: ActiveAttemptReceipt;
  heartbeat: HostHeartbeatMonitor;
}> {
  const facts = options.receipts.consumePrepared(options.receipt);
  const authority = snapshotPreparedActivationAuthority(
    facts,
    options.maximumDeadlineAtUnixMs,
  );
  const lifetime = new HostAuthorityLifetime(
    options.clock,
    options.maximumDeadlineAtUnixMs,
    options.failOwner,
  );
  options.retainLifetime(lifetime);
  const grant = await lifetime.commitPrepared(
    options.durability,
    facts,
  ).finally(() => scrubPreparedDurabilityFacts(facts));
  const activate = validateDurableActivationGrant(
    grant,
    authority,
    options.activationSeal,
  );
  scrubActivationAuthoritySeal(options.activationSeal);
  lifetime.narrowDeadline(activate.deadlineAtUnixMs);
  const activeFacts = activeAuthorityFacts(activate, authority);
  options.setPhase('activating');
  await sendActivateAttempt(
    options.channel,
    activate,
    options.outboundTimeoutMs,
  );
  await receiveCommittedActivationAck(options.channel);
  const active = options.receipts.installActive(activeFacts, lifetime.signal);
  options.setPhase('active');
  const heartbeat = new HostHeartbeatMonitor(
    options.channel,
    activeFacts,
    options.heartbeatTimeoutMs,
    options.clock,
    options.failOwner,
  );
  heartbeat.start();
  return { active, heartbeat };
}
