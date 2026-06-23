/**
 * Cold-start resume of an existing master agent run. Mirror of `start`
 * for the case where the company session was paused / the API server
 * restarted, but the master agent_run row still exists.
 *
 * Differences vs `start`:
 *   - Looks up the latest `master` agent_run row (no new row created).
 *   - Throws when no row exists — caller must use `start` instead.
 *   - Flips status to 'running' on both the agent_run and the session.
 *   - Re-provisions the sandbox (manager's in-memory state is lost on
 *     restart; container is rebuilt fresh).
 *   - Reuses the existing coder_session_id when calling `runCoder`.
 *
 * Posts a single board message ("Master resumed from existing session")
 * — `start` posts two (human turn + system "Analyzing task").
 */
import {
  runCoder,
  type CoderAttachment,
  type MasterStartResult,
  type RunCoderHandle,
  type RunCoderOptions,
} from '@mcp/code-agent/index.js';
import { attachmentsToBlocks } from '@mcp/code-agent/core/messages.js';
import type { CoderRunner } from '@mcp/code-agent/core/runner.js';
import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { IBoardPoster } from '@mcp/company/services/ports.js';
import type { RoleConfig } from '@mcp/company/services/MasterLifecycle.js';
import {
  buildMasterPromptInputs,
} from '@mcp/company/services/master/prompt-builder.js';
import { configureMasterSkills } from '@mcp/company/services/master/configure-skills.js';
import type { MasterStartStateMutators } from '@mcp/company/services/master/start.js';

export interface MasterResumeOpts {
  userMessage: string;
  maxTurns?: number;
  roleConfigs?: RoleConfig[];
  attachments?: CoderAttachment[];
  /** Enable extended thinking on the resumed master's next turn. */
  thinking?: boolean;
  /** Sticky reasoning-effort override for the master (config_json
   *  `master_reasoning_effort`). Orthogonal to `thinking`. */
  reasoningEffort?: string;
}

export interface MasterResumeDeps {
  ctx: SessionContext;
  board: IBoardPoster;
  orchestratorRef: unknown;
  state: MasterStartStateMutators;
  wireRunner: (runner: CoderRunner, runId: number) => void;
  attachCompletion: (handle: RunCoderHandle, runId: number) => void;
}

export async function resumeMaster(
  opts: MasterResumeOpts,
  deps: MasterResumeDeps,
): Promise<MasterStartResult> {
  if (deps.state.hasHandle) throw new Error('Master already started');

  const ctx = deps.ctx;
  const agentRuns = ctx.companyStore.listAgentRuns(ctx.companySessionId);
  const masterRun = agentRuns.filter((r) => r.role === 'master').pop();
  if (!masterRun) throw new Error('No master agent_run found — use start instead');

  // The ack returns the existing master coder-session id; `indexStatus` is
  // unknown until the background `runCoder` boots, and no company-path caller
  // reads it.
  const ack: MasterStartResult = { masterSessionId: masterRun.coder_session_id, indexStatus: null };

  // A previous start/resume is still provisioning. Don't double-start — queue
  // this turn so the in-flight task flushes it once the runner is wired, and
  // return the same ids (the worker's metaBus → SSE pipeline already carries
  // the in-progress events).
  if (deps.state.resumingPromise) {
    deps.state.resumeQueue.push({ message: opts.userMessage, attachments: opts.attachments });
    return ack;
  }

  // ── Fast path (awaited inside the RPC): cheap DB writes + board post ──
  deps.state.setAgentRunId(masterRun.id);
  deps.state.setRoleConfigs((opts.roleConfigs ?? []) as RoleConfig[]);
  deps.state.loadConfigFromDb();

  ctx.companyStore.updateAgentRunStatus(masterRun.id, 'running');
  ctx.companyStore.updateCompanySessionStatus(ctx.companySessionId, 'running');
  // P15c — clear the recovery flag set by `recoverStaleAgentRuns()` on boot.
  ctx.companyStore.clearSessionRecoveryFlag(ctx.companySessionId);

  deps.board.post(
    'system',
    null,
    'message',
    `Master resumed from existing session (${masterRun.provider}/${masterRun.model}).`,
  );

  // ── Background phase: sandbox provision (can be a multi-minute cold
  // container rebuild) + runCoder boot. Runs un-awaited so the RPC returns
  // well within its 60s deadline; progress streams over the metaBus → SSE.
  const doResume = async (): Promise<void> => {
    const inputs = await buildMasterPromptInputs(
      ctx,
      masterRun.id,
      deps.state.roleConfigs,
      deps.state.allowedModels,
      deps.orchestratorRef,
    );

    configureMasterSkills({
      roleConfigs: deps.state.roleConfigs,
      configuredStack: inputs.configuredStack,
      coderSessionId: masterRun.coder_session_id,
      primaryProjectId: ctx.projects[0]?.project_id,
    });

    deps.state.setCompanyContext(inputs.companyContext);
    deps.state.setPromptBlock(inputs.promptBlock);
    deps.state.setLastUserAttachments(opts.attachments ?? []);

    const handle = await runCoder({
      session: { id: masterRun.coder_session_id },
      userMessage: opts.userMessage,
      attachments: opts.attachments,
      maxTurns: opts.maxTurns ?? 100,
      planMode: false,
      profile: 'full',
      companyContext: inputs.companyContext,
      companyPromptBlock: inputs.promptBlock,
      thinking: opts.thinking,
      reasoningEffort: opts.reasoningEffort,
      onRunnerReady: (runner) => deps.wireRunner(runner, masterRun.id),
    } as RunCoderOptions & { companyPromptBlock: string });

    deps.state.setHandle(handle);
    deps.state.setRunnerExited(false);
    deps.attachCompletion(handle, masterRun.id);

    // Flush any turns that arrived while the sandbox was provisioning.
    const queued = deps.state.drainResumeQueue();
    for (const item of queued) {
      if (item.attachments?.length) {
        handle.runner.pushUserContent(attachmentsToBlocks(item.message, item.attachments));
      } else {
        handle.runner.pushUserMessage(item.message);
      }
    }
  };

  const promise = doResume()
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[company s=${ctx.companySessionId}] master resume background task failed:`, msg);
      // Surface as a board message instead of an unhandled rejection — the
      // RPC already returned 200, so failures travel over the SSE stream.
      try {
        deps.board.post('system', null, 'message', `Master resume failed: ${msg}`);
      } catch { /* best-effort */ }
      try {
        ctx.companyStore.updateAgentRunStatus(masterRun.id, 'error');
        ctx.companyStore.updateCompanySessionStatus(ctx.companySessionId, 'error');
      } catch { /* best-effort */ }
    })
    .finally(() => {
      deps.state.setResumingPromise(null);
    });
  deps.state.setResumingPromise(promise);

  return ack;
}
