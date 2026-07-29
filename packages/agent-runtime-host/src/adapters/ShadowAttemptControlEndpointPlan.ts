import { agentV1Supervisor } from '@mcp/agent-runtime-contracts';
import {
  assertFrameIdentifier,
} from '../ipc/FrameHeaderValidation.js';

const ENDPOINT_CAPS = new Map([
  [agentV1Supervisor.AttemptEndpointKind.CONTROL, 256 * 1024],
  [agentV1Supervisor.AttemptEndpointKind.DATA, 1024 * 1024],
  [agentV1Supervisor.AttemptEndpointKind.RUNNER_PULSE, 4 * 1024],
]);

export interface ValidatedAttemptEndpointPlan {
  readonly control: agentV1Supervisor.ProtectedAttemptEndpoint;
  readonly data: agentV1Supervisor.ProtectedAttemptEndpoint;
  readonly ids: string[];
}

export function validateAttemptEndpointPlan(
  values: readonly agentV1Supervisor.ProtectedAttemptEndpoint[],
): ValidatedAttemptEndpointPlan {
  if (values.length !== ENDPOINT_CAPS.size) {
    throw new RangeError('protected endpoints');
  }
  const kinds = new Set<number>();
  const ids = new Set<string>();
  const connections = new Set<string>();
  let control: agentV1Supervisor.ProtectedAttemptEndpoint | undefined;
  let data: agentV1Supervisor.ProtectedAttemptEndpoint | undefined;
  for (const endpoint of values) {
    assertFrameIdentifier(endpoint.endpointId, 'endpoint_id');
    assertFrameIdentifier(endpoint.connectionId, 'connection_id');
    const maximum = ENDPOINT_CAPS.get(endpoint.kind);
    if (
      maximum === undefined
      || endpoint.maxFrameBytes !== BigInt(maximum)
      || kinds.has(endpoint.kind)
      || ids.has(endpoint.endpointId)
      || connections.has(endpoint.connectionId)
      || endpoint.connectionToken.byteLength < 16
      || endpoint.connectionToken.byteLength > 512
    ) throw new RangeError('protected endpoint authority');
    kinds.add(endpoint.kind);
    ids.add(endpoint.endpointId);
    connections.add(endpoint.connectionId);
    if (endpoint.kind === agentV1Supervisor.AttemptEndpointKind.CONTROL) {
      control = endpoint;
    } else if (
      endpoint.kind === agentV1Supervisor.AttemptEndpointKind.DATA
    ) {
      data = endpoint;
    }
  }
  if (!control || !data || kinds.size !== ENDPOINT_CAPS.size) {
    throw new RangeError('protected endpoint kinds');
  }
  return { control, data, ids: [...ids] };
}
