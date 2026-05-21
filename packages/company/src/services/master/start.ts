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
  type RunCoderHandle,
  type RunCoderOptions,
} from '@mcp/code-agent/index.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';
import { SkillStore } from '@mcp/store/skill-store.js';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { resolveRoleSkills } from '@mcp/company/types.js';
import type { CoderRunner } from '@mcp/code-agent/core/runner.js';
import type { AllowedModel } from '@mcp/company/types.js';
import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { IBoardPoster } from '@mcp/company/services/ports.js';
import type { RoleConfig } from '@mcp/company/services/MasterLifecycle.js';
import { buildMasterPromptInputs } from '@mcp/company/services/master/prompt-builder.js';

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
): Promise<RunCoderHandle> {
  if (deps.state.hasHandle) throw new Error('Master already started');

  const ctx = deps.ctx;
  const primaryProjectId = ctx.projects[0]?.project_id;
  if (!primaryProjectId) throw new Error('Company session has no linked projects');

  const config = loadConfig();
  const store = new SessionStore(config.dbPath);

  const masterSession = store.createSession({
    project_id: primaryProjectId,
    title: `[Company Master] ${ctx.companySessionId}`,
    provider: opts.provider,
    model: opts.model,
  });

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

  const inputs = await buildMasterPromptInputs(
    ctx,
    masterRun.id,
    deps.state.roleConfigs,
    deps.state.allowedModels,
    deps.orchestratorRef,
    opts.signal,
  );

  // Configure skill enablement on the master's coder session — must
  // happen after `buildMasterPromptInputs` so we know the configured
  // stack for conditional skill resolution.
  const masterRoleConfig = deps.state.roleConfigs.find((r) => r.role === 'master');
  const masterResolvedSkills = resolveRoleSkills(masterRoleConfig?.skills, {
    stack: inputs.configuredStack ?? undefined,
  });
  if (masterResolvedSkills.length > 0) {
    try {
      const skillStore = new SkillStore(config.dbPath);
      const allSkills = skillStore.resolveActiveSkills(masterSession.id, primaryProjectId);
      for (const skill of allSkills) {
        skillStore.setSessionSkillEnabled(
          masterSession.id,
          skill.id,
          masterResolvedSkills.includes(skill.id),
        );
      }
      skillStore.close();
    } catch (e) {
      console.warn(
        `[company] Failed to configure skills for master: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  deps.state.setCompanyContext(inputs.companyContext);
  deps.state.setPromptBlock(inputs.promptBlock);
  deps.state.setLastUserAttachments(opts.attachments ?? []);

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

  const handle = await runCoder({
    session: { id: masterSession.id },
    userMessage: opts.userMessage,
    attachments: opts.attachments,
    maxTurns: opts.maxTurns ?? 100,
    signal: opts.signal,
    planMode: false,
    profile: 'full',
    companyContext: inputs.companyContext,
    companyPromptBlock: inputs.promptBlock,
    thinking: opts.thinking,
    // Wire HumanInTheLoop BEFORE the runner takes turn 1, so a master
    // that calls `ask_user` immediately is still captured.
    onRunnerReady: (runner) => deps.wireRunner(runner, masterRun.id),
  } as RunCoderOptions & { companyPromptBlock: string });

  deps.state.setHandle(handle);
  deps.state.setRunnerExited(false);
  deps.attachCompletion(handle, masterRun.id);

  store.close();
  return handle;
}
