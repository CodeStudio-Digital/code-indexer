import type { agentV1Supervisor } from '@mcp/agent-runtime-contracts';

/** Clears protected material from decoded management payload allocations. */
export function scrubManagementPayload(
  payload: agentV1Supervisor.ManagementPayload | undefined,
): void {
  switch (payload?.body.case) {
    case 'hostSupervisorHello':
      payload.body.value.managementSessionToken.fill(0);
      break;
    case 'supervisorHello':
      payload.body.value.launchNonce.fill(0);
      break;
    case 'launchAttemptProcess':
      payload.body.value.launchNonce.fill(0);
      for (const endpoint of payload.body.value.protectedEndpoints) {
        endpoint.connectionToken.fill(0);
      }
      break;
  }
}
