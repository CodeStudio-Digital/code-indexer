/**
 * Spawn a fresh subordinate agent. Lifecycle:
 *
 *   1. Resolve project binding (role's `projectIds` vs spec.projectId).
 *   2. Concurrency cap enforcement.
 *   3. Resolve (provider, model) — spec > pool default > master inherit > legacy.
 *   4. Reject when an allowed_models pool is set and (provider, model) is outside.
 *   5. Create coder session row + agent_run row.
 *   6. Inherit master's disabled-tools config.
 *   7. Resolve sandbox binding + skill set for the subordinate's stack.
 *   8. Build CompanyContext + prompt block.
 *   9. `runCoder({ onRunnerReady })` to wire HumanInTheLoop BEFORE turn 1.
 *  10. Register in `subordinates`/`runningIds`, attach completion handler.
 *  11. `spec.wait` blocks until the runner exits.
 *
 * Extracted from `SubordinateLifecycle.spawn` so the 250-LOC body lives
 * in one file and the orchestration is documented in one place. The
 * deps bag enumerates every collaborator the original method touched.
 */
import { runCoder, type RunCoderOptions } from '@mcp/code-agent/index.js';
import { createBus } from '@apps/http-api/coder-bus.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';
import { SkillStore } from '@mcp/store/skill-store.js';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { buildSubordinateCompanyBlock } from '@mcp/company/system-prompts.js';
import {
  resolveRoleSkills,
  type AgentRunStatus,
  type AllowedModel,
  type CompanyContext,
  type SubordinateHandle,
} from '@mcp/company/types.js';
import type { ConcurrencyPolicy } from '@mcp/company/ConcurrencyPolicy.js';
import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { HumanInTheLoop } from '@mcp/company/services/HumanInTheLoop.js';
import { getGlobalAgentSupervisor } from '@mcp/company/services/supervisor/global.js';
import { wireSupervisorToRunner } from '@mcp/company/services/supervisor/wire-runner-events.js';
import type { MasterAttention } from '@mcp/company/services/MasterAttention.js';
import type {
  IAgentStatusUpdater,
  IBoardPoster,
  IKanbanNotifier,
  IMasterNotifier,
  IMetaBusWirer,
} from '@mcp/company/services/ports.js';
import {
  resolveSpawnProjectBinding,
  type SpawnSubordinateSpec,
} from '@mcp/company/services/subordinate/spec.js';
import {
  resolveBindingForProject,
} from '@mcp/company/services/subordinate/binding.js';
import {
  attachSubordinateCompletionHandler,
  type SubordinateCompletionDeps,
} from '@mcp/company/services/subordinate/completion-handler.js';
import {
  wireSubordinateInterceptionsForRunner,
} from '@mcp/company/services/subordinate/runner-wiring.js';

export interface SpawnSubordinateDeps {
  ctx: SessionContext;
  board: IBoardPoster;
  status: IAgentStatusUpdater;
  kanban: IKanbanNotifier;
  master: IMasterNotifier;
  humanInLoop: HumanInTheLoop;
  wirer: IMetaBusWirer;
  attention: MasterAttention;
  orchestratorRef: unknown;
  concurrencyPolicy: ConcurrencyPolicy;
  subordinates: Map<number, SubordinateHandle>;
  runningIds: Set<number>;
  notifyIdleChanged: () => void;
  /** Wire HumanInTheLoop + meta-bus listeners on the runner. */
  wireDeps: {
    humanInLoop: HumanInTheLoop;
    wirer: IMetaBusWirer;
  };
  /** Deps bag forwarded to `attachSubordinateCompletionHandler`. */
  completionDeps: SubordinateCompletionDeps;
  /** Helper to compose the `running` list in concurrency-error messages. */
  listRunning: () => Array<{ agentRunId: number; role: string }>;
}

interface SpawnResult {
  agentRunId: number;
  coderSessionId: number;
  status: AgentRunStatus;
}

/**
 * Pure-ish: throws on validation failure, mutates `subordinates`/
 * `runningIds`, awaits `runCoder`. Returns the new run id once the
 * runner is wired (or, when `spec.wait`, after the runner exits).
 */
export async function spawnSubordinate(
  spec: SpawnSubordinateSpec,
  deps: SpawnSubordinateDeps,
): Promise<SpawnResult> {
  const ctx = deps.ctx;

  // ── Project binding resolution ────────────────────────────────────
  const orchestratorForBinding = deps.orchestratorRef as {
    getProjectIdsForRole?: (role: string) => number[];
  };
  const boundProjectIds = orchestratorForBinding.getProjectIdsForRole?.(spec.role) ?? [];
  const projectId = resolveSpawnProjectBinding({
    role: spec.role,
    specProjectId: spec.projectId,
    boundProjectIds,
  });

  if (!ctx.projects.some((p) => p.project_id === projectId)) {
    throw new Error(
      `Project ${projectId} is not linked to company session ${ctx.companySessionId}`,
    );
  }
  spec.projectId = projectId;

  // ── Concurrency cap ───────────────────────────────────────────────
  const check = deps.concurrencyPolicy.check(deps.runningIds.size);
  if (!check.ok) {
    const running = deps
      .listRunning()
      .filter((s) => deps.runningIds.has(s.agentRunId))
      .map((s) => `${s.role}(run=${s.agentRunId})`)
      .join(', ');
    throw new Error(
      `spawnSubordinate refused (${check.current}/${check.max}). Running: ${running}. ${check.message}`,
    );
  }

  // ── Supervisor role-quarantine check (Phase 2.3) ──────────────────
  // The supervisor's per-role circuit breaker may have quarantined the
  // role after N spawn/recovery failures. Refuse spawns until the
  // cooldown elapses or an operator overrides via releaseRoleQuarantine.
  // This is intentionally before any IO so we fail fast.
  const supervisorForQuarantine = getGlobalAgentSupervisor();
  if (supervisorForQuarantine) {
    const quarantine = supervisorForQuarantine.isRoleQuarantined(spec.role);
    if (quarantine) {
      const remainingMs = Math.max(0, quarantine.quarantinedUntilMs - Date.now());
      const remainingS = Math.ceil(remainingMs / 1000);
      throw new Error(
        `spawnSubordinate refused: role '${spec.role}' is quarantined by supervisor ` +
          `after ${quarantine.failureTimestamps.length} recent failures. ` +
          `Available in ${remainingS}s (at ${new Date(quarantine.quarantinedUntilMs).toISOString()}). ` +
          `Operator override: AgentSupervisor.releaseRoleQuarantine('${spec.role}').`,
      );
    }
  }

  const config = loadConfig();
  const store = new SessionStore(config.dbPath);

  // ── Provider/model resolution + allowed-models enforcement ────────
  const orchestratorForPool = deps.orchestratorRef as {
    getAllowedModels?: () => readonly AllowedModel[];
    getPoolDefault?: () => AllowedModel | null;
  };
  const allowedModels = orchestratorForPool.getAllowedModels?.() ?? [];
  const poolDefault = orchestratorForPool.getPoolDefault?.() ?? null;

  let provider = spec.provider;
  let model = spec.model;
  if ((!provider || !model) && poolDefault) {
    provider = provider ?? poolDefault.provider;
    model = model ?? poolDefault.model;
  }
  // Last-resort fallback: inherit from the MASTER's provider/model
  // rather than the hardcoded anthropic/sonnet. This prevents the
  // "master is zai but subordinates spawn anthropic" mismatch when
  // the operator configured neither a template role nor a model pool.
  if (!provider || !model) {
    try {
      const masterRun = ctx.companyStore
        .listAgentRuns(ctx.companySessionId)
        .filter((r) => r.role === 'master')
        .pop();
      if (masterRun) {
        provider = provider ?? masterRun.provider;
        model = model ?? masterRun.model;
      }
    } catch {
      // fall through to the legacy hardcode on any failure — never
      // block a spawn just because the master lookup glitched.
    }
  }
  provider = provider ?? 'anthropic';
  model = model ?? 'claude-sonnet-4-6';

  if (allowedModels.length > 0) {
    const matched = allowedModels.some(
      (a) => a.provider === provider && a.model === model,
    );
    if (!matched) {
      const options = allowedModels
        .map((a) => `${a.provider}/${a.model}${a.is_default ? ' (default)' : ''}`)
        .join(', ');
      throw new Error(
        `Model '${provider}/${model}' is not in this session's allowed_models pool. ` +
          `Retry with one of: ${options}.`,
      );
    }
  }

  const project = ctx.db.getProject(spec.projectId);
  const projectName = project?.name ?? `project-${spec.projectId}`;

  deps.board.post(
    'system',
    null,
    'message',
    `Spawned @${spec.role} agent (project: ${projectName}, ${provider}/${model})`,
  );

  const subSession = store.createSession({
    project_id: spec.projectId,
    title: `[Company ${spec.role}] ${ctx.companySessionId}`,
    provider,
    model,
  });

  // Inherit master's disabled tool config so subordinates respect the
  // same tool restrictions the user configured for this company session.
  const masterHandle = deps.master.handle;
  if (masterHandle) {
    try {
      store.copyToolConfig(masterHandle.session.id, subSession.id);
    } catch (e) {
      console.warn(
        `[company] Failed to copy tool config to ${spec.role}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const subordinateBinding = resolveBindingForProject(ctx, deps.orchestratorRef, spec.projectId);
  const subordinateLabel =
    deps.ctx.projects.find((p) => p.project_id === spec.projectId)?.label ?? null;
  const subordinateStack = (
    deps.orchestratorRef as {
      getSandboxStackForService?: (serviceId?: string | null) => string | null;
    }
  ).getSandboxStackForService?.(subordinateLabel) ?? 'react-ts';

  // Resolve skills now that the subordinate stack is known. Conditional
  // template branches like `{ when: "session.stack === 'react-ts'", skill: 'ds-components-react' }`
  // pick the right primary; chain entries are appended verbatim.
  const resolvedSkills = resolveRoleSkills(spec.skills, { stack: subordinateStack });
  if (resolvedSkills.length > 0) {
    try {
      const skillStore = new SkillStore(config.dbPath);
      const allSkills = skillStore.resolveActiveSkills(subSession.id, spec.projectId);
      for (const skill of allSkills) {
        skillStore.setSessionSkillEnabled(
          subSession.id,
          skill.id,
          resolvedSkills.includes(skill.id),
        );
      }
      skillStore.close();
    } catch (e) {
      console.warn(
        `[company] Failed to configure skills for ${spec.role}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const agentRun = ctx.companyStore.createAgentRun({
    company_session_id: ctx.companySessionId,
    role: spec.role,
    coder_session_id: subSession.id,
    project_ids: [spec.projectId],
    provider,
    model,
  });
  const companyContext: CompanyContext = {
    orchestrator: deps.orchestratorRef as never,
    companySessionId: ctx.companySessionId,
    agentRole: spec.role,
    agentRunId: agentRun.id,
    allowedProjectIds: [spec.projectId],
    isMaster: false,
    sandbox: subordinateBinding ?? undefined,
  };

  const subordinateBlock = buildSubordinateCompanyBlock({
    role: spec.role,
    projects: [
      {
        id: spec.projectId,
        name: projectName,
        rootPath: project?.root_path ?? '',
      },
    ],
    builder: subordinateBinding
      ? {
          workdir: subordinateBinding.workdir,
          stack: subordinateStack,
          previewUrl: subordinateBinding.previewUrl,
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
            ).listSandboxPeers?.(
              subordinateBinding.serviceId ?? subordinateLabel,
            ) ?? undefined,
        }
      : undefined,
    overridePrompt: spec.roleOverride,
  });

  // Stored in the outer closure so `attachSubordinateCompletionHandler`
  // can call it from the `.finally` block after handle.done resolves
  // — prevents listener leaks. Reassigned inside `onRunnerReady` once
  // the runner instance exists. Default no-op so the call is safe
  // even when no supervisor was wired.
  let supervisorUnsubscribe: () => void = () => { /* no-op */ };

  const handle = await runCoder({
    session: { id: subSession.id },
    userMessage: spec.task,
    attachments: spec.attachments,
    maxTurns: 50,
    profile: spec.tier ?? 'navigate',
    agent: spec.agent,
    companyContext,
    companyPromptBlock: subordinateBlock,
    companyRoleOverride: spec.roleOverride,
    roleTemperature: spec.temperature,
    thinking: spec.thinking,
    thinkingBudgetTokens: spec.thinkingBudgetTokens,
    deepThink: spec.deepThink,
    deepThinkModel: spec.deepThinkModel,
    deepThinkProvider: spec.deepThinkProvider,
    preThinkOnToolResults: spec.preThinkOnToolResults,
    // Wire HumanInTheLoop + meta-bus listeners BEFORE the runner takes
    // turn 1, so a sub that calls `submit_plan_to_master` or
    // `ask_master` immediately on turn 1 doesn't slip through (same
    // race the master had — see MasterLifecycle.start).
    //
    // Phase 2.1 — ALSO subscribe the AgentSupervisor to runner events
    // so it gets fine-grained heartbeats (text_delta, tool_progress,
    // tool_call_start/result). Without these the supervisor's stuck
    // detection relies on coarse signals only.
    onRunnerReady: (runner) => {
      wireSubordinateInterceptionsForRunner(runner, agentRun.id, spec.role, deps.wireDeps);
      // Re-assigns the outer `supervisorUnsubscribe` so the
      // completion handler can fire it when the run ends. Without
      // this, listeners would leak after handle.done resolves.
      // Declared before runCoder() so TDZ doesn't bite the closure.
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      supervisorUnsubscribe = wireSupervisorToRunner(runner, agentRun.id);
    },
  } as RunCoderOptions & { companyPromptBlock: string });

  deps.status.setStatus(agentRun.id, 'running');
  deps.runningIds.add(agentRun.id);
  deps.notifyIdleChanged();

  // Sprint 4 (Phase 1.5) — register with the AgentSupervisor so it
  // starts tracking heartbeat + state. Null-safe: when supervisor is
  // disabled via env flag, this is a no-op.
  getGlobalAgentSupervisor()?.registerSubordinate({
    agentRunId: agentRun.id,
    companySessionId: deps.ctx.companySessionId,
    role: spec.role,
  });

  const subordinateHandle: SubordinateHandle = {
    agentRunId: agentRun.id,
    role: spec.role,
    projectIds: [spec.projectId],
    session: subSession,
    runner: handle.runner,
    bus: createBus(new AbortController()),
    done: handle.done,
  };
  deps.subordinates.set(agentRun.id, subordinateHandle);

  attachSubordinateCompletionHandler(handle, agentRun.id, spec.role, false, deps.completionDeps);

  // Phase 2.1 — ensure the supervisor's runner-event listeners are
  // unwired when the run ends. Independent of the completion handler's
  // own .finally — multiple .finally on the same promise are
  // dispatched independently.
  handle.done.finally(() => {
    try { supervisorUnsubscribe(); } catch { /* best-effort */ }
  });

  store.close();

  if (spec.wait) await handle.done;

  return {
    agentRunId: agentRun.id,
    coderSessionId: subSession.id,
    status: 'running',
  };
}
