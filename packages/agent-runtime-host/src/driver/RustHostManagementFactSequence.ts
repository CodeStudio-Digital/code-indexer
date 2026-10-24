import {
  rustHostAttemptAborted,
  rustHostManagementSequenceFailure,
} from './RustHostAttemptCoordinatorError.js';
import type {
  HostSupervisorFactStep,
  SupervisorLifecycleFactCase,
} from './HostSupervisorFactTypes.js';
import type {
  RustHostManagementFactPort,
} from './RustHostAttemptCoordinatorTypes.js';

const MAXIMUM_MANAGEMENT_STEPS = 64;

export async function nextCommittedManagementFact(
  facts: RustHostManagementFactPort | undefined,
  expected: readonly SupervisorLifecycleFactCase[],
  signal: AbortSignal,
): Promise<HostSupervisorFactStep & { kind: 'committed' }> {
  if (!facts) throw rustHostManagementSequenceFailure(
    'management fact stream is unavailable',
  );
  for (let stepCount = 0; stepCount < MAXIMUM_MANAGEMENT_STEPS;) {
    const step = await facts.processNext(signal);
    if (signal.aborted) throw rustHostAttemptAborted(signal.reason);
    // Renewal ACKs are useful progress during long attempts. Only consecutive
    // replay frames consume the replay bound.
    if (step.kind !== 'committed') {
      stepCount = step.kind === 'command_acknowledged' ? 0 : stepCount + 1;
      continue;
    }
    if (!expected.includes(step.factCase)) {
      throw rustHostManagementSequenceFailure(
        `unexpected management fact ${step.factCase}`,
      );
    }
    return step;
  }
  throw rustHostManagementSequenceFailure('management replay limit exceeded');
}
