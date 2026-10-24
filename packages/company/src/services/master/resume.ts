import { getReadyDocsResearchTools } from '@mcp/docs-agent/bridges/docs-bridge.js';
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
import type { AllowedModel, RoleSkills } from '@mcp/company/types.js';
import {
  MASTER_EXPLICIT_FALLBACK_REASON,
  runWithExplicitMasterFallback,
} from '@mcp/company/services/master/fallback.js';

export interface MasterResumeOpts {
  userMessage: string;
  /** Authoritative configured Master tuple. Required by the App runtime. */
  provider?: string;
  model?: string;
  maxTurns?: number;
  roleConfigs?: RoleConfig[];
  attachments?: CoderAttachment[];
  /** Enable extended thinking on the resumed master's next turn. */
  thinking?: boolean;
  thinkingBudgetTokens?: number;
  /** Sampling temperature from the persisted App Master role. */
  temperature?: number;
  /** Sticky reasoning-effort override for the master (config_json
   *  `master_reasoning_effort`). Orthogonal to `thinking`. */
  reasoningEffort?: string;
  /** Ordered user-configured Master fallbacks. App runtime only. */
  fallbackModels?: AllowedModel[];
  /** Skills and prompt configured for the App's app_orchestrator role. */
  skills?: RoleSkills;
  initialTools?: string[];
  systemPromptOverride?: string;
}

interface AppMasterResumeRuntimeInput {
  configuredProvider: string;
  configuredModel: string;
  persistedConfiguredProvider: string;
  persistedConfiguredModel: string;
  persistedFallbackReason: string | null;
  sessionProvider: string;
  sessionModel: string;
  fallbackModels: readonly AllowedModel[];
}

export interface AppMasterResumeRuntime {
  configuredProvider: string;
  configuredModel: string;
  effectiveProvider: string;
  effectiveModel: string;
  fallbackReason: string | null;
  resetResponseState: boolean;
}

function runtimeKey(provider: string, model: string): string {
  return `${provider.trim()}\u0000${model.trim()}`;
}

/**
 * Reconcile the durable App Master run with the coder session that will be
 * resumed. A changed role config starts using its new primary tuple on this
 * dispatch. An unchanged explicit fallback remains sticky across pause/restart.
 * Any other tuple (for example a leaked global mini override) is rejected and
 * repaired back to the configured primary before runCoder can observe it.
 */
export function resolveAppMasterResumeRuntime(
  input: AppMasterResumeRuntimeInput,
): AppMasterResumeRuntime {
  const configuredProvider = input.configuredProvider.trim();
  const configuredModel = input.configuredModel.trim();
  if (!configuredProvider || !configuredModel) {
    throw new Error('App Master resume requires an authoritative provider and model');
  }

  const configuredKey = runtimeKey(configuredProvider, configuredModel);
  const persistedConfiguredKey = runtimeKey(
    input.persistedConfiguredProvider,
    input.persistedConfiguredModel,
  );
  const sessionKey = runtimeKey(input.sessionProvider, input.sessionModel);
  const fallbackKeys = new Set(
    input.fallbackModels
      .filter((candidate) => candidate.provider.trim() && candidate.model.trim())
      .map((candidate) => runtimeKey(candidate.provider, candidate.model)),
  );
  fallbackKeys.delete(configuredKey);

  const configChanged = persistedConfiguredKey !== configuredKey;
  const sessionIsConfigured = sessionKey === configuredKey;
  const sessionIsExplicitFallback = fallbackKeys.has(sessionKey);
  if (configChanged || (!sessionIsConfigured && !sessionIsExplicitFallback)) {
    return {
      configuredProvider,
      configuredModel,
      effectiveProvider: configuredProvider,
      effectiveModel: configuredModel,
      fallbackReason: null,
      resetResponseState: true,
    };
  }

  return {
    configuredProvider,
    configuredModel,
    effectiveProvider: input.sessionProvider.trim(),
    effectiveModel: input.sessionModel.trim(),
    fallbackReason: sessionIsConfigured
      ? null
      : input.persistedFallbackReason
        ?? `${MASTER_EXPLICIT_FALLBACK_REASON}: resumed persisted explicit fallback`,
    resetResponseState: false,
  };
}

export interface MasterResumeDeps {
  ctx: SessionContext;
  board: IBoardPoster;
  orchestratorRef: unknown;
  state: MasterStartStateMutators;
  wireRunner: (runner: CoderRunner, runId: string) => void;
  attachCompletion: (handle: RunCoderHandle, runId: string) => void;
}

export async function resumeMaster(
  opts: MasterResumeOpts,
  deps: MasterResumeDeps,
): Promise<MasterStartResult> {
  if (deps.state.hasHandle) throw new Error('Master already started');

  const ctx = deps.ctx;
  const fsSessionStore = ctx.companyFiles.sessionStore;
  const agentRuns = await ctx.companyFiles.listAgentRuns();
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

  let resumedProvider = masterRun.provider;
  let resumedModel = masterRun.model;
  if (ctx.runtimeKind === 'app_studio') {
    const coderSession = await fsSessionStore.getSession(
      masterRun.coder_session_id,
    );
    if (!coderSession) {
      throw new Error(`App Master coder session ${masterRun.coder_session_id} was not found`);
    }
    const runtime = resolveAppMasterResumeRuntime({
      configuredProvider: opts.provider ?? '',
      configuredModel: opts.model ?? '',
      persistedConfiguredProvider: masterRun.configured_provider,
      persistedConfiguredModel: masterRun.configured_model,
      persistedFallbackReason: masterRun.fallback_reason,
      sessionProvider: coderSession.provider,
      sessionModel: coderSession.model,
      fallbackModels: opts.fallbackModels ?? [],
    });
    resumedProvider = runtime.effectiveProvider;
    resumedModel = runtime.effectiveModel;
    if (
      coderSession.provider !== runtime.effectiveProvider
      || coderSession.model !== runtime.effectiveModel
    ) {
      await fsSessionStore.updateSessionProvider(
        masterRun.coder_session_id,
        runtime.effectiveProvider,
        runtime.effectiveModel,
      );
    }
    if (runtime.resetResponseState) {
      // Response ids are provider/model-specific. The transcript remains;
      // runCoder reconstructs the next request from persisted messages.
      await fsSessionStore.setLastResponseState(
        masterRun.coder_session_id,
        null,
        null,
      );
    }
    await ctx.companyFiles.updateAgentRunRuntimeSnapshot(masterRun.id, {
      configuredProvider: runtime.configuredProvider,
      configuredModel: runtime.configuredModel,
      effectiveProvider: runtime.effectiveProvider,
      effectiveModel: runtime.effectiveModel,
      dispatchSource: 'app_studio',
      fallbackReason: runtime.fallbackReason,
    });
  }

  // ── Fast path (awaited inside the RPC): cheap DB writes + board post ──
  deps.state.setAgentRunId(masterRun.id);
  deps.state.setRuntimeSnapshot({
    fallbackModels: [...(opts.fallbackModels ?? [])],
    temperature: opts.temperature,
    thinking: opts.thinking,
    thinkingBudgetTokens: opts.thinkingBudgetTokens,
    reasoningEffort: opts.reasoningEffort,
  });
  deps.state.setRoleConfigs((opts.roleConfigs ?? []) as RoleConfig[]);
  deps.state.loadConfigFromDb();

  await Promise.all([
    ctx.companyFiles.updateAgentRunStatus(masterRun.id, 'running'),
    ctx.companyFiles.updateSessionStatus('running'),
    ctx.companyFiles.clearRecoveryFlag(),
  ]);

  deps.board.post(
    'system',
    null,
    'message',
    `Master resumed from existing session (${resumedProvider}/${resumedModel}).`,
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
      undefined,
      { masterSystemPromptOverride: opts.systemPromptOverride },
    );

    await configureMasterSkills({
      roleConfigs: deps.state.roleConfigs,
      configuredStack: inputs.configuredStack,
      coderSessionId: masterRun.coder_session_id,
      sessionStore: fsSessionStore,
      masterSkills: opts.skills,
    });

    deps.state.setCompanyContext(inputs.companyContext);
    deps.state.setPromptBlock(inputs.promptBlock);
    deps.state.setLastUserAttachments(opts.attachments ?? []);

    const handle = await runWithExplicitMasterFallback(
      () => runCoder({
        hostTools: getReadyDocsResearchTools(),
        session: { id: masterRun.coder_session_id },
        userMessage: opts.userMessage,
        attachments: opts.attachments,
        maxTurns: opts.maxTurns ?? 100,
        planMode: false,
        profile: 'full',
        companyContext: inputs.companyContext,
        companyPromptBlock: inputs.promptBlock,
        roleTemperature: opts.temperature,
        thinking: opts.thinking,
        thinkingBudgetTokens: opts.thinkingBudgetTokens,
        reasoningEffort: opts.reasoningEffort,
        initialPinnedTools: opts.initialTools,
        onRunnerReady: (runner) => deps.wireRunner(runner, masterRun.id),
      } as RunCoderOptions & { companyPromptBlock: string }),
      masterRun.id,
      opts.fallbackModels ?? [],
      { ctx, board: deps.board },
    );

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
    .catch(async (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[company s=${ctx.companySessionId}] master resume background task failed:`, msg);
      // Surface as a board message instead of an unhandled rejection — the
      // RPC already returned 200, so failures travel over the SSE stream.
      try {
        deps.board.post('system', null, 'message', `Master resume failed: ${msg}`);
      } catch { /* best-effort */ }
      try {
        await Promise.all([
          ctx.companyFiles.updateAgentRunStatus(masterRun.id, 'error'),
          ctx.companyFiles.updateSessionStatus('error'),
        ]);
      } catch { /* best-effort */ }
    })
    .finally(() => {
      deps.state.setResumingPromise(null);
    });
  deps.state.setResumingPromise(promise);

  return ack;
}
