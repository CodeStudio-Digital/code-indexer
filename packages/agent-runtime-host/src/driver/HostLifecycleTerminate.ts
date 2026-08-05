import { create } from '@bufbuild/protobuf';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import type { EstablishedAttemptChannel } from '../ipc/EstablishedAttemptChannel.js';
import type { HostHeartbeatMonitor } from './HostHeartbeatMonitor.js';
import { HostLifecycleDriverError } from './HostLifecycleDriverError.js';
import { sendCancelAttempt, sendFenceAttempt } from './HostLifecycleSend.js';
import type {
  ActiveAttemptAuthorityFacts,
  HostCancelAttemptRequest,
  HostFenceAttemptRequest,
} from './HostLifecycleTypes.js';

interface ActiveCommandOptions {
  readonly channel: EstablishedAttemptChannel;
  readonly monitor: HostHeartbeatMonitor;
  readonly authority: ActiveAttemptAuthorityFacts;
  readonly timeoutMs: number;
}

export function executeHostCancel(
  options: ActiveCommandOptions,
  request: HostCancelAttemptRequest,
): Promise<void> {
  validateText(request.reasonCode, 'cancel reason code', 128, true);
  validateText(request.idempotencyKey, 'cancel idempotency key', 512, false);
  if (request.reason === agentV1Runtime.CancelReason.UNSPECIFIED) {
    throw invalid('cancel reason must be specified');
  }
  if (
    request.graceDeadlineAtUnixMs <= 0n
    || request.graceDeadlineAtUnixMs > options.authority.deadlineAtUnixMs
  ) {
    throw invalid('cancel grace deadline exceeds active authority');
  }
  const value = create(agentV1Runtime.CancelAttemptSchema, {
    identity: options.authority.identity,
    ...request,
  });
  return options.monitor.sendAndAwaitAck(
    () => sendCancelAttempt(options.channel, value, options.timeoutMs),
    options.timeoutMs,
  );
}

export function executeHostFence(
  options: ActiveCommandOptions,
  request: HostFenceAttemptRequest,
): Promise<void> {
  validateText(request.reasonCode, 'fence reason code', 128, true);
  validateText(request.idempotencyKey, 'fence idempotency key', 512, false);
  if (request.replacementFencingEpoch <= options.authority.identity.fencingEpoch) {
    throw invalid('replacement fencing epoch must increase');
  }
  if (request.fencedAtUnixMs <= 0n) {
    throw invalid('fenced timestamp must be positive');
  }
  const value = create(agentV1Runtime.FenceAttemptSchema, {
    identity: options.authority.identity,
    ...request,
  });
  return options.monitor.sendAndAwaitAck(
    () => sendFenceAttempt(options.channel, value, options.timeoutMs),
    options.timeoutMs,
  );
}

function validateText(
  value: string,
  field: string,
  maximumBytes: number,
  code: boolean,
): void {
  if (
    value.length === 0
    || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > maximumBytes
    || (code && !/^[A-Za-z0-9._:-]+$/.test(value))
  ) throw invalid(`${field} is invalid`);
}

function invalid(message: string): HostLifecycleDriverError {
  return new HostLifecycleDriverError('invalid_active_command', message);
}
