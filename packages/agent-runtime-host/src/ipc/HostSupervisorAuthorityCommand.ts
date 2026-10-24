import { clone, create } from '@bufbuild/protobuf';
import { agentV1Common, agentV1Supervisor } from '@mcp/agent-runtime-contracts';
import type { HostAuthorityRenewalRequest } from '../driver/HostLifecycleTypes.js';
import type { HostSupervisorFactHandoff } from '../driver/HostSupervisorFactTypes.js';
import { HostSupervisorFactError } from '../driver/HostSupervisorFactError.js';
import type { SupervisorCommandBody } from './HostSupervisorCommandTypes.js';

export function authorityCommandBody(handoff: HostSupervisorFactHandoff,
  request: HostAuthorityRenewalRequest, now: bigint): { body: SupervisorCommandBody; deadlineAtUnixMs: bigint } {
  if (!request.idempotencyKey || request.idempotencyKey.length > 512
    || request.updatedAtUnixMs <= 0n || request.updatedAtUnixMs > now
    || request.leaseExpiresAtUnixMs <= now || request.leaseExpiresAtUnixMs > handoff.expectedHardDeadlineAtUnixMs) {
    throw new HostSupervisorFactError('invalid_command', 'authority renewal exceeds the sealed attempt window');
  }
  return { body: { case: 'updateAttemptAuthority', value: create(agentV1Supervisor.UpdateAttemptAuthoritySchema, {
    identity: clone(agentV1Common.AttemptIdentitySchema, handoff.expectedIdentity),
    authorityLeaseExpiresAtUnixMs: request.leaseExpiresAtUnixMs,
    hardDeadlineAtUnixMs: handoff.expectedHardDeadlineAtUnixMs,
    updatedAtUnixMs: request.updatedAtUnixMs, idempotencyKey: request.idempotencyKey,
  }) }, deadlineAtUnixMs: request.leaseExpiresAtUnixMs };
}
