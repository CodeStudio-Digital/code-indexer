/**
 * "Resurrect" the master agent after its runner exited but a subordinate
 * notify arrived. Cheaper than `start` — reuses the saved
 * `_companyContext` + `_promptBlock`; just kicks off a fresh `runCoder`
 * cycle on the same coder session.
 *
 * Concurrency: a `resumingPromise` slot serialises overlapping resurrect
 * calls. Notifications that arrive while one is in flight pile into
 * `resumeQueue` and get flushed via `pushUserMessage` immediately after
 * the new runner is wired.
 *
 * Bails silently (returns `undefined` without throwing) when:
 *   - There's no prior `_handle` / `_companyContext` / `_agentRunId`.
 *   - The session bus has been aborted / ended.
 */
import {
  runCoder,
  type CoderAttachment,
  type RunCoderHandle,
  type RunCoderOptions,
} from '@mcp/code-agent/index.js';
import { attachmentsToBlocks } from '@mcp/code-agent/core/messages.js';
import type { CoderRunner } from '@mcp/code-agent/core/runner.js';
import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type {
  IAgentStatusUpdater,
  IBoardPoster,
} from '@mcp/company/services/ports.js';
import type { CompanyContext } from '@mcp/company/types.js';

export interface MasterResurrectStateMutators {
  /** Existing runner handle, or null when never started. */
  readonly handle: RunCoderHandle | null;
  /** Cached CompanyContext from the first start/resume. */
  readonly companyContext: CompanyContext | null;
  /** Cached prompt block from the first start/resume. */
  readonly promptBlock: string;
  readonly agentRunId: number | null;
  /** In-flight resurrect, if any. */
  readonly resumingPromise: Promise<void> | null;
  setResumingPromise: (p: Promise<void> | null) => void;
  /** Queue of notifications that arrived mid-resurrect. */
  readonly resumeQueue: Array<{ message: string; attachments?: CoderAttachment[] }>;
  /** Splice + clear `resumeQueue`. */
  drainResumeQueue: () => Array<{ message: string; attachments?: CoderAttachment[] }>;
  /** Replace `_handle` with `{ ...existing, runner, done }`. */
  refreshHandle: (runner: CoderRunner, done: RunCoderHandle['done']) => void;
  setEnded: (v: boolean) => void;
  setRunnerExited: (v: boolean) => void;
  setEndedWithError: (v: string | null) => void;
  /** Clear the ended-at timestamp when the runner restarts. */
  setEndedAt: (v: string | null) => void;
}

export interface MasterResurrectDeps {
  ctx: SessionContext;
  status: IAgentStatusUpdater;
  board: IBoardPoster;
  state: MasterResurrectStateMutators;
  wireRunner: (runner: CoderRunner, runId: number) => void;
  attachCompletion: (handle: RunCoderHandle, runId: number) => void;
}

/**
 * Restart the master runner with `message` (and optional attachments)
 * as the next user turn. Serialises overlapping calls via
 * `resumingPromise` — anything that arrives while a resurrect is in
 * flight queues for flush.
 */
export async function resurrectMaster(
  message: string,
  attachments: CoderAttachment[] | undefined,
  thinking: boolean | undefined,
  deps: MasterResurrectDeps,
): Promise<void> {
  if (!deps.state.handle || !deps.state.companyContext || !deps.state.agentRunId) return;
  if (deps.ctx.isAborted || deps.ctx.isBusEnded) return;

  if (deps.state.resumingPromise) {
    deps.state.resumeQueue.push({ message, attachments });
    return deps.state.resumingPromise;
  }

  const agentRunId = deps.state.agentRunId;
  const masterSessionId = deps.state.handle.session?.id;

  const doResume = async (): Promise<void> => {
    deps.status.setStatus(agentRunId, 'running');

    deps.board.post(
      'system',
      null,
      'message',
      'Master reactivated — subordinate reported completion.',
    );

    if (!masterSessionId) {
      console.warn('[company] resurrect: no master session id');
      return;
    }

    const handle = await runCoder({
      session: { id: masterSessionId },
      userMessage: message,
      attachments,
      maxTurns: 40,
      planMode: false,
      profile: 'full',
      companyContext: deps.state.companyContext!,
      companyPromptBlock: deps.state.promptBlock,
      thinking,
      onRunnerReady: (runner) => deps.wireRunner(runner, agentRunId),
    } as RunCoderOptions & { companyPromptBlock: string });

    deps.state.setEnded(false);
    deps.state.setRunnerExited(false);
    deps.state.setEndedWithError(null);
    deps.state.setEndedAt(null);
    deps.state.refreshHandle(handle.runner, handle.done);

    // Flush queued messages that arrived during spin-up.
    const queued = deps.state.drainResumeQueue();
    for (const item of queued) {
      if (item.attachments?.length) {
        handle.runner.pushUserContent(attachmentsToBlocks(item.message, item.attachments));
      } else {
        handle.runner.pushUserMessage(item.message);
      }
    }

    deps.attachCompletion(handle, agentRunId);
  };

  const promise = doResume().finally(() => {
    deps.state.setResumingPromise(null);
  });
  deps.state.setResumingPromise(promise);
  return promise;
}
