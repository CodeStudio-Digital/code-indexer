import { timingSafeEqual } from 'node:crypto';
import { clone, create } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Supervisor,
} from '@mcp/agent-runtime-contracts';
import type {
  HostCancelAttemptRequest,
  HostFenceAttemptRequest,
  HostReapAttemptRequest,
} from '../driver/HostLifecycleTypes.js';
import { HostSupervisorFactError } from '../driver/HostSupervisorFactError.js';
import type {
  HostSupervisorFactHandoff,
} from '../driver/HostSupervisorFactTypes.js';
import { latestLocalPeerTimestamp } from './LocalPeerClock.js';
import type {
  PendingSupervisorCommand,
  SupervisorCommandBody,
} from './HostSupervisorCommandTypes.js';

export function cancelCommandBody(
  handoff: HostSupervisorFactHandoff,
  request: HostCancelAttemptRequest,
  nowUnixMs: bigint,
): { body: SupervisorCommandBody; deadlineAtUnixMs: bigint } {
  validateCommon(request.reasonCode, request.idempotencyKey);
  if (
    request.graceDeadlineAtUnixMs <= nowUnixMs
    || request.graceDeadlineAtUnixMs > handoff.expectedHardDeadlineAtUnixMs
  ) throw invalid('management Cancel grace is outside attempt authority');
  return {
    body: {
      case: 'cancelAttemptProcess',
      value: create(agentV1Supervisor.CancelAttemptProcessSchema, {
        identity: clone(
          agentV1Common.AttemptIdentitySchema,
          handoff.expectedIdentity,
        ),
        graceDeadlineAtUnixMs: request.graceDeadlineAtUnixMs,
        reasonCode: request.reasonCode,
        idempotencyKey: request.idempotencyKey,
      }),
    },
    deadlineAtUnixMs: request.graceDeadlineAtUnixMs,
  };
}

export function fenceCommandBody(
  handoff: HostSupervisorFactHandoff,
  request: HostFenceAttemptRequest,
  nowUnixMs: bigint,
): { body: SupervisorCommandBody; deadlineAtUnixMs: bigint } {
  validateCommon(request.reasonCode, request.idempotencyKey);
  if (
    request.replacementFencingEpoch <= handoff.expectedIdentity.fencingEpoch
    || request.fencedAtUnixMs <= 0n
    || request.fencedAtUnixMs > latestLocalPeerTimestamp(nowUnixMs)
    || nowUnixMs >= handoff.expectedHardDeadlineAtUnixMs
  ) throw invalid('management Fence is outside attempt authority');
  return {
    body: {
      case: 'fenceAttemptProcess',
      value: create(agentV1Supervisor.FenceAttemptProcessSchema, {
        identity: clone(
          agentV1Common.AttemptIdentitySchema,
          handoff.expectedIdentity,
        ),
        replacementFencingEpoch: request.replacementFencingEpoch,
        reasonCode: request.reasonCode,
        fencedAtUnixMs: request.fencedAtUnixMs,
        idempotencyKey: request.idempotencyKey,
      }),
    },
    deadlineAtUnixMs: handoff.expectedHardDeadlineAtUnixMs,
  };
}

export function reapCommandBody(
  handoff: HostSupervisorFactHandoff,
  request: HostReapAttemptRequest,
  nowUnixMs: bigint,
): { body: SupervisorCommandBody; deadlineAtUnixMs: bigint } {
  validateCommon(request.reasonCode, request.idempotencyKey);
  if (
    !validText(request.runtimeInstanceId)
    || request.reapDeadlineAtUnixMs <= nowUnixMs
  ) throw invalid('management Reap target or deadline is invalid');
  return {
    body: {
      case: 'reapAttemptProcess',
      value: create(agentV1Supervisor.ReapAttemptProcessSchema, {
        identity: clone(
          agentV1Common.AttemptIdentitySchema,
          handoff.expectedIdentity,
        ),
        runtimeInstanceId: request.runtimeInstanceId,
        reapDeadlineAtUnixMs: request.reapDeadlineAtUnixMs,
        reasonCode: request.reasonCode,
        idempotencyKey: request.idempotencyKey,
      }),
    },
    deadlineAtUnixMs: request.reapDeadlineAtUnixMs,
  };
}

export function validateSupervisorCommandAck(
  header: agentV1Supervisor.ManagementFrameHeader,
  acknowledgement: agentV1Supervisor.ManagementAck,
  pending: PendingSupervisorCommand,
  observedAtUnixMs: bigint,
): void {
  const digest = acknowledgement.acknowledgedPayloadSha256;
  if (
    header.replyToMessageId !== pending.messageId
    || acknowledgement.acknowledgedMessageId !== pending.messageId
    || digest.byteLength !== pending.payloadSha256.byteLength
    || !timingSafeEqual(digest, pending.payloadSha256)
    || acknowledgement.acknowledgedAtUnixMs < pending.sentAtUnixMs
    || acknowledgement.acknowledgedAtUnixMs
      > latestLocalPeerTimestamp(observedAtUnixMs)
  ) throw invalid('management command ACK does not match the outbound command');
}

function validateCommon(reasonCode: string, idempotencyKey: string): void {
  if (!validText(reasonCode) || !validText(idempotencyKey)) {
    throw invalid('management command text is invalid');
  }
}

function validText(value: string): boolean {
  return value.trim().length > 0 && value.length <= 1_024 && !value.includes('\0');
}

function invalid(message: string): HostSupervisorFactError {
  return new HostSupervisorFactError('invalid_command', message);
}
