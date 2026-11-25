import { getReadyDocsResearchTools } from '@mcp/docs-agent/bridges/docs-bridge.js';
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
import type { MasterRuntimeSnapshot } from '@mcp/company/services/master/start.js';
import { runWithExplicitMasterFallback } from '@mcp/company/services/master/fallback.js';

export interface MasterResurrectStateMutators {
  /** Existing runner handle, or null when never started. */
  readonly handle: RunCoderHandle | null;
  /** Cached CompanyContext from the first start/resume. */
  readonly companyContext: CompanyContext | null;
  /** Cached prompt block from the first start/resume. */
  readonly promptBlock: string;
  readonly agentRunId: string | null;
  readonly runtimeSnapshot: MasterRuntimeSnapshot;
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
  wireRunner: (runner: CoderRunner, runId: string) => void;
  attachCompletion: (handle: RunCoderHandle, runId: string) => void;
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
  const stopped = () => deps.ctx.isAborted || deps.ctx.isBusEnded || deps.ctx.isFinalized;
  if (stopped()) return;

  if (deps.state.resumingPromise) {
    deps.state.resumeQueue.push({ message, attachments });
    return deps.state.resumingPromise;
  }

  const agentRunId = deps.state.agentRunId;
  const masterSessionId = deps.state.handle.session?.id;

  const doResume = async (): Promise<void> => {
    if (stopped()) return;
    if (!masterSessionId) throw new Error('No persisted Master chat to resume');
    await deps.ctx.companyFiles.updateSessionStatus('running');
    if (stopped()) return;
    deps.status.setStatus(agentRunId, 'running');

    const runtime = deps.state.runtimeSnapshot;
    const handle = await runWithExplicitMasterFallback(
      () => runCoder({
        hostTools: getReadyDocsResearchTools(),
        session: { id: masterSessionId },
        userMessage: message,
        attachments,
        maxTurns: 40,
        planMode: false,
        profile: 'full',
        companyContext: deps.state.companyContext!,
        companyPromptBlock: deps.state.promptBlock,
        roleTemperature: runtime.temperature,
        thinking: thinking ?? runtime.thinking,
        thinkingBudgetTokens: runtime.thinkingBudgetTokens,
        reasoningEffort: runtime.reasoningEffort,
        onRunnerReady: (runner) => {
          if (stopped()) runner.abort();
          else deps.wireRunner(runner, agentRunId);
        },
      } as RunCoderOptions & { companyPromptBlock: string }),
      agentRunId,
      runtime.fallbackModels,
      { ctx: deps.ctx, board: deps.board },
    );

    if (stopped()) {
      handle.runner.abort();
      await handle.done.catch(() => undefined);
      return;
    }
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
    try { deps.board.post('system', null, 'message', 'Master resumed in the same chat.'); }
    catch { /* The runner already owns this turn. */ }
  };

  // Keep ownership until bootstrap settles. An elapsed timer cannot admit a
  // second runner into the same chat while the first one is still starting.
  const promise = Promise.resolve().then(doResume).catch(async error => {
    if (stopped()) return;
    const detail = error instanceof Error ? error.message : String(error);
    deps.state.setRunnerExited(true);
    deps.state.setEnded(true);
    deps.state.setEndedWithError(detail);
    deps.state.setEndedAt(new Date().toISOString());
    deps.status.setStatus(agentRunId, 'error', detail);
    try { deps.board.post('system', null, 'blocker', `Master resume failed: ${detail}`); } catch { /* best effort */ }
    await deps.ctx.companyFiles.updateSessionStatus('error').catch(() => undefined);
  }).finally(() => { deps.state.setResumingPromise(null); });
  deps.state.setResumingPromise(promise);
  return promise;
}
