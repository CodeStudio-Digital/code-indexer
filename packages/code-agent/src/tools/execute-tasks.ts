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
import type { CoderTask, TasksState } from '@mcp/code-agent/sessions/types.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import {
  runSubagent,
  runParallelAgents,
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

      const mode = args.mode === 'inline-all' ? 'inline-all' : 'auto';
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

      const summaries: string[] = [];
      const totalUsage: ChatUsage = { input_tokens: 0, output_tokens: 0 };

      for (let w = 0; w < waves.length; w++) {
        const wave = waves[w];
        const groups = groupByParallel(wave);
        console.log(
          `[coder/tasks] wave ${w + 1}/${waves.length} — ${wave.length} task(s) in ${groups.length} group(s)`,
        );

        for (const group of groups) {
          const tasksRun = mode === 'inline-all' || group.tasks.length === 1
            ? await runGroupSequential(deps, group.tasks, ctx)
            : await runGroupParallel(deps, group.tasks, ctx);

          for (const r of tasksRun.results) {
            summaries.push(r);
          }
          accumulateUsage(totalUsage, tasksRun.usage);
        }
      }

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
): Promise<{ results: string[]; usage: ChatUsage }> {
  const results: string[] = [];
  const usage: ChatUsage = { input_tokens: 0, output_tokens: 0 };
  for (const t of tasks) {
    const r = await runOneTask(deps, t, ctx);
    results.push(r.summary);
    accumulateUsage(usage, r.usage);
  }
  return { results, usage };
}

async function runGroupParallel(
  deps: SubagentDeps,
  tasks: CoderTask[],
  ctx: ToolContext,
): Promise<{ results: string[]; usage: ChatUsage }> {
  const startedAt = new Date().toISOString();
  for (const t of tasks) {
    ctx.updateTaskStatus?.(t.id, { status: 'running', started_at: startedAt, mode_used: 'subagent' });
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
    };
  });

  const groupId = `tasks-wave-${Date.now().toString(36)}`;
  ctx.runner?.emit('agents_group_start', {
    groupId,
    agents: tasks.map((t, i) => ({ index: i, label: `${t.kind ?? 'implement'}:${t.id}` })),
  });

  const { results, totalUsage } = await runParallelAgents(
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
    (progress) => ctx.runner?.emit('agent_progress', { groupId, ...progress }),
  );

  ctx.runner?.emit('agents_group_end', {
    groupId,
    totalUsage,
    agentCount: results.length,
    successCount: results.filter((r) => r.reason === 'completed').length,
  });

  const finishedAt = new Date().toISOString();
  const summaries: string[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const r = results[i];
    const status = r.reason === 'completed' ? 'done' : 'failed';
    ctx.updateTaskStatus?.(t.id, {
      status,
      finished_at: finishedAt,
      result: { summary: r.finalText, files_modified: [] },
    });
    summaries.push(`### ${t.id} — ${t.title} [${t.kind ?? 'implement'}, ${status}]\n${r.finalText || '(no summary)'}`);
  }
  return { results: summaries, usage: totalUsage };
}

async function runOneTask(
  deps: SubagentDeps,
  task: CoderTask,
  ctx: ToolContext,
): Promise<{ summary: string; usage: ChatUsage }> {
  const startedAt = new Date().toISOString();
  ctx.updateTaskStatus?.(task.id, { status: 'running', started_at: startedAt, mode_used: 'subagent' });

  const art = resolveKindArtifacts(task);
  const initialMessages: AgentMessage[] = [
    { role: 'user', content: [{ type: 'text', text: buildTaskBriefing(task) }] },
  ];

  const result = await runSubagent(
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
    },
  );

  const finishedAt = new Date().toISOString();
  const status = result.reason === 'completed' ? 'done' : 'failed';
  ctx.updateTaskStatus?.(task.id, {
    status,
    finished_at: finishedAt,
    result: { summary: result.finalText, files_modified: [] },
  });

  return {
    summary: `### ${task.id} — ${task.title} [${task.kind ?? 'implement'}, ${status}]\n${result.finalText || '(no summary)'}`,
    usage: result.usage,
  };
}

// ─── Helpers ────────────────────────────────────────────────────

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

function accumulateUsage(acc: ChatUsage, add: ChatUsage): void {
  acc.input_tokens += add.input_tokens ?? 0;
  acc.output_tokens += add.output_tokens ?? 0;
  acc.cache_creation_input_tokens =
    (acc.cache_creation_input_tokens ?? 0) + (add.cache_creation_input_tokens ?? 0);
  acc.cache_read_input_tokens =
    (acc.cache_read_input_tokens ?? 0) + (add.cache_read_input_tokens ?? 0);
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
