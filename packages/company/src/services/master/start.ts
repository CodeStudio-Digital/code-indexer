import { getReadyDocsResearchTools } from '@mcp/docs-agent/bridges/docs-bridge.js';
/**
 * Boot the master agent for a fresh company session. Steps:
 *
 *   1. Refuse to start a second time (idempotency check on `_handle`).
 *   2. Resolve the primary project id; throw when none is linked.
 *   3. Create the coder session + agent_run row.
 *   4. Hydrate `_roleConfigs` from opts and merge with persisted config.
 *   5. Flip session + agent statuses to 'running'.
 *   6. Configure skill enablement on the master's coder session.
 *   7. Build CompanyContext + prompt block (incl. optional sandbox).
 *   8. Post the start board messages (human turn + system "Master started").
 *   9. `runCoder({ onRunnerReady })` to wire HumanInTheLoop BEFORE turn 1.
 *  10. Store the handle + attach the completion handler.
 *
 * Extracted from `MasterLifecycle.start` so the orchestration sequence
 * lives in one file and the deps surface is explicit.
 */
import {
  runCoder,
  type CoderAttachment,
  type MasterStartResult,
  type RunCoderHandle,
  type RunCoderOptions,
} from '@mcp/code-agent/index.js';
import { attachmentsToBlocks } from '@mcp/code-agent/core/messages.js';
import { publish as busPublish } from '@apps/http-api/coder-bus.js';
import type { CoderRunner } from '@mcp/code-agent/core/runner.js';
import type { AllowedModel, RoleSkills } from '@mcp/company/types.js';
import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { IBoardPoster } from '@mcp/company/services/ports.js';
import type { RoleConfig } from './role-config.js';
import { buildMasterPromptInputs } from '@mcp/company/services/master/prompt-builder.js';
import { configureMasterSkills } from '@mcp/company/services/master/configure-skills.js';
import { runWithExplicitMasterFallback } from '@mcp/company/services/master/fallback.js';
import { createCompanyCoderSession } from '@mcp/company/services/company-coder-sessions.js';

export interface MasterStartOpts {
  userMessage: string;
  provider: string;
  model: string;
  maxTurns?: number;
  signal?: AbortSignal;
  roleConfigs?: RoleConfig[];
  attachments?: CoderAttachment[];
  /** Enable extended thinking on the master's first turn. */
  thinking?: boolean;
  /** Optional provider-specific extended-thinking budget. */
  thinkingBudgetTokens?: number;
  /** Sampling temperature from the persisted App Master role. */
  temperature?: number;
  /**
   * Sticky reasoning-effort override for the master (config_json
   * `master_reasoning_effort`). Orthogonal to `thinking`. Forwarded to
   * `runCoder({ reasoningEffort })`. Only honoured by providers with discrete
   * effort levels (Codex/OpenRouter). Undefined → model default.
   */
  reasoningEffort?: string;
  /** Ordered user-configured Master fallbacks. App runtime only. */
  fallbackModels?: AllowedModel[];
  /** Skills and prompt configured for the App's app_orchestrator role. */
  skills?: RoleSkills;
  /** Role preset tools pinned into the Master's first visible catalog. */
  initialTools?: string[];
  systemPromptOverride?: string;
}

/** Immutable runtime snapshot reused by fallback/resurrection cycles. */
export interface MasterRuntimeSnapshot {
  fallbackModels: AllowedModel[];
  temperature?: number;
  thinking?: boolean;
  thinkingBudgetTokens?: number;
  reasoningEffort?: string;
}

/**
 * Narrow state-mutator surface. The class exposes setters/getters for
 * the private fields the start path needs to populate. Keeping this
 * interface narrow keeps the extracted function readable.
 */
export interface MasterStartStateMutators {
  readonly hasHandle: boolean;
  readonly roleConfigs: readonly RoleConfig[];
  readonly allowedModels: readonly AllowedModel[];
  setAgentRunId: (id: string) => void;
  setRuntimeSnapshot: (snapshot: MasterRuntimeSnapshot) => void;
  setRoleConfigs: (configs: RoleConfig[]) => void;
  /** Calls `parseMasterConfigFromDb` + assigns into `_allowedModels` / `_roleConfigs`. */
  loadConfigFromDb: () => void;
  setCompanyContext: (
    ctx: import('@mcp/company/types.js').CompanyContext | null,
  ) => void;
  setPromptBlock: (block: string) => void;
  setLastUserAttachments: (atts: CoderAttachment[]) => void;
  setHandle: (handle: RunCoderHandle) => void;
  setRunnerExited: (value: boolean) => void;
  // ─── Background-start concurrency (shared with the resurrect path) ───
  /**
   * In-flight start/resume promise. The slow phase (sandbox provision +
   * `runCoder` boot) runs in the background so the worker RPC returns within
   * its 60s deadline; this slot lets concurrent callers reattach instead of
   * double-starting, and lets `notify`/`sendUserMessage` queue turns that
   * arrive before the runner is wired.
   */
  readonly resumingPromise: Promise<void> | null;
  setResumingPromise: (p: Promise<void> | null) => void;
  /** Queue of messages that arrived during the provision window. */
  readonly resumeQueue: Array<{ message: string; attachments?: CoderAttachment[] }>;
  /** Splice + clear `resumeQueue`. */
  drainResumeQueue: () => Array<{ message: string; attachments?: CoderAttachment[] }>;
}

export interface MasterStartDeps {
  ctx: SessionContext;
  board: IBoardPoster;
  orchestratorRef: unknown;
  state: MasterStartStateMutators;
  wireRunner: (runner: CoderRunner, runId: string) => void;
  attachCompletion: (handle: RunCoderHandle, runId: string) => void;
}

export async function startMaster(
  opts: MasterStartOpts,
  deps: MasterStartDeps,
): Promise<MasterStartResult> {
  if (deps.state.hasHandle) throw new Error('Master already started');
  if (deps.state.resumingPromise) throw new Error('Master start already in progress');

  const ctx = deps.ctx;
  const primaryProjectId = ctx.projects[0]?.project_id;
  if (!primaryProjectId) throw new Error('Company session has no linked projects');

  const fsSessionStore = ctx.companyFiles.sessionStore;

  // ── Fast path (awaited inside the RPC): create the filesystem coder
  // bundle + independent Company agent-run entity, then flip lifecycle state.
  const masterSession = await createCompanyCoderSession({
    ctx,
    sessionStore: fsSessionStore,
    title: `[Company Master] ${ctx.companySessionId}`,
    provider: opts.provider,
    model: opts.model,
    role: 'master',
  });

  const masterRun = await ctx.companyFiles.createAgentRun({
    role: 'master',
    coder_session_id: masterSession.id,
    project_ids: ctx.projects.map((p) => p.project_id),
    provider: opts.provider,
    model: opts.model,
    configured_provider: opts.provider,
    configured_model: opts.model,
    dispatch_source: ctx.runtimeKind === 'app_studio' ? 'app_studio' : 'company',
    fallback_reason: null,
  });

  deps.state.setAgentRunId(masterRun.id);
  deps.state.setRuntimeSnapshot({
    fallbackModels: [...(opts.fallbackModels ?? [])],
    temperature: opts.temperature,
    thinking: opts.thinking,
    thinkingBudgetTokens: opts.thinkingBudgetTokens,
    reasoningEffort: opts.reasoningEffort,
  });
  deps.state.setRoleConfigs((opts.roleConfigs ?? []) as RoleConfig[]);
  // Populate `_allowedModels` from the persisted session config. Must
  // happen before any `spawn_subordinate_agent` call, so we do it here
  // (start + resume) alongside role configs.
  deps.state.loadConfigFromDb();

  await Promise.all([
    ctx.companyFiles.setMasterSessionId(masterSession.id),
    ctx.companyFiles.updateSessionStatus('running'),
    ctx.companyFiles.clearRecoveryFlag(),
  ]);

  const startBoardMsg =
    opts.attachments && opts.attachments.length > 0
      ? `${opts.userMessage}\n\n_[${opts.attachments.length} ${opts.attachments.length === 1 ? 'attachment' : 'attachments'}]_`
      : opts.userMessage;
  deps.board.post('human', null, 'message', startBoardMsg);
  deps.board.post(
    'system',
    null,
    'message',
    `Master agent started (${opts.provider}/${opts.model}). Analyzing task...`,
  );

  const ack: MasterStartResult = { masterSessionId: masterSession.id, indexStatus: null };
  const masterSessionId = masterSession.id;
  const agentRunId = masterRun.id;

  // ── Background phase: sandbox provision (cold container build can take
  // minutes) + runCoder boot. Un-awaited so the RPC returns within its 60s
  // deadline; provisioning progress streams over the metaBus → SSE. ──
  const doStart = async (): Promise<void> => {
    const inputs = await buildMasterPromptInputs(
      ctx,
      agentRunId,
      deps.state.roleConfigs,
      deps.state.allowedModels,
      deps.orchestratorRef,
      opts.signal,
      { masterSystemPromptOverride: opts.systemPromptOverride },
    );

    // Configure skill enablement on the master's coder session — must
    // happen after `buildMasterPromptInputs` so we know the configured
    // stack for conditional skill resolution.
    await configureMasterSkills({
      roleConfigs: deps.state.roleConfigs,
      configuredStack: inputs.configuredStack,
      coderSessionId: masterSessionId,
      sessionStore: fsSessionStore,
      masterSkills: opts.skills,
    });

    deps.state.setCompanyContext(inputs.companyContext);
    deps.state.setPromptBlock(inputs.promptBlock);
    deps.state.setLastUserAttachments(opts.attachments ?? []);

    const handle = await runWithExplicitMasterFallback(
      () => runCoder({
        hostTools: getReadyDocsResearchTools(),
        session: { id: masterSessionId },
        userMessage: opts.userMessage,
        attachments: opts.attachments,
        maxTurns: opts.maxTurns ?? 100,
        signal: opts.signal,
        planMode: false,
        profile: 'full',
        companyContext: inputs.companyContext,
        companyPromptBlock: inputs.promptBlock,
        roleTemperature: opts.temperature,
        thinking: opts.thinking,
        thinkingBudgetTokens: opts.thinkingBudgetTokens,
        reasoningEffort: opts.reasoningEffort,
        initialPinnedTools: opts.initialTools,
        // Wire HumanInTheLoop BEFORE the runner takes turn 1, so a master
        // that calls `ask_user` immediately is still captured.
        onRunnerReady: (runner) => deps.wireRunner(runner, agentRunId),
      } as RunCoderOptions & { companyPromptBlock: string }),
      agentRunId,
      opts.fallbackModels ?? [],
      { ctx, board: deps.board },
    );

    deps.state.setHandle(handle);
    deps.state.setRunnerExited(false);
    deps.attachCompletion(handle, agentRunId);

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

  const promise = doStart()
    .catch(async (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[company s=${ctx.companySessionId}] master start background task failed:`, msg);
      // Distinct SSE event so the dashboard can render a dedicated "master
      // failed to boot" banner + retry, rather than the operator having to spot
      // it among board messages. The HTTP start already returned 200 (the boot
      // runs in the background), so this stream event is the only structured
      // signal the failure ever happened.
      try {
        busPublish(ctx.metaBus, 'master_boot_failed', {
          companySessionId: ctx.companySessionId,
          agentRunId,
          error: msg,
        });
      } catch { /* best-effort */ }
      try {
        deps.board.post('system', null, 'message', `Master start failed: ${msg}`);
      } catch { /* best-effort */ }
      try {
        await Promise.all([
          ctx.companyFiles.updateAgentRunStatus(agentRunId, 'error'),
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
