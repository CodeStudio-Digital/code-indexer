import type {
  agentV1Supervisor,
} from '@mcp/agent-runtime-contracts';
import { AttemptControlAdapterError } from '../adapters/AttemptControlAdapterError.js';
import type {
  AuthenticatedAttemptConnection,
  ProtectedAttemptEndpointOpenExpectation,
} from '../adapters/ProtectedAttemptEndpoint.js';

export function assertNativeHostExpectedConnection(
  connection: AuthenticatedAttemptConnection,
  expected: ProtectedAttemptEndpointOpenExpectation,
): void {
  if (
    expected.signal.aborted
    || connection.endpointId !== expected.endpointId
    || connection.connectionId !== expected.connectionId
    || connection.peerPid !== expected.expectedPeerPid
    || connection.transport.maximumFrameBytes !== expected.maximumFrameBytes
    || expected.deadlineAtUnixMs <= BigInt(Date.now())
  ) throw new AttemptControlAdapterError(
    'invalid_provision',
    'native endpoint diverges from its bound expectation',
  );
}

export function scrubNativeHostLaunch(
  launch: agentV1Supervisor.LaunchAttemptProcess | undefined,
): void {
  if (!launch) return;
  launch.launchNonce.fill(0);
  launch.activationAuthoritySeal?.activationNonceSha256.fill(0);
  for (const endpoint of launch.protectedEndpoints) {
    endpoint.connectionToken.fill(0);
  }
}
