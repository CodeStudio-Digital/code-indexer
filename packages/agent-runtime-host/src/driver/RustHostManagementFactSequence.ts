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
  facts: RustHostManagementFactPort,
  expected: readonly SupervisorLifecycleFactCase[],
  signal: AbortSignal,
): Promise<HostSupervisorFactStep & { kind: 'committed' }> {
  for (let stepCount = 0; stepCount < MAXIMUM_MANAGEMENT_STEPS; stepCount += 1) {
    const step = await facts.processNext(signal);
    if (signal.aborted) throw rustHostAttemptAborted(signal.reason);
    if (step.kind === 'replayed') continue;
    if (!expected.includes(step.factCase)) {
      throw rustHostManagementSequenceFailure(
        `unexpected management fact ${step.factCase}`,
      );
    }
    return step;
  }
  throw rustHostManagementSequenceFailure('management replay limit exceeded');
}
