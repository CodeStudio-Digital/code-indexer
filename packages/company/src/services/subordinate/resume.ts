/**
 * Resume an existing subordinate agent run from its persisted coder
 * session. Distinct from `spawn` (which creates a new agent_run row);
 * this path reuses the existing row's project ids, provider, model,
 * and session id.
 *
 * Why re-read the sandbox binding at resume time, not at spawn time:
 * a subordinate pauses between turns (`submit_plan`, `ask_user`,
 * `submit_tasks`); each resume is a fresh `runCoder` call whose
 * `companyContext.sandbox` must point at the CURRENT container. Stale
 * bindings fall back to `LocalFilesystemAdapter` and writes land on
 * the host virtual-project dir instead of `/app` in the sandbox — the
 * exact bug that made the preview pane keep showing the Vite default
 * template before binding resolution was moved into the resume path.
 */
import { runCoder, type CoderAttachment, type RunCoderOptions } from '@mcp/code-agent/index.js';
import { createBus } from '@apps/http-api/coder-bus.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { buildSubordinateCompanyBlock } from '@mcp/company/system-prompts.js';
import type {
  AgentRunStatus,
  CompanyContext,
  SubordinateHandle,
} from '@mcp/company/types.js';
import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { HumanInTheLoop } from '@mcp/company/services/HumanInTheLoop.js';
import type {
  IAgentStatusUpdater,
  IBoardPoster,
  IMasterNotifier,
  IMetaBusWirer,
} from '@mcp/company/services/ports.js';
import { resolveBindingForProject } from '@mcp/company/services/subordinate/binding.js';
import {
  attachSubordinateCompletionHandler,
  type SubordinateCompletionDeps,
} from '@mcp/company/services/subordinate/completion-handler.js';
import { wireSubordinateInterceptionsForRunner } from '@mcp/company/services/subordinate/runner-wiring.js';

export interface ResumeSubordinateDeps {
  ctx: SessionContext;
  board: IBoardPoster;
  status: IAgentStatusUpdater;
  master: IMasterNotifier;
  humanInLoop: HumanInTheLoop;
  wirer: IMetaBusWirer;
  orchestratorRef: unknown;
  subordinates: Map<number, SubordinateHandle>;
  runningIds: Set<number>;
  notifyIdleChanged: () => void;
  wireDeps: {
    humanInLoop: HumanInTheLoop;
    wirer: IMetaBusWirer;
  };
  completionDeps: SubordinateCompletionDeps;
}

interface ResumeResult {
  agentRunId: number;
  coderSessionId: number;
  status: AgentRunStatus;
}

export async function resumeSubordinate(
  agentRunId: number,
  message: string | undefined,
  roleOverride: string | undefined,
  attachments: CoderAttachment[] | undefined,
  thinking: boolean | undefined,
  deps: ResumeSubordinateDeps,
): Promise<ResumeResult> {
  const ctx = deps.ctx;
  const agentRun = ctx.companyStore.getAgentRun(agentRunId);
  if (!agentRun) throw new Error(`Agent run ${agentRunId} not found`);
  if (agentRun.company_session_id !== ctx.companySessionId) {
    throw new Error(`Agent run ${agentRunId} does not belong to this company session`);
  }
  const resumableStatuses = ['error', 'aborted', 'waiting', 'completed', 'interrupted'];
  if (!resumableStatuses.includes(agentRun.status)) {
    throw new Error(
      `Agent run ${agentRunId} status is ${agentRun.status}, not resumable (need: ${resumableStatuses.join('/')})`,
    );
  }

  const config = loadConfig();
  const store = new SessionStore(config.dbPath);
  const projectIds: number[] = JSON.parse(agentRun.project_ids_json);
  const projectId = projectIds[0];
  const project = ctx.db.getProject(projectId);

  const resumeBinding = resolveBindingForProject(ctx, deps.orchestratorRef, projectId);
  const resumeLabel =
    deps.ctx.projects.find((p) => p.project_id === projectId)?.label ?? null;
  const resumeStack =
    (
      deps.orchestratorRef as {
        getSandboxStackForService?: (serviceId?: string | null) => string | null;
      }
    ).getSandboxStackForService?.(resumeLabel) ?? 'react-ts';

  const companyContext: CompanyContext = {
    orchestrator: deps.orchestratorRef as never,
    companySessionId: ctx.companySessionId,
    agentRole: agentRun.role,
    agentRunId: agentRun.id,
    allowedProjectIds: projectIds,
    isMaster: false,
    sandbox: resumeBinding ?? undefined,
  };

  const subordinateBlock = buildSubordinateCompanyBlock({
    role: agentRun.role,
    projects: [
      {
        id: projectId,
        name: project?.name ?? `project-${projectId}`,
        rootPath: project?.root_path ?? '',
      },
    ],
    builder: resumeBinding
      ? {
          workdir: resumeBinding.workdir,
          stack: resumeStack,
          previewUrl: resumeBinding.previewUrl,
          peers:
            (
              deps.orchestratorRef as {
                listSandboxPeers?: (selfServiceId?: string | null) => Array<{
                  serviceId: string;
                  stack: string;
                  internalUrl: string;
                  previewUrl: string;
                  isSelf: boolean;
                }>;
              }
            ).listSandboxPeers?.(resumeBinding.serviceId ?? resumeLabel) ?? undefined,
        }
      : undefined,
    overridePrompt: roleOverride,
  });

  const resumeMessage =
    message ?? 'Continue your task from where you left off. Check the board for context.';

  deps.board.post('system', agentRun.id, 'message', `Resuming @${agentRun.role} agent...`);

  let handle: Awaited<ReturnType<typeof runCoder>>;
  try {
    handle = await runCoder({
      session: { id: agentRun.coder_session_id },
      userMessage: resumeMessage,
      attachments,
      maxTurns: 50,
      companyContext,
      companyPromptBlock: subordinateBlock,
      companyRoleOverride: roleOverride,
      thinking,
      onRunnerReady: (runner) =>
        wireSubordinateInterceptionsForRunner(runner, agentRun.id, agentRun.role, deps.wireDeps),
    } as RunCoderOptions & { companyPromptBlock: string });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    deps.status.setStatus(agentRun.id, 'error', `Resume failed: ${detail}`);
    deps.board.post('system', agentRun.id, 'message', `@${agentRun.role} resume FAILED: ${detail}`);
    deps.master.notify(
      `[SYSTEM] @${agentRun.role} (agent_run_id=${agentRun.id}) resume FAILED: ${detail}. ` +
        `Use spawn_subordinate_agent for a fresh start.`,
    );
    store.close();
    throw e;
  }

  deps.status.setStatus(agentRun.id, 'running');
  deps.runningIds.add(agentRun.id);
  deps.notifyIdleChanged();

  const subordinateHandle: SubordinateHandle = {
    agentRunId: agentRun.id,
    role: agentRun.role,
    projectIds,
    session: store.getSession(agentRun.coder_session_id)!,
    runner: handle.runner,
    bus: createBus(new AbortController()),
    done: handle.done,
  };
  deps.subordinates.set(agentRun.id, subordinateHandle);

  attachSubordinateCompletionHandler(
    handle,
    agentRun.id,
    agentRun.role,
    true,
    deps.completionDeps,
  );

  store.close();
  return {
    agentRunId: agentRun.id,
    coderSessionId: agentRun.coder_session_id,
    status: 'running',
  };
}
