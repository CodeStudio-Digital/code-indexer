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
  type RunCoderHandle,
  type RunCoderOptions,
} from '@mcp/code-agent/index.js';
import { SkillStore } from '@mcp/store/skill-store.js';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { resolveRoleSkills } from '@mcp/company/types.js';
import type { CoderRunner } from '@mcp/code-agent/core/runner.js';
import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { IBoardPoster } from '@mcp/company/services/ports.js';
import type { RoleConfig } from '@mcp/company/services/MasterLifecycle.js';
import {
  buildMasterPromptInputs,
} from '@mcp/company/services/master/prompt-builder.js';
import type { MasterStartStateMutators } from '@mcp/company/services/master/start.js';

export interface MasterResumeOpts {
  userMessage: string;
  maxTurns?: number;
  roleConfigs?: RoleConfig[];
  attachments?: CoderAttachment[];
  /** Enable extended thinking on the resumed master's next turn. */
  thinking?: boolean;
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
): Promise<RunCoderHandle> {
  if (deps.state.hasHandle) throw new Error('Master already started');

  const ctx = deps.ctx;
  const agentRuns = ctx.companyStore.listAgentRuns(ctx.companySessionId);
  const masterRun = agentRuns.filter((r) => r.role === 'master').pop();
  if (!masterRun) throw new Error('No master agent_run found — use start instead');

  deps.state.setAgentRunId(masterRun.id);
  deps.state.setRoleConfigs((opts.roleConfigs ?? []) as RoleConfig[]);
  deps.state.loadConfigFromDb();

  ctx.companyStore.updateAgentRunStatus(masterRun.id, 'running');
  ctx.companyStore.updateCompanySessionStatus(ctx.companySessionId, 'running');

  const inputs = await buildMasterPromptInputs(
    ctx,
    masterRun.id,
    deps.state.roleConfigs,
    deps.state.allowedModels,
    deps.orchestratorRef,
  );

  const masterRoleConfigResume = deps.state.roleConfigs.find((r) => r.role === 'master');
  const masterResolvedSkillsResume = resolveRoleSkills(masterRoleConfigResume?.skills, {
    stack: inputs.configuredStack ?? undefined,
  });
  if (masterResolvedSkillsResume.length > 0) {
    const resumeConfig = loadConfig();
    const primaryProjectIdResume = ctx.projects[0]?.project_id;
    if (primaryProjectIdResume) {
      try {
        const skillStore = new SkillStore(resumeConfig.dbPath);
        const allSkills = skillStore.resolveActiveSkills(masterRun.coder_session_id, primaryProjectIdResume);
        for (const skill of allSkills) {
          skillStore.setSessionSkillEnabled(
            masterRun.coder_session_id,
            skill.id,
            masterResolvedSkillsResume.includes(skill.id),
          );
        }
        skillStore.close();
      } catch (e) {
        console.warn(
          `[company] Failed to configure skills for master (resume): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  deps.state.setCompanyContext(inputs.companyContext);
  deps.state.setPromptBlock(inputs.promptBlock);
  deps.state.setLastUserAttachments(opts.attachments ?? []);

  deps.board.post(
    'system',
    null,
    'message',
    `Master resumed from existing session (${masterRun.provider}/${masterRun.model}).`,
  );

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
    onRunnerReady: (runner) => deps.wireRunner(runner, masterRun.id),
  } as RunCoderOptions & { companyPromptBlock: string });

  deps.state.setHandle(handle);
  deps.state.setRunnerExited(false);
  deps.attachCompletion(handle, masterRun.id);

  return handle;
}
