import { clone, create } from '@bufbuild/protobuf';
import { agentV1Supervisor } from '@mcp/agent-runtime-contracts';
import { HostSupervisorFactError } from './HostSupervisorFactError.js';
import type { SupervisorLifecycleFact } from './HostSupervisorFactTypes.js';

export function cloneFact(
  fact: SupervisorLifecycleFact,
): SupervisorLifecycleFact {
  const payload = clone(
    agentV1Supervisor.ManagementPayloadSchema,
    create(agentV1Supervisor.ManagementPayloadSchema, { body: fact }),
  );
  return payload.body as SupervisorLifecycleFact;
}

export function correlationFailure(message: string): HostSupervisorFactError {
  return new HostSupervisorFactError('invalid_fact', message);
}

export function validTimeout(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 60_000;
}

export async function raceOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) throw aborted(signal.reason);
  let listener: (() => void) | undefined;
  const barrier = new Promise<never>((_resolve, reject) => {
    listener = () => reject(aborted(signal.reason));
    signal.addEventListener('abort', listener, { once: true });
  });
  try {
    return await Promise.race([operation, barrier]);
  } finally {
    if (listener) signal.removeEventListener('abort', listener);
  }
}

export function aborted(cause: unknown): HostSupervisorFactError {
  return new HostSupervisorFactError(
    'aborted',
    'management fact processing was aborted',
    cause === undefined ? undefined : { cause },
  );
}
