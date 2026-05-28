/**
 * execute_tasks — wave-based orchestrator (PR 3).
 *
 * Replaces the model-driven `execute_task` workflow with a single
 * deterministic dispatcher. The master calls `execute_tasks` ONCE; the
 * tool walks the dependency graph, batches independent tasks into
 * concurrent waves (by `parallel_group`), spawns the right kind of
 * subagent per task (investigate / implement / verify), and returns a
 * consolidated summary. No more `execute_task` loop, no more
 * task-mode-gate confusion, no more "did the model remember to call it?"
 *
 * Tool dispatch per `kind`:
 *   - investigate → READ_ONLY_FILTER  + EXPLORE_SYSTEM_PROMPT
 *   - implement   → READ_WRITE_FILTER + IMPLEMENT_SYSTEM_PROMPT + pathScope
 *   - verify      → VERIFY_FILTER     + VERIFY_SYSTEM_PROMPT
 *
 * Modes:
 *   - 'auto' (default) — subagent dispatch per kind, parallel batching.
 *   - 'inline-all'     — every task runs inline in the master (legacy).
 */
import type { CoderTool, ToolResult, ToolContext, JsonSchema } from '@mcp/code-agent/core/tool.js';
import type { ChatUsage, AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { CoderTask, TaskStatus, TasksState } from '@mcp/code-agent/sessions/types.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import {
  runSubagent,
  runParallelAgents,
  emptyCollected,
  READ_ONLY_FILTER,
  READ_WRITE_FILTER,
  VERIFY_FILTER,
  type SubagentAllowlist,
  type ParallelAgentSpec,
} from '@mcp/code-agent/tools/implement-subagent.js';
import {
  EXPLORE_SYSTEM_PROMPT,
  IMPLEMENT_SYSTEM_PROMPT,
  type SubagentDeps,
} from '@mcp/code-agent/tools/subagent.js';
import {
  type ExecuteTasksMode,
  type TaskLimit,
  type TaskRunContext,
  type TaskRunPersist,
  type TaskRunProgressMeta,
  type TaskRunResult,
  type TaskRunTaskMode,
  accumulateUsage,
  applyStatus,
  makeTaskRunId,
  resolveTaskRunMode,
  seedStatusById,
  taskKind,
} from './execute-tasks/task-run-types.js';
import {
  BudgetTracker,
  type BudgetAskCallback,
  type BudgetDecision,
  loadDefaultTokenCap,
  resolveTaskLimit,
} from './execute-tasks/task-run-budget.js';
import { createTaskRunPersist } from './execute-tasks/task-run-persistence.js';
import { dispatchWithRetry } from './execute-tasks/task-retry.js';
import { shouldSkipTask } from './execute-tasks/task-stale-check.js';

const VERIFY_SYSTEM_PROMPT = `You are a VERIFY subagent. The parent agent delegated a verification task to you.

You have READ access + shell + LSP diagnostics. You CANNOT edit any code.
Your job: run the relevant tests / linters / type-checkers, observe results, report what passed and what failed.

# Rules
1. Use run_command for tests/linters. Use get_diagnostics / lsp_diagnostics for LSP-driven checks.
2. NEVER attempt to write or patch files. If you find an issue, report it — the parent agent will dispatch a fix.
3. Stop and write a final summary listing what was verified and the result.
4. NEVER end your run with only tool calls and no text.

# Output format

## Verified
- <check name>: passed | failed (<short reason>)

## Failures (if any)
- <test/file>: <short error excerpt> at <file:line>

## Suggested next step
<one line — usually "fix X in Y" — or "all green, no action">
`;

// ─── Wave/group planning (pure) ─────────────────────────────────

interface TaskGroup {
  groupId: string | null;
  tasks: CoderTask[];
}

function resolveExecuteTasksMode(args: Record<string, unknown>, state: TasksState): ExecuteTasksMode {
  if (args.mode === 'inline-all') return 'inline-all';
  if (args.mode === 'auto') return 'auto';
  return state.execution_mode === 'inline' ? 'inline-all' : 'auto';
}

/**
 * Topological wave planning. Returns an ordered list of waves where each
 * wave contains tasks whose dependencies are all in earlier waves (or
 * already done/skipped). Throws on dependency cycle.
 */
export function buildWaves(tasks: CoderTask[]): CoderTask[][] {
  const terminal = (t: CoderTask): boolean => t.status === 'done' || t.status === 'skipped';
  const pending = new Map(tasks.filter((t) => !terminal(t)).map((t) => [t.id, t]));
  const waves: CoderTask[][] = [];

  while (pending.size > 0) {
    const wave: CoderTask[] = [];
    for (const t of pending.values()) {
      const blocked = t.depends_on.some((dep) => pending.has(dep));
      if (!blocked) wave.push(t);
    }
    if (wave.length === 0) {
      throw new Error(
        `execute_tasks: dependency cycle detected — pending=${Array.from(pending.keys()).join(', ')}`,
      );
    }
    for (const t of wave) pending.delete(t.id);
    waves.push(wave);
  }
  return waves;
}

/**
 * Within a single wave, group by `parallel_group`. Tasks sharing the same
 * group (and present in the same wave — so no mutual deps) run together;
 * standalone tasks each become a singleton group.
 */
export function groupByParallel(wave: CoderTask[]): TaskGroup[] {
  const groups = new Map<string, CoderTask[]>();
  const singletons: TaskGroup[] = [];
  for (const t of wave) {
    if (t.parallel_group) {
      const list = groups.get(t.parallel_group) ?? [];
      list.push(t);
      groups.set(t.parallel_group, list);
    } else {
      singletons.push({ groupId: null, tasks: [t] });
    }
  }
  const out: TaskGroup[] = Array.from(groups, ([groupId, tasks]) => ({ groupId, tasks }));
  return [...out, ...singletons];
}

// ─── Per-kind artifacts ────────────────────────────────────────

interface KindArtifacts {
  systemPrompt: string;
  allowlist: SubagentAllowlist;
  pathScope?: string[];
}

function resolveKindArtifacts(task: CoderTask): KindArtifacts {
  const kind = task.kind ?? 'implement';
  switch (kind) {
    case 'investigate':
      return { systemPrompt: EXPLORE_SYSTEM_PROMPT, allowlist: READ_ONLY_FILTER };
    case 'verify':
      return { systemPrompt: VERIFY_SYSTEM_PROMPT, allowlist: VERIFY_FILTER };
    case 'implement':
    default:
      return {
        systemPrompt: IMPLEMENT_SYSTEM_PROMPT,
        allowlist: READ_WRITE_FILTER,
        pathScope: task.files.length > 0 ? task.files : undefined,
      };
  }
}

// ─── Tool definition ────────────────────────────────────────────

const EXECUTE_TASKS_DESC =
  'Execute every pending task in the approved task list, automatically respecting `depends_on` (sequential waves) ' +
  'and `parallel_group` (concurrent within a wave). Per-task `kind` drives the subagent toolset:\n' +
  "  - 'investigate' → read-only exploration.\n" +
  "  - 'implement'   → read+write+shell, scoped to the task's `files`.\n" +
  "  - 'verify'      → tests/linters/lsp, no write.\n" +
  '\n' +
  'Returns a consolidated summary of every task that ran. Call this ONCE after submit_tasks is approved — ' +
  'do NOT loop execute_task by hand. Token cost of every subagent IS billed to this session.';

const executeTasksSchema: JsonSchema = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['auto', 'inline-all'],
      description:
        "'auto' (default) — subagent per task, parallel where safe. " +
        "'inline-all' — run every task inline in the master (legacy escape hatch).",
    },
  },
  additionalProperties: false,
} as unknown as JsonSchema;

export function buildExecuteTasksTool(deps: SubagentDeps): CoderTool {
  return {
    name: 'execute_tasks',
    description: EXECUTE_TASKS_DESC,
    parameters: executeTasksSchema,
    source: 'native',
    mutates: true,
    handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
      const state = ctx.getTasksState?.();
      if (!state) return err('execute_tasks: no tasks state found. Call submit_tasks first.');
      if (!state.approved) return err('execute_tasks: task list not approved yet.');
      if (state.tasks.length === 0) return err('execute_tasks: empty task list.');

      const mode: ExecuteTasksMode = resolveExecuteTasksMode(args, state);
      const parentSessionId = ctx.runner?.sessionId;
      console.log(
        `[coder/tasks] execute_tasks start session=${parentSessionId ?? '?'} ` +
        `mode=${mode} total=${state.tasks.length}`,
      );

      let waves: CoderTask[][];
      try {
        waves = buildWaves(state.tasks);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }

      if (waves.length === 0) {
        return ok('execute_tasks: all tasks already terminal (done/skipped). Nothing to run.');
      }

      const runId = makeTaskRunId();
      const startedAt = new Date().toISOString();
      const totalRunnableTasks = waves.reduce((sum, wave) => sum + wave.length, 0);

      // PR-B persistence bridge. Inert when there's no real session store
      // (test contexts, inline tools without a session row).
      const persist = createTaskRunPersist({
        store: deps.sessionStore,
        sessionId: ctx.runner?.sessionId,
      });
      persist.recordRunStarted({ runId, mode, startedAt });

      // PR-E: token budget tracker. Cap of 0/null means unlimited (gate
      // becomes a no-op). When over, the orchestrator asks the user via
      // runner.waitForUserInput on a budget-specific askId so the call
      // doesn't clash with a concurrent ask_user/submit_plan.
      const tokenCap = loadDefaultTokenCap();
      const budget = new BudgetTracker({ tokensCap: tokenCap });
      const runnerForAsk = ctx.runner;
      const askUserBudget: BudgetAskCallback | undefined = runnerForAsk
        ? async (req) => {
            const askId = `budget_${runId}_${Date.now().toString(36)}`;
            runnerForAsk.emit('budget_request', { ask_id: askId, run_id: runId, ...req });
            const raw = await runnerForAsk.waitForUserInput(askId);
            return parseBudgetAnswer(raw);
          }
        : undefined;

      ctx.runner?.emit('task_run_started', {
        run_id: runId,
        mode,
        total_tasks: totalRunnableTasks,
        waves: waves.map((wave, i) => ({
          index: i + 1,
          tasks: wave.map((task) => ({
            id: task.id,
            title: task.title,
            kind: task.kind ?? 'implement',
            mode: mode === 'inline-all' ? 'inline' : 'subagent',
          })),
        })),
      });
      ctx.reportProgress?.(`execute_tasks: ${totalRunnableTasks} task(s) across ${waves.length} wave(s)`);

      // PR-G: smart inline. If a previous execute_tasks call opened an
      // inline task scope and the agent hasn't called task_complete yet,
      // refuse with an actionable message instead of opening a second
      // scope on top.
      const activeScopeId = ctx.runner?.currentTaskScopeId?.();
      if (activeScopeId) {
        const activeTask = state.tasks.find((t) => t.id === activeScopeId);
        return err(
          `execute_tasks: an inline task scope is already active (${activeScopeId}` +
            (activeTask ? ` "${activeTask.title}"` : '') +
            '). Finish it with task_complete(task_id, summary, ...) before calling execute_tasks again.',
        );
      }

      const summaries: string[] = [];
      const totalUsage: ChatUsage = { input_tokens: 0, output_tokens: 0 };
      let failedTasks = 0;
      const statusById = seedStatusById(state.tasks);
      // PR-G: when we open an inline scope, we return early with a
      // bespoke message. This flag short-circuits the wave loop.
      let openedInlineScope: { task: CoderTask; remaining: number } | null = null;

      try {
        outer: for (let w = 0; w < waves.length; w++) {
          const wave = waves[w];
          const groups = groupByParallel(wave);
          console.log(
            `[coder/tasks] wave ${w + 1}/${waves.length} — ${wave.length} task(s) in ${groups.length} group(s)`,
          );

          for (const group of groups) {
            const run: TaskRunContext = { runId, mode, wave: w + 1, totalWaves: waves.length, persist };
            const runnableSubagent: CoderTask[] = [];
            const runnableInline: CoderTask[] = [];
            const fingerprintByTask = new Map<string, string | null>();
            const skipped: TaskRunResult[] = [];
            for (const task of group.tasks) {
              const blockedBy = firstBlockedDependency(task, statusById);
              if (blockedBy) {
                const skippedResult = skipTaskDueToDependency(ctx, run, task, blockedBy);
                applyStatus(statusById, task.id, skippedResult.status);
                skipped.push(skippedResult);
                continue;
              }
              // PR-D: stale-skip check. When inputs are unchanged since
              // the last successful run, skip silently with a synthetic
              // result that the dashboard renders as 'skipped+stale'.
              const staleVerdict = shouldSkipTask({
                task,
                cwd: ctx.cwd ?? process.cwd(),
                store: deps.sessionStore,
              });
              if (staleVerdict.skip) {
                const skippedResult = skipTaskAsStale(ctx, run, task, staleVerdict);
                applyStatus(statusById, task.id, skippedResult.status);
                skipped.push(skippedResult);
                continue;
              }
              // PR-E: budget gate — consult tracker BEFORE adding to runnable.
              const verdict = await budget.checkBeforeTask({ ask: askUserBudget });
              if (verdict === 'abort') {
                // User pressed cancel_pending — drop this task AND every
                // task that would have come after it in this loop.
                skipped.push(skipTaskAsBudgetCapped(ctx, run, task, 'budget_cap_cancel'));
                applyStatus(statusById, task.id, 'skipped');
                continue;
              }
              if (verdict === 'skip') {
                // 'stop_after_current' branch — current task already running
                // elsewhere, just skip the queued ones.
                skipped.push(skipTaskAsBudgetCapped(ctx, run, task, 'budget_cap'));
                applyStatus(statusById, task.id, 'skipped');
                continue;
              }
              fingerprintByTask.set(task.id, staleVerdict.fingerprint);
              // PR-G: route by per-task run mode (respects per-task/smart picker).
              const runMode = resolveTaskRunMode(task, state.execution_mode, mode);
              if (runMode === 'inline') runnableInline.push(task);
              else runnableSubagent.push(task);
            }

            // PR-G: subagents run FIRST (in parallel) — then we'll open
            // the inline scope so the parent runner can take over.
            const tasksRun = runnableSubagent.length === 0
              ? { results: [], usage: { input_tokens: 0, output_tokens: 0 } as ChatUsage }
              : runnableSubagent.length === 1
                ? await runGroupSequential(deps, runnableSubagent, ctx, run, fingerprintByTask)
                : await runGroupParallel(deps, runnableSubagent, ctx, run, fingerprintByTask);

            for (const r of [...skipped, ...tasksRun.results]) {
              applyStatus(statusById, r.task.id, r.status);
              if (r.status === 'failed' || r.status === 'interrupted' || r.status === 'skipped') failedTasks++;
              summaries.push(formatTaskRunSummary(r));
            }
            accumulateUsage(totalUsage, tasksRun.usage);
            // PR-E: feed REAL spend back to the tracker after each group.
            budget.addSpend(tasksRun.usage.input_tokens ?? 0, tasksRun.usage.output_tokens ?? 0);

            // PR-G: now open the first inline scope (one at a time —
            // inline tasks need the parent runner to actually work).
            // Remaining inline tasks (this group + downstream waves)
            // will be unblocked on the next execute_tasks call.
            if (runnableInline.length > 0) {
              const firstInline = runnableInline[0];
              const remainingInThisRun = countRemainingInline(
                state.tasks, statusById, firstInline.id,
              );
              openInlineScope(ctx, run, firstInline);
              openedInlineScope = { task: firstInline, remaining: remainingInThisRun };
              applyStatus(statusById, firstInline.id, 'running');
              break outer;
            }
          }
        }
      } catch (e) {
        failedTasks++;
        const message = e instanceof Error ? e.message : String(e);
        summaries.push(`### execute_tasks — orchestrator failure [status=failed]\n${message}`);
      }

      // PR-G: paused-mid-run path — an inline scope was opened, the run
      // is NOT finished. The dashboard still shows the run as 'running'
      // (no task_run_finished emit). The agent must call task_complete +
      // re-call execute_tasks to continue.
      if (openedInlineScope) {
        const header =
          `[execute_tasks paused: opened inline scope on '${openedInlineScope.task.id}'. ` +
          `${openedInlineScope.remaining > 0
            ? `${openedInlineScope.remaining} more inline task(s) pending after this one.`
            : 'This is the last inline task.'}]\n\n`;
        const completedSummaries = summaries.length > 0
          ? `Subagent tasks finished before opening inline scope:\n\n${summaries.join('\n\n---\n\n')}\n\n---\n\n`
          : '';
        const inlineInstruction = renderInlineScopeInstruction(
          openedInlineScope.task,
          openedInlineScope.remaining,
        );
        return { ...ok(header + completedSummaries + inlineInstruction), subUsage: totalUsage };
      }

      const runFinishedAt = new Date().toISOString();
      const runStatus: 'completed' | 'failed' = failedTasks > 0 ? 'failed' : 'completed';
      persist.recordRunFinished({
        runId,
        status: runStatus,
        finishedAt: runFinishedAt,
        totalUsage,
      });
      ctx.runner?.emit('task_run_finished', {
        run_id: runId,
        status: runStatus,
        total_usage: totalUsage,
        finished_at: runFinishedAt,
      });

      const header =
        `[execute_tasks: ${waves.length} wave(s), ${state.tasks.length} task(s), ` +
        `input=${totalUsage.input_tokens} output=${totalUsage.output_tokens}]\n\n`;
      return { ...ok(header + summaries.join('\n\n---\n\n')), subUsage: totalUsage };
    },
  };
}

// ─── Group runners ──────────────────────────────────────────────

async function runGroupSequential(
  deps: SubagentDeps,
  tasks: CoderTask[],
  ctx: ToolContext,
  run: TaskRunContext,
  fingerprintByTask?: Map<string, string | null>,
): Promise<{ results: TaskRunResult[]; usage: ChatUsage }> {
  const results: TaskRunResult[] = [];
  const usage: ChatUsage = { input_tokens: 0, output_tokens: 0 };
  for (const t of tasks) {
    const fingerprint = fingerprintByTask?.get(t.id) ?? null;
    const r = await runOneTask(deps, t, ctx, run, fingerprint);
    results.push(r);
    accumulateUsage(usage, r.usage);
  }
  return { results, usage };
}

async function runGroupParallel(
  deps: SubagentDeps,
  tasks: CoderTask[],
  ctx: ToolContext,
  run: TaskRunContext,
  fingerprintByTask?: Map<string, string | null>,
): Promise<{ results: TaskRunResult[]; usage: ChatUsage }> {
  void fingerprintByTask; // PR-D: parallel groups don't yet thread fingerprint
  // through (single retry attempt, no per-attempt persist loop). Future work.
  const startedAt = new Date().toISOString();
  for (const t of tasks) {
    emitTaskRunTaskStarted(ctx, run, t, startedAt, 'subagent');
    ctx.updateTaskStatus?.(t.id, { status: 'running', started_at: startedAt, mode_used: 'subagent' });
    ctx.runner?.emit('task_started', { task_id: t.id, mode: 'subagent', started_at: startedAt });
  }

  const specs: ParallelAgentSpec[] = tasks.map((t) => {
    const art = resolveKindArtifacts(t);
    return {
      task: buildTaskBriefing(t),
      label: `${t.kind ?? 'implement'}:${t.id}`,
      maxTurns: 100,
      systemPrompt: art.systemPrompt,
      allowlist: art.allowlist,
      pathScope: art.pathScope,
      limits: resolveTaskLimit(t),
    };
  });

  const groupId = `tasks-wave-${Date.now().toString(36)}`;
  ctx.runner?.emit('agents_group_start', {
    groupId,
    agents: tasks.map((t, i) => ({ index: i, label: `${t.kind ?? 'implement'}:${t.id}` })),
  });

  let parallelRun: Awaited<ReturnType<typeof runParallelAgents>>;
  try {
    parallelRun = await runParallelAgents(
      {
        provider: deps.subagentProvider ?? deps.provider,
        tools: deps.parentTools,
        ctx,
        sessionId: ctx.runner?.sessionId,
        agentLoopV2: ctx.runner?.agentLoopV2 ?? false,
      },
      specs,
      IMPLEMENT_SYSTEM_PROMPT, // global fallback (never used — per-spec wins)
      READ_WRITE_FILTER,        // global fallback (never used — per-spec wins)
      (progress) => {
        ctx.runner?.emit('agent_progress', { groupId, ...progress });
        const task = tasks[progress.agentIndex];
        if (!task) return;
        if (progress.event === 'tool_call' || progress.event === 'heartbeat') {
          const count = progress.toolCallCount ?? 0;
          emitTaskRunTaskProgress(
            ctx,
            run,
            task,
            count,
            progress.note ?? `${progress.label}: ${count} tool call(s)`,
            progressToTaskMeta(progress, resolveTaskLimit(task)),
          );
        }
      },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    parallelRun = {
      results: tasks.map((t) => ({
        label: `${t.kind ?? 'implement'}:${t.id}`,
        reason: 'error',
        finalText: message,
        usage: { input_tokens: 0, output_tokens: 0 },
        sandboxViolations: [],
        collected: emptyCollected(),
        toolCallCount: 0,
      })),
      totalUsage: { input_tokens: 0, output_tokens: 0 },
    };
  }
  const { results, totalUsage } = parallelRun;

  ctx.runner?.emit('agents_group_end', {
    groupId,
    totalUsage,
    agentCount: results.length,
    successCount: results.filter((r) => r.reason === 'completed').length,
  });

  const finishedAt = new Date().toISOString();
  const summaries: TaskRunResult[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const r = results[i];
    const status: TaskStatus = r.reason === 'completed' ? 'done' : 'failed';
    const summary = r.finalText || '(no summary)';
    const taskResult = {
      summary,
      files_modified: [],
      errors: status === 'failed' ? summary : undefined,
    };
    ctx.updateTaskStatus?.(t.id, {
      status,
      finished_at: finishedAt,
      result: taskResult,
    });
    ctx.runner?.emit('task_finished', {
      task_id: t.id,
      status,
      result: taskResult,
      finished_at: finishedAt,
    });
    emitTaskRunTaskFinished(ctx, run, t, {
      status,
      summary,
      error: taskResult.errors,
      usage: r.usage,
      toolCallCount: r.toolCallCount,
      finishedAt,
    });
    summaries.push({
      task: t,
      status,
      summary,
      error: taskResult.errors,
      usage: r.usage,
      toolCallCount: r.toolCallCount,
      wave: run.wave,
    });
  }
  return { results: summaries, usage: totalUsage };
}

async function runOneTask(
  deps: SubagentDeps,
  task: CoderTask,
  ctx: ToolContext,
  run: TaskRunContext,
  /** PR-D: fingerprint pre-computed by the wave loop; persisted on each
   *  attempt so future runs of the same task can compare. Null when the
   *  task has too many files or skip-stale is disabled. */
  inputsFingerprint: string | null = null,
): Promise<TaskRunResult> {
  // Task-level lifecycle (fires ONCE regardless of retry count).
  const taskStartedAt = new Date().toISOString();
  ctx.updateTaskStatus?.(task.id, { status: 'running', started_at: taskStartedAt, mode_used: 'subagent' });
  ctx.runner?.emit('task_started', { task_id: task.id, mode: 'subagent', started_at: taskStartedAt });

  const art = resolveKindArtifacts(task);
  const limits = resolveTaskLimit(task);

  // PR-C: each attempt re-spawns a fresh subagent with the same briefing.
  // Per-attempt rows land in coder_task_run_items via run.persist; the
  // dashboard's task_run_task_started/_finished SSEs fire once for the
  // FIRST attempt (so kanban transitions don't flicker) and the FINAL
  // attempt's outcome.
  const { result: attemptResult, attempts } = await dispatchWithRetry<{
    status: TaskStatus;
    summary: string;
    error?: string;
    usage: ChatUsage;
    toolCallCount: number;
    finishedAt: string;
  }>(async (attemptIdx) => {
    const attemptStartedAt = new Date().toISOString();
    if (attemptIdx === 0) {
      // First attempt — emit live SSE start. Subsequent retries persist
      // silently (dashboard will see the final outcome reflect retry count).
      emitTaskRunTaskStarted(ctx, run, task, attemptStartedAt, 'subagent', 0);
    } else {
      run.persist.recordTaskStarted({
        runId: run.runId,
        task,
        waveIdx: run.wave,
        startedAt: attemptStartedAt,
        attempt: attemptIdx,
      });
      console.log(
        `[coder/tasks] retry attempt=${attemptIdx} task=${task.id} (transient failure on previous attempt)`,
      );
    }

    let toolCallCount = 0;
    const initialMessages: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: buildTaskBriefing(task) }] },
    ];
    let raw: Awaited<ReturnType<typeof runSubagent>>;
    try {
      raw = await runSubagent(
        {
          provider: deps.subagentProvider ?? deps.provider,
          tools: deps.parentTools,
          ctx,
          sessionId: ctx.runner?.sessionId,
          sessionStore: deps.sessionStore,
          agentLoopV2: ctx.runner?.agentLoopV2 ?? false,
        },
        {
          systemPrompt: art.systemPrompt,
          allowlist: art.allowlist,
          initialMessages,
          maxTurns: 100,
          pathScope: art.pathScope,
          limits,
          onProgress: (progress) => {
            toolCallCount = progress.toolCallCount;
            emitTaskRunTaskProgress(
              ctx,
              run,
              task,
              toolCallCount,
              progress.note,
              progressToTaskMeta(progress, limits),
            );
          },
        },
      );
    } catch (e) {
      raw = {
        reason: 'error',
        finalText: e instanceof Error ? e.message : String(e),
        usage: { input_tokens: 0, output_tokens: 0 },
        sandboxViolations: [],
        collected: emptyCollected(),
      };
    }

    const finishedAt = new Date().toISOString();
    const status: TaskStatus = raw.reason === 'completed' ? 'done' : 'failed';
    const summary = raw.finalText || '(no summary)';
    const error = status === 'failed' ? summary : undefined;

    // Per-attempt persistence — separate row in coder_task_run_items.
    // PR-D: include fingerprint so future runs of the same task can
    // skip-stale-compare. Only persist on success — failed attempts
    // get null so we don't accidentally "match" a stale failed state.
    run.persist.recordTaskFinished({
      runId: run.runId,
      task,
      waveIdx: run.wave,
      status,
      finishedAt,
      toolCallCount,
      usage: raw.usage,
      summary,
      attempt: attemptIdx,
      ...(error ? { error } : {}),
      ...(status === 'done' && inputsFingerprint ? { inputsFingerprint } : {}),
    });

    return {
      result: { status, summary, error, usage: raw.usage, toolCallCount, finishedAt },
      shouldStop: status === 'done',
      errorMessage: error,
    };
  });

  // Task-level finalization (fires ONCE with the FINAL attempt's outcome).
  const taskResult = {
    summary: attemptResult.summary,
    files_modified: [] as string[],
    errors: attemptResult.error,
  };
  ctx.updateTaskStatus?.(task.id, {
    status: attemptResult.status,
    finished_at: attemptResult.finishedAt,
    result: taskResult,
  });
  ctx.runner?.emit('task_finished', {
    task_id: task.id,
    status: attemptResult.status,
    result: taskResult,
    finished_at: attemptResult.finishedAt,
  });
  // Emit SSE for dashboard. dispatchWithRetry already persisted the
  // per-attempt rows (including the final attempt), so skip the re-persist
  // here — emit-only mode.
  emitTaskRunTaskFinished(ctx, run, task, {
    status: attemptResult.status,
    summary: attemptResult.summary,
    error: attemptResult.error,
    usage: attemptResult.usage,
    toolCallCount: attemptResult.toolCallCount,
    finishedAt: attemptResult.finishedAt,
    attempt: attempts - 1,
    skipPersist: true,
  });

  return {
    task,
    status: attemptResult.status,
    summary: attemptResult.summary,
    error: attemptResult.error,
    usage: attemptResult.usage,
    toolCallCount: attemptResult.toolCallCount,
    wave: run.wave,
  };
}

function firstBlockedDependency(
  task: CoderTask,
  statusById: Map<string, TaskStatus>,
): { id: string; status: TaskStatus | 'missing' } | null {
  for (const dep of task.depends_on) {
    const status = statusById.get(dep);
    if (status === 'done' || status === 'skipped') continue;
    return { id: dep, status: status ?? 'missing' };
  }
  return null;
}

// ─── PR-G inline scope helpers ──────────────────────────────────

/**
 * Open an inline task scope on the parent runner. The agent's next
 * turn(s) work inside the scope until it calls `task_complete`. We
 * emit the standard lifecycle events so the dashboard's kanban
 * transitions identically to the singular `execute_task` flow.
 */
function openInlineScope(
  ctx: ToolContext,
  run: TaskRunContext,
  task: CoderTask,
): void {
  const startedAt = new Date().toISOString();
  ctx.updateTaskStatus?.(task.id, {
    status: 'running',
    mode_used: 'inline',
    started_at: startedAt,
  });
  ctx.runner?.beginTaskScope({ id: task.id, files: task.files });
  ctx.runner?.emit('task_started', { task_id: task.id, mode: 'inline', started_at: startedAt });
  emitTaskRunTaskStarted(ctx, run, task, startedAt, 'inline');
}

/**
 * Count how many tasks in the list are still pending AND resolve to
 * inline mode. Used to tell the agent "X more inline task(s) after
 * this one, call execute_tasks again to continue".
 *
 * Excludes the currently-opening task (it's about to run) and
 * already-terminal tasks. Counts both pending tasks in later waves
 * and inline siblings that didn't make it into the current group.
 */
function countRemainingInline(
  allTasks: ReadonlyArray<CoderTask>,
  statusById: Map<string, TaskStatus>,
  excludingId: string,
): number {
  let count = 0;
  for (const t of allTasks) {
    if (t.id === excludingId) continue;
    const status = statusById.get(t.id) ?? t.status;
    if (status === 'done' || status === 'skipped') continue;
    // We can't re-resolve task-run-mode here without the full args; use
    // the heuristic that any task with suggested_mode='inline' counts.
    // Will undercount when execution_mode='inline' forces every task
    // inline regardless of suggested_mode — acceptable for the "X more"
    // hint (worst case the agent sees a smaller number).
    if (t.suggested_mode === 'inline') count++;
  }
  return count;
}

function renderInlineScopeInstruction(task: CoderTask, remaining: number): string {
  const fileList = task.files.length > 0
    ? task.files.map((f) => `  - ${f}`).join('\n')
    : '  (none declared)';
  const nextLine = remaining > 0
    ? `\n\nAfter task_complete, call execute_tasks() again to advance — ${remaining} more inline task(s) pending in this run.`
    : '\n\nThis is the last inline task in the run; once task_complete fires the run ends.';
  return (
    `Inline task scope ACTIVE for '${task.id}': ${task.title}\n\n` +
    `${task.description}\n\n` +
    `Files in scope (mutating tools allowed only inside these):\n${fileList}\n\n` +
    `Proceed with the implementation using write_file/edit_file/run_command/etc. ` +
    `When done (or failed), call task_complete(task_id="${task.id}", summary, files_modified, errors?).` +
    nextLine
  );
}

/**
 * PR-D: synthesize a 'skipped' result for tasks whose inputs haven't
 * changed since the last successful run. Persists the fingerprint
 * (already computed by the wave loop) so the next dashboard view shows
 * "skipped (inputs_unchanged)" instead of a generic skip.
 */
function skipTaskAsStale(
  ctx: ToolContext,
  run: TaskRunContext,
  task: CoderTask,
  verdict: { reason?: string; fingerprint: string | null },
): TaskRunResult {
  const finishedAt = new Date().toISOString();
  const summary = `Skipped: inputs unchanged since last successful run (fingerprint ${verdict.fingerprint ?? '?'}).`;
  const result = { summary, files_modified: [] };
  ctx.updateTaskStatus?.(task.id, {
    status: 'skipped',
    finished_at: finishedAt,
    result,
  });
  ctx.runner?.emit('task_finished', {
    task_id: task.id,
    status: 'skipped',
    result,
    finished_at: finishedAt,
  });
  // Persist so the dashboard timeline reflects the skip; carry the
  // fingerprint forward so the next run can also detect staleness.
  run.persist.recordTaskFinished({
    runId: run.runId,
    task,
    waveIdx: run.wave,
    status: 'skipped',
    finishedAt,
    toolCallCount: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    summary,
    skipReason: verdict.reason ?? 'inputs_unchanged',
    ...(verdict.fingerprint ? { inputsFingerprint: verdict.fingerprint } : {}),
  });
  ctx.runner?.emit('task_run_task_finished', {
    run_id: run.runId,
    task_id: task.id,
    status: 'skipped',
    summary,
    usage: { input_tokens: 0, output_tokens: 0 },
    tool_call_count: 0,
    finished_at: finishedAt,
  });
  return {
    task,
    status: 'skipped',
    summary,
    usage: { input_tokens: 0, output_tokens: 0 },
    toolCallCount: 0,
    wave: run.wave,
  };
}

/**
 * PR-E: parse whatever the host sends back via provideUserInput into
 * a normalized {@link BudgetDecision}. Accepts plain strings ('continue+50%',
 * 'stop_after_current', 'cancel_pending') OR a JSON envelope like
 * `{ aborted: true }` (treated as cancel_pending) / `{ interrupted: true }`
 * (treated as stop_after_current).
 */
function parseBudgetAnswer(raw: string): BudgetDecision {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return 'cancel_pending';
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      if (parsed.aborted) return 'cancel_pending';
      if (parsed.interrupted) return 'stop_after_current';
      if (typeof parsed.answer === 'string') return parseBudgetAnswer(parsed.answer);
    }
  } catch { /* not JSON — fall through to literal match */ }
  if (trimmed === 'continue+50%') return 'continue+50%';
  if (trimmed === 'stop_after_current') return 'stop_after_current';
  if (trimmed === 'cancel_pending') return 'cancel_pending';
  // Unknown literal → conservative cancel.
  return 'cancel_pending';
}

/**
 * PR-E: synthesize a 'skipped' result for tasks dropped because the run
 * exceeded its token budget. Symmetric with `skipTaskAsStale` /
 * `skipTaskDueToDependency` — emits lifecycle + persists with the
 * supplied skip_reason so the dashboard distinguishes the cause.
 */
function skipTaskAsBudgetCapped(
  ctx: ToolContext,
  run: TaskRunContext,
  task: CoderTask,
  skipReason: string,
): TaskRunResult {
  const finishedAt = new Date().toISOString();
  const summary = `Skipped: run token budget exceeded (${skipReason}).`;
  const result = { summary, files_modified: [] };
  ctx.updateTaskStatus?.(task.id, {
    status: 'skipped',
    finished_at: finishedAt,
    result,
  });
  ctx.runner?.emit('task_finished', {
    task_id: task.id,
    status: 'skipped',
    result,
    finished_at: finishedAt,
  });
  run.persist.recordTaskFinished({
    runId: run.runId,
    task,
    waveIdx: run.wave,
    status: 'skipped',
    finishedAt,
    toolCallCount: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    summary,
    skipReason,
  });
  ctx.runner?.emit('task_run_task_finished', {
    run_id: run.runId,
    task_id: task.id,
    status: 'skipped',
    summary,
    usage: { input_tokens: 0, output_tokens: 0 },
    tool_call_count: 0,
    finished_at: finishedAt,
  });
  return {
    task, status: 'skipped', summary,
    usage: { input_tokens: 0, output_tokens: 0 },
    toolCallCount: 0, wave: run.wave,
  };
}

function skipTaskDueToDependency(
  ctx: ToolContext,
  run: TaskRunContext,
  task: CoderTask,
  blockedBy: { id: string; status: TaskStatus | 'missing' },
): TaskRunResult {
  const finishedAt = new Date().toISOString();
  const summary =
    `Skipped because dependency ${blockedBy.id} finished with status '${blockedBy.status}'.`;
  const result = { summary, files_modified: [], errors: summary };
  ctx.updateTaskStatus?.(task.id, {
    status: 'skipped',
    finished_at: finishedAt,
    result,
  });
  ctx.runner?.emit('task_finished', {
    task_id: task.id,
    status: 'skipped',
    result,
    finished_at: finishedAt,
  });
  emitTaskRunTaskFinished(ctx, run, task, {
    status: 'skipped',
    summary,
    usage: { input_tokens: 0, output_tokens: 0 },
    toolCallCount: 0,
    finishedAt,
    skipReason: `dependency_${blockedBy.status}`,
  });
  return {
    task,
    status: 'skipped',
    summary,
    usage: { input_tokens: 0, output_tokens: 0 },
    toolCallCount: 0,
    wave: run.wave,
  };
}

// ─── Helpers ────────────────────────────────────────────────────

function progressToTaskMeta(
  progress: {
    phase?: string;
    toolName?: string;
    turn?: number;
    elapsedMs?: number;
    stallMs?: number;
    limit?: TaskLimit;
  },
  fallbackLimit: TaskLimit,
): TaskRunProgressMeta {
  return {
    ...(progress.phase ? { phase: progress.phase } : {}),
    ...(progress.toolName ? { lastToolName: progress.toolName } : {}),
    ...(progress.turn != null ? { turn: progress.turn } : {}),
    limit: progress.limit ?? fallbackLimit,
    ...(progress.elapsedMs != null ? { elapsedMs: progress.elapsedMs } : {}),
    ...(progress.stallMs != null ? { stallMs: progress.stallMs } : {}),
  };
}

function emitTaskRunTaskStarted(
  ctx: ToolContext,
  run: TaskRunContext,
  task: CoderTask,
  startedAt: string,
  mode: TaskRunTaskMode,
  attempt = 0,
): void {
  // PR-B: write-through persistence. NOOP_PERSIST when no real store.
  // PR-C: attempt index threads through so retries don't overwrite earlier rows.
  run.persist.recordTaskStarted({
    runId: run.runId,
    task,
    waveIdx: run.wave,
    startedAt,
    attempt,
  });
  ctx.runner?.emit('task_run_task_started', {
    run_id: run.runId,
    task_id: task.id,
    title: task.title,
    kind: taskKind(task),
    wave: run.wave,
    mode,
    started_at: startedAt,
  });
  reportTaskRunProgress(ctx, run, task, 0);
}

function emitTaskRunTaskProgress(
  ctx: ToolContext,
  run: TaskRunContext,
  task: CoderTask,
  toolCallCount: number,
  note?: string,
  meta: TaskRunProgressMeta = {},
): void {
  ctx.runner?.emit('task_run_task_progress', {
    run_id: run.runId,
    task_id: task.id,
    tool_call_count: toolCallCount,
    ...(note ? { note } : {}),
    ...(meta.phase ? { phase: meta.phase } : {}),
    ...(meta.lastToolName ? { last_tool_name: meta.lastToolName } : {}),
    ...(meta.turn != null ? { turn: meta.turn } : {}),
    ...(meta.limit ? { limit: meta.limit } : {}),
    ...(meta.elapsedMs != null ? { elapsed_ms: meta.elapsedMs } : {}),
    ...(meta.stallMs != null ? { stall_ms: meta.stallMs } : {}),
  });
  reportTaskRunProgress(ctx, run, task, toolCallCount);
}

function emitTaskRunTaskFinished(
  ctx: ToolContext,
  run: TaskRunContext,
  task: CoderTask,
  result: {
    status: TaskStatus;
    summary: string;
    error?: string;
    usage: ChatUsage;
    toolCallCount: number;
    finishedAt: string;
    skipReason?: string;
    /** PR-C: which attempt row this is finalizing (default 0). */
    attempt?: number;
    /** PR-C: when true, skip the persist call — dispatchWithRetry already wrote per-attempt rows. */
    skipPersist?: boolean;
  },
): void {
  // PR-B: write-through persistence (upsert into coder_task_run_items).
  // PR-C: per-attempt persistence — multiple rows per (run, task) when retried.
  if (!result.skipPersist) {
    run.persist.recordTaskFinished({
      runId: run.runId,
      task,
      waveIdx: run.wave,
      status: result.status,
      finishedAt: result.finishedAt,
      toolCallCount: result.toolCallCount,
      usage: result.usage,
      summary: result.summary,
      attempt: result.attempt ?? 0,
      ...(result.error ? { error: result.error } : {}),
      ...(result.skipReason ? { skipReason: result.skipReason } : {}),
    });
  }
  ctx.runner?.emit('task_run_task_finished', {
    run_id: run.runId,
    task_id: task.id,
    status: result.status,
    summary: result.summary,
    ...(result.error ? { error: result.error } : {}),
    usage: result.usage,
    tool_call_count: result.toolCallCount,
    finished_at: result.finishedAt,
  });
  reportTaskRunProgress(ctx, run, task, result.toolCallCount);
}

function reportTaskRunProgress(
  ctx: ToolContext,
  run: TaskRunContext,
  task: CoderTask,
  toolCallCount: number,
): void {
  const title = task.title.length > 80 ? `${task.title.slice(0, 79)}...` : task.title;
  ctx.reportProgress?.(
    `Wave ${run.wave}/${run.totalWaves} · ${taskKind(task)}: ${title} · ${toolCallCount} tool(s)`,
  );
}

function formatTaskRunSummary(result: TaskRunResult): string {
  const tokens = (result.usage.input_tokens ?? 0) + (result.usage.output_tokens ?? 0);
  const parts = [
    `wave=${result.wave}`,
    `kind=${taskKind(result.task)}`,
    `status=${result.status}`,
    `tools=${result.toolCallCount}`,
    `tokens=${tokens}`,
  ];
  return `### ${result.task.id} — ${result.task.title} [${parts.join(', ')}]\n${result.summary || '(no summary)'}`;
}

function buildTaskBriefing(task: CoderTask): string {
  const lines: string[] = [];
  lines.push(`# Task ${task.id}: ${task.title}`);
  lines.push('');
  lines.push(task.description);
  if (task.files.length > 0) {
    lines.push('');
    lines.push(`Files in scope: ${task.files.join(', ')}`);
  }
  if (task.references.length > 0) {
    lines.push('');
    lines.push('## References');
    for (const r of task.references) {
      const loc = r.file ? ` (${r.file}${r.lines ? `:${r.lines}` : ''})` : '';
      lines.push(`- **${r.type}**${loc}: ${r.value}${r.note ? ` — ${r.note}` : ''}`);
    }
  }
  return lines.join('\n');
}

// Helper for callers that want to introspect/test wave planning without
// running anything.
export function planExecution(state: TasksState): { waves: TaskGroup[][]; totalTasks: number } {
  const waves = buildWaves(state.tasks);
  return {
    waves: waves.map((w) => groupByParallel(w)),
    totalTasks: state.tasks.length,
  };
}
