import type { ProjectIndexPhase, ProjectIndexStatus } from './types.js';

export type StructuralReadinessStatus =
  | 'ready'
  | 'aborted'
  | 'disabled'
  | 'timeout'
  | 'error'
  | 'too_large';

export interface StructuralReadinessResult {
  status: StructuralReadinessStatus;
  phase: ProjectIndexPhase;
  error?: string;
}

interface StructuralReadinessDeps {
  getStatus: () => ProjectIndexStatus;
  subscribe: (fn: (status: ProjectIndexStatus) => void) => () => void;
  start: () => boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  /** A scheduled/running refresh must settle even if the prior index was ready. */
  waitForNextReady?: boolean;
}

export function isStructurallyReady(status: ProjectIndexStatus): boolean {
  return status.phase === 'structural_ready'
    || status.phase === 'semantic_ready'
    || (status.phase === 'semantic_indexing' && status.fileCount > 0);
}

function hasSearchableIndex(status: ProjectIndexStatus): boolean {
  return isStructurallyReady(status) || ((status.phase === 'scanning' || status.phase === 'structural_indexing')
    && status.fileCount > 0 && !!(status.lastStructuralAt || status.lastSemanticAt));
}

function terminalResult(status: ProjectIndexStatus): StructuralReadinessResult | null {
  if (status.autoIndexEnabled === false) return { status: hasSearchableIndex(status) ? 'ready' : 'disabled', phase: status.phase };
  if (status.phase === 'error') return { status: 'error', phase: status.phase, error: status.error };
  if (status.phase === 'too_large') return { status: 'too_large', phase: status.phase };
  return null;
}

/** Wait for the structural index without coupling callers to status-store details. */
export function waitForStructuralReadiness(
  deps: StructuralReadinessDeps,
): Promise<StructuralReadinessResult> {
  const initial = deps.getStatus();
  if (deps.signal?.aborted) return Promise.resolve({ status: 'aborted', phase: initial.phase });
  const terminal = terminalResult(initial);
  if (terminal) return Promise.resolve(terminal);
  if (!deps.waitForNextReady && hasSearchableIndex(initial)) {
    return Promise.resolve({ status: 'ready', phase: initial.phase });
  }

  return new Promise((resolve) => {
    let settled = false;
    let readyAllowed = !deps.waitForNextReady;
    let unsubscribe: () => void = () => {};
    const finish = (result: StructuralReadinessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      deps.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => {
      const status = deps.getStatus();
      finish({ status: 'aborted', phase: status.phase, error: status.error });
    };
    const onStatus = (status: ProjectIndexStatus) => {
      if (status.phase === 'scanning' || status.phase === 'structural_indexing') readyAllowed = true;
      const failed = terminalResult(status);
      if (failed) finish(failed);
      else if (readyAllowed && isStructurallyReady(status)) {
        finish({ status: 'ready', phase: status.phase });
      }
    };
    const timer = setTimeout(() => {
      const status = deps.getStatus();
      finish({ status: 'timeout', phase: status.phase, error: status.error });
    }, Math.max(1, deps.timeoutMs));

    unsubscribe = deps.subscribe(onStatus);
    deps.signal?.addEventListener('abort', onAbort, { once: true });
    if (deps.signal?.aborted) {
      onAbort();
      return;
    }
    if (!deps.start()) {
      const status = deps.getStatus();
      finish({ status: 'disabled', phase: status.phase, error: status.error });
      return;
    }
    // Close the subscribe/start race if the executor settled synchronously.
    onStatus(deps.getStatus());
  });
}
