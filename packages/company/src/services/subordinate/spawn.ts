/**
 * Spawn a fresh subordinate agent. Lifecycle:
 *
 *   1. Resolve project binding (role's `projectIds` vs spec.projectId).
 *   2. Concurrency cap enforcement.
 *   3. Resolve the authoritative persisted role runtime for every dispatch source.
 *   4. Reject disabled/malformed roles and models outside allowed_models.
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
import { installDocsDeepResearch } from '@mcp/docs-agent/bridges/docs-bridge.js';
import { createBus } from '@apps/http-api/coder-bus.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';
import { SkillStore } from '@mcp/store/skill-store.js';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { buildSubordinateCompanyBlock } from '@mcp/company/system-prompts.js';
import { readOperationalRules } from '@mcp/company/services/master/config-loader.js';
import {
  resolveRoleSkills,
  type AgentRunStatus,
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
  readRoleRuntimePolicy,
  resolveEffectiveRoleRuntime,
  type CompanyRuntimeKind,
} from '@mcp/company/services/subordinate/role-runtime.js';
import {
  resolveBindingForProject,
} from '@mcp/company/services/subordinate/binding.js';
import { resolveAutonomy } from '@mcp/company/services/autonomy/autonomy-config.js';
import type { AutonomyProvider } from '@mcp/company/services/autonomy/autonomy-provider.js';
import { checkGlobalSubordinateBudget } from '@mcp/company/services/subordinate/global-budget.js';
import {
  attachSubordinateCompletionHandler,
  type SubordinateCompletionDeps,
} from '@mcp/company/services/subordinate/completion-handler.js';
import {
  wireSubordinateInterceptionsForRunner,
} from '@mcp/company/services/subordinate/runner-wiring.js';
import { getCompanyMemoryPorts } from '@mcp/company/services/memory/ports.js';
import { fetchProjectMemoryBlock, fetchUserMemoryBlock } from '@mcp/company/services/memory/spawn-injection.js';
import { buildAppStudioSubordinateRuntimeBlock } from '@mcp/company/tools/app-studio/runtime-prompt.js';

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
  /** Synchronous spawn-reservation counter (closes the cap TOCTOU). See
   *  SubordinateLifecycle.pendingSpawns. */
  pendingSpawns: { count: number };
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
  /**
   * C2 — per-session autonomy config; source of the global-budget cap
   * (`maxSubordinates`, default 8). Optional: callers/tests without it
   * fall back to `resolveAutonomy(null, process.env)` — never crash.
   */
  autonomy?: Pick<AutonomyProvider, 'get'>;
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

  const companySession = ctx.companyStore.getCompanySession(ctx.companySessionId);
  const rowRuntimeKind = (companySession as { runtime_kind?: unknown } | null)?.runtime_kind;
  const runtimeKind: CompanyRuntimeKind = rowRuntimeKind === 'app_studio'
    ? 'app_studio'
    : 'company';
  const runtimePolicy = readRoleRuntimePolicy(
    companySession?.config_json,
    spec.role,
    runtimeKind,
  );

  // ── Project binding resolution ────────────────────────────────────
  const orchestratorForBinding = deps.orchestratorRef as {
    getProjectIdsForRole?: (role: string) => number[];
  };
  const boundProjectIds = Array.isArray(runtimePolicy.roleConfig?.projectIds)
    ? [...runtimePolicy.roleConfig.projectIds]
    : (orchestratorForBinding.getProjectIdsForRole?.(spec.role) ?? []);
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
  // Count in-flight reservations too — concurrent spawns (fan-out) reserve a
  // slot synchronously at this check, before `runningIds` gains their id, so
  // the cap holds even when N spawns race between the check and runCoder.
  const check = deps.concurrencyPolicy.check(deps.runningIds.size + deps.pendingSpawns.count);
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

  // Global spawn budget (Phase 5 homeostasis; C2 — default ON, cap 8). Coarse
  // cross-session backstop so N sessions don't collectively exhaust the
  // machine / trip provider rate limits. The COUNT is global (shared SQLite —
  // every worker reads the same file) but the CAP comes from THIS session's
  // autonomy config: each spawn checks the global count against its OWN
  // session's cap (session `maxSubordinates` > env > default 8; env '0' =
  // uncapped — see global-budget.ts for the full semantics).
  const autonomyCfg = deps.autonomy
    ? deps.autonomy.get()
    : resolveAutonomy(null, process.env);
  const budget = checkGlobalSubordinateBudget({
    cap: autonomyCfg.maxSubordinates,
    countActive: () => ctx.companyStore.countActiveSubordinatesGlobal(),
  });
  if (!budget.ok) throw new Error(budget.message);

  // Reserve the slot for the whole spawn; released in the `finally` at the end
  // (success transfers the count into `runningIds`, failure just frees it).
  deps.pendingSpawns.count++;
  try {

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

  // ── Authoritative role runtime resolution ────────────────────────
  // Every caller (Master, scheduler/manual dispatch, pipeline, fan-out and
  // App Studio) converges here. The persisted role assignment wins over any
  // caller-supplied model and never consults the global subagent override.
  let masterRuntime: { provider: string; model: string } | null = null;
  try {
    const masterRun = ctx.companyStore
      .listAgentRuns(ctx.companySessionId)
      .filter((run) => run.role === 'master')
      .pop();
    if (masterRun) masterRuntime = { provider: masterRun.provider, model: masterRun.model };
  } catch {
    // Generic Company sessions retain their legacy default when the lookup
    // fails. App Studio roles cannot reach that branch because they must be
    // configured in role_assignments.
  }
  const roleRuntime = resolveEffectiveRoleRuntime({
    role: spec.role,
    runtimeKind: runtimePolicy.runtimeKind,
    roleConfig: runtimePolicy.roleConfig,
    requested: spec,
    allowedModels: runtimePolicy.allowedModels,
    poolDefault: runtimePolicy.poolDefault,
    masterRuntime,
    dispatchSource: spec.dispatchSource,
  });
  const { provider, model } = roleRuntime;

  const config = loadConfig();
  const store = new SessionStore(config.dbPath);

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
  const resolvedSkills = resolveRoleSkills(roleRuntime.skills, { stack: subordinateStack });
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
    configured_provider: roleRuntime.configuredProvider ?? provider,
    configured_model: roleRuntime.configuredModel ?? model,
    dispatch_source: roleRuntime.dispatchSource,
    fallback_reason: null,
  });
  const companyContext: CompanyContext = {
    orchestrator: deps.orchestratorRef as never,
    companySessionId: ctx.companySessionId,
    runtimeKind: ctx.runtimeKind,
    appStudioSessionId: ctx.appStudioSessionId ?? undefined,
    capabilities: ctx.capabilities,
    agentRole: spec.role,
    agentRunId: agentRun.id,
    allowedProjectIds: [spec.projectId],
    isMaster: false,
    sandbox: subordinateBinding ?? undefined,
  };

  // Mem C — task-relevant project memory, rendered into the system prompt
  // so the subordinate is born knowing prior runs' decisions/gotchas (and
  // keeps them through compaction). Best-effort with a 2s ceiling: any
  // failure → '' and the spawn proceeds without a block.
  // PROJECT MEMORY (this codebase) + global USER PREFERENCES — both rendered
  // into the system prompt so a fresh subordinate is born knowing prior
  // decisions AND how the user wants it to work. Best-effort, 2s cap each.
  const [projectMemory, userMemory] = await Promise.all([
    fetchProjectMemoryBlock({
      projectId: spec.projectId,
      projectName,
      taskText: spec.task,
      db: ctx.db,
    }),
    fetchUserMemoryBlock({ taskText: spec.task }),
  ]);

  let subordinateBlock = buildSubordinateCompanyBlock({
    role: spec.role,
    projects: [
      {
        id: spec.projectId,
        name: projectName,
        rootPath: project?.root_path ?? '',
      },
    ],
    projectMemory: [projectMemory, userMemory].filter(Boolean).join('\n') || undefined,
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
    overridePrompt: roleRuntime.roleOverride,
    // Session-level operational rules, injected verbatim into every spawn so
    // policy survives reactivation/compaction (system prompt, not turn history).
    operationalRules: readOperationalRules(
      ctx.companyStore.getCompanySession(ctx.companySessionId)?.config_json,
    ),
    runtimeKind: ctx.capabilities.promptProfile,
  });
  if (ctx.runtimeKind === 'app_studio' && ctx.appStudioSessionId != null) {
    subordinateBlock += `\n\n${buildAppStudioSubordinateRuntimeBlock({
      appSessionId: ctx.appStudioSessionId,
      role: spec.role,
    })}`;
  }

  // Stored in the outer closure so `attachSubordinateCompletionHandler`
  // can call it from the `.finally` block after handle.done resolves
  // — prevents listener leaks. Reassigned inside `onRunnerReady` once
  // the runner instance exists. Default no-op so the call is safe
  // even when no supervisor was wired.
  let supervisorUnsubscribe: () => void = () => { /* no-op */ };

  // Mem C — bridge-backed memory ports (set in company-worker boot). When
  // wired, the runner gets per-turn memory injection on task changes AND
  // run-end distillation (gotchas/decisions/recipes → project snapshots),
  // so what this subordinate learns reaches every future session.
  const memoryPorts = getCompanyMemoryPorts();

  const handle = await runCoder({
    session: { id: subSession.id },
    userMessage: spec.task,
    attachments: spec.attachments,
    maxTurns: 50,
    profile: roleRuntime.tier,
    agent: spec.agent,
    memoryRetriever: memoryPorts?.memoryRetriever,
    runEndMemory: memoryPorts?.runEndMemory,
    companyContext,
    companyPromptBlock: subordinateBlock,
    companyRoleOverride: roleRuntime.roleOverride,
    roleTemperature: roleRuntime.temperature,
    thinking: roleRuntime.thinking,
    thinkingBudgetTokens: roleRuntime.thinkingBudgetTokens,
    reasoningEffort: roleRuntime.reasoningEffort,
    initialPinnedTools: roleRuntime.initialTools,
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
      // docs_deep_research — DocsAgent escalation; per-runner install (the
      // company-worker's docsResearch RPC shim is the other half). Navigate
      // tier, and subordinates default to profile 'navigate'+, so it
      // surfaces without an expand_toolset round-trip.
      installDocsDeepResearch(runner);
      // Re-assigns the outer `supervisorUnsubscribe` so the
      // completion handler can fire it when the run ends. Without
      // this, listeners would leak after handle.done resolves.
      // Declared before runCoder() so TDZ doesn't bite the closure.
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      supervisorUnsubscribe = wireSupervisorToRunner(runner, agentRun.id);
    },
  } as RunCoderOptions & { companyPromptBlock: string });

  // publishStatus (not setStatus) so the dashboard learns about the new
  // subordinate live — and carries `coderSessionId` so its agent row is
  // clickable (opens the transcript) from the moment it appears.
  deps.status.publishStatus(agentRun.id, spec.role, 'running', {
    coderSessionId: subSession.id,
  });
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
  } finally {
    // Release the reservation. On success the run is already in `runningIds`
    // (added above), so the effective count is unchanged; on any throw between
    // the cap check and here, this frees the slot we held.
    deps.pendingSpawns.count--;
  }
}
