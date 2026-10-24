import type { CoderAttemptAdmissionV1, CoderAttemptPreparationV1 } from '@mcp/agent-runtime-contracts';
import type { ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import type { FileControlPlaneAuthority } from '../file-control-plane-store.js';

export interface WorkerAttemptOwner {
  currentRunId: number;
  runInProgress: boolean;
  controlPlaneRunContext: ControlPlaneRunContext | null;
}

/** The worker may report facts, but cannot nominate its own owner or fence. */
export async function admitWorkerAttempt(
  payload: unknown,
  currentOwner: () => WorkerAttemptOwner | undefined,
  authority: FileControlPlaneAuthority | null | undefined,
  activate?: (input: { context: ControlPlaneRunContext; preparation: CoderAttemptPreparationV1;
    admission: CoderAttemptAdmissionV1; assertOwner: () => void }) => Promise<void>,
) {
  if (!authority) throw new Error('Attempt admission authority is unavailable');
  const request = payload as { runId?: unknown; preparation?: CoderAttemptPreparationV1 } | null;
  const owner = currentOwner();
  const context = owner?.controlPlaneRunContext;
  const assertOwner = () => {
    const active = currentOwner();
    if (!context || !owner || active !== owner || !owner.runInProgress
      || owner.currentRunId !== request?.runId || owner.controlPlaneRunContext !== context) {
      throw new Error('Attempt admission rejected a stale worker run');
    }
  };
  assertOwner();
  if (!request?.preparation || request.preparation.sessionId !== context!.sessionId
    || request.preparation.agentRunId !== context!.agentRunId) {
    throw new Error('Attempt admission facts belong to a different run');
  }
  const receipt = await authority.admitCoderAttempt(context!, request.preparation);
  assertOwner();
  // Activate durably before the worker may call a provider or spawn a child.
  // The later run_started bus event is an idempotent observation of this step.
  if (activate) {
    await activate({ context: context!, preparation: request.preparation, admission: receipt, assertOwner });
  } else {
    await authority.markRunStarted(context!, request.preparation.runnerRunId);
  }
  assertOwner();
  return receipt;
}
