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
import { SessionStore } from '@mcp/code-agent/sessions/store.js';
import { loadConfig } from '@mcp/shared/utils/config.js';
import type { CoderRunner } from '@mcp/code-agent/core/runner.js';
import type { AllowedModel } from '@mcp/company/types.js';
import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { IBoardPoster } from '@mcp/company/services/ports.js';
import type { RoleConfig } from '@mcp/company/services/MasterLifecycle.js';
import { buildMasterPromptInputs } from '@mcp/company/services/master/prompt-builder.js';
import { configureMasterSkills } from '@mcp/company/services/master/configure-skills.js';

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
  /**
   * Sticky reasoning-effort override for the master (config_json
   * `master_reasoning_effort`). Orthogonal to `thinking`. Forwarded to
   * `runCoder({ reasoningEffort })`. Only honoured by providers with discrete
   * effort levels (Codex/OpenRouter). Undefined → model default.
   */
  reasoningEffort?: string;
  /**
   * Route work through the built-in SDD pipeline by default. Threaded into
   * `MasterPromptContext.sddMode` via `buildMasterPromptInputs` so the master
   * prompt picks up the SDD MODE block.
   */
  sddMode?: boolean;
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
  setAgentRunId: (id: number) => void;
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
  wireRunner: (runner: CoderRunner, runId: number) => void;
  attachCompletion: (handle: RunCoderHandle, runId: number) => void;
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

  const config = loadConfig();

  // ── Fast path (awaited inside the RPC): create the session + agent_run,
  // flip statuses, post the start board messages. All cheap/synchronous. ──
  // `store` is only used for `createSession` here — `runCoder` opens its own
  // SessionStore — so close it immediately rather than holding it across the
  // background phase.
  const store = new SessionStore(config.dbPath);
  const masterSession = store.createSession({
    project_id: primaryProjectId,
    title: `[Company Master] ${ctx.companySessionId}`,
    provider: opts.provider,
    model: opts.model,
  });
  store.close();

  const masterRun = ctx.companyStore.createAgentRun({
    company_session_id: ctx.companySessionId,
    role: 'master',
    coder_session_id: masterSession.id,
    project_ids: ctx.projects.map((p) => p.project_id),
    provider: opts.provider,
    model: opts.model,
  });

  deps.state.setAgentRunId(masterRun.id);
  deps.state.setRoleConfigs((opts.roleConfigs ?? []) as RoleConfig[]);
  // Populate `_allowedModels` from the persisted session config. Must
  // happen before any `spawn_subordinate_agent` call, so we do it here
  // (start + resume) alongside role configs.
  deps.state.loadConfigFromDb();

  ctx.companyStore.setMasterSessionId(ctx.companySessionId, masterSession.id);
  ctx.companyStore.updateCompanySessionStatus(ctx.companySessionId, 'running');
  // P15c — clear the recovery flag set by `recoverStaleAgentRuns()` on boot.
  ctx.companyStore.clearSessionRecoveryFlag(ctx.companySessionId);

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
      { sddMode: !!opts.sddMode },
    );

    // Configure skill enablement on the master's coder session — must
    // happen after `buildMasterPromptInputs` so we know the configured
    // stack for conditional skill resolution.
    configureMasterSkills({
      roleConfigs: deps.state.roleConfigs,
      configuredStack: inputs.configuredStack,
      coderSessionId: masterSessionId,
      primaryProjectId,
    });

    deps.state.setCompanyContext(inputs.companyContext);
    deps.state.setPromptBlock(inputs.promptBlock);
    deps.state.setLastUserAttachments(opts.attachments ?? []);

    const handle = await runCoder({
      session: { id: masterSessionId },
      userMessage: opts.userMessage,
      attachments: opts.attachments,
      maxTurns: opts.maxTurns ?? 100,
      signal: opts.signal,
      planMode: false,
      profile: 'full',
      companyContext: inputs.companyContext,
      companyPromptBlock: inputs.promptBlock,
      thinking: opts.thinking,
      reasoningEffort: opts.reasoningEffort,
      // Wire HumanInTheLoop BEFORE the runner takes turn 1, so a master
      // that calls `ask_user` immediately is still captured.
      onRunnerReady: (runner) => deps.wireRunner(runner, agentRunId),
    } as RunCoderOptions & { companyPromptBlock: string });

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
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[company s=${ctx.companySessionId}] master start background task failed:`, msg);
      try {
        deps.board.post('system', null, 'message', `Master start failed: ${msg}`);
      } catch { /* best-effort */ }
      try {
        ctx.companyStore.updateAgentRunStatus(agentRunId, 'error');
        ctx.companyStore.updateCompanySessionStatus(ctx.companySessionId, 'error');
      } catch { /* best-effort */ }
    })
    .finally(() => {
      deps.state.setResumingPromise(null);
    });
  deps.state.setResumingPromise(promise);

  return ack;
}
