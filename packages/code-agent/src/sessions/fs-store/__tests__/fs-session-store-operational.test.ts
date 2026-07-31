import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsSessionStore } from '../fs-session-store.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let temporaryRoot: string;
let dataDir: string;
let projectRoot: string;
let store: FsSessionStore;

function openStore(): FsSessionStore {
  return FsSessionStore.fromRoots({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) =>
        projectId === 7 ? projectRoot : null,
      listProjectRoots: () => [
        { project_id: 7, root_path: projectRoot },
      ],
    },
  });
}

async function restart(): Promise<void> {
  await store.close();
  store = openStore();
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'mcp-fs-operational-'));
  dataDir = join(temporaryRoot, 'data');
  projectRoot = join(temporaryRoot, 'project');
  await Promise.all([mkdir(dataDir), mkdir(projectRoot)]);
  store = openStore();
});

afterEach(async () => {
  await store.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('FsSessionStore operational state', () => {
  it('keeps read projections lease-free while another store owns the writer', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Lease-free reader',
      provider: 'test',
      model: 'test',
    });
    await store.setSessionToolDisabled(session.id, 'read_file', true);

    const reader = openStore();
    try {
      expect([...(await reader.getSessionDisabledTools(session.id))]).toEqual([
        'read_file',
      ]);
    } finally {
      await reader.close();
    }
  });

  it('persists runtime configuration, groups, ACL roots and events across restart', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Operational state',
      provider: 'test',
      model: 'test',
      agent: 'build',
    });

    await Promise.all([
      store.setSessionTemperature(session.id, 0.25),
      store.setSessionReasoningEffort(session.id, 'high'),
      store.setSessionExecutionMode(session.id, 'ultra'),
      store.setSessionThinkingEnabled(session.id, true),
      store.setSessionRunLimits(session.id, 80, 4),
      store.setSessionPlanDepth(session.id, 'deep'),
      store.setSessionResponseLanguage(session.id, 'pt-BR'),
      store.setSessionOutputStyle(session.id, 'compact'),
      store.setSessionPreflightSeed(session.id, '{"phase":"build"}'),
      store.setSessionUnrestrictedToolOutput(session.id, true),
      store.setSessionToolOutputCapLevel(session.id, 'max'),
      store.setSessionFallback(session.id, 'openai', 'gpt-fallback'),
      store.setSessionWorktree(session.id, join(projectRoot, '.worktrees', 'a')),
      store.setSessionBaseCommit(session.id, 'abc123'),
      store.setMemoryDistilledBoundary(session.id, 12),
      store.setSessionConfigLock(session.id, {
        provider: 'test',
        model: 'locked',
      }),
      store.setSessionToolPermissionMode(session.id, 'ask'),
      store.addToolPermissionGrant(session.id, 'read_file'),
      store.setSessionToolProfile(session.id, 'full'),
      store.mergeSessionToolsetState(session.id, {
        addExtraTiers: ['company'],
        addPins: ['read_file'],
        visibleCap: 33,
      }),
      store.bulkSetSessionToolsDisabled(
        session.id,
        ['delete_file', 'run_command'],
        true,
      ),
      store.setSessionActiveSkills(session.id, ['skill-b', 'skill-a', 'skill-a']),
    ]);

    const group = await store.createGroup(7, {
      name: 'Runtime',
      color: '#112233',
      sort_order: 2,
    });
    expect(group.id).toMatch(UUID_PATTERN);
    await store.setSessionGroup(session.id, group.id);

    const rootPath = join(projectRoot, 'src', '..', 'src');
    const firstRoot = await store.upsertSessionFilesystemRoot(
      session.id,
      rootPath,
      'read',
      'root:create',
    );
    const replayedRoot = await store.upsertSessionFilesystemRoot(
      session.id,
      rootPath,
      'read',
      'root:create',
    );
    expect(firstRoot.id).toMatch(UUID_PATTERN);
    expect(replayedRoot).toEqual(firstRoot);
    const changedRoot = await store.upsertSessionFilesystemRoot(
      session.id,
      rootPath,
      'write',
      'root:update',
    );
    expect(
      await store.upsertSessionFilesystemRoot(
        session.id,
        rootPath,
        'read',
        'root:create',
      ),
    ).toEqual(changedRoot);
    await expect(
      store.upsertSessionFilesystemRoot(
        session.id,
        rootPath,
        'write',
        'root:create',
      ),
    ).rejects.toThrow(/different entity update input/);

    const firstEvent = await store.appendSessionEvent(
      session.id,
      'policy_decision',
      { action: 'allow' },
      'event:policy:1',
    );
    const replayedEvent = await store.appendSessionEvent(
      session.id,
      'policy_decision',
      { action: 'allow' },
      'event:policy:1',
    );
    expect(firstEvent.id).toMatch(UUID_PATTERN);
    expect(replayedEvent).toEqual(firstEvent);

    const transition = await store.stageManualAgentTransition(
      session.id,
      'review',
    );
    expect(transition?.id).toMatch(UUID_PATTERN);

    await restart();

    expect(await store.getRuntimeSessionState(session.id)).toMatchObject({
      temperature_override: 0.25,
      reasoning_effort_override: 'high',
      execution_mode_override: 'ultra',
      thinking_enabled: true,
      max_turns: 80,
      max_auto_continues: 4,
      plan_depth_override: 'deep',
      response_language_override: 'pt-BR',
      output_style_override: 'compact',
      preflight_seed_json: '{"phase":"build"}',
      unrestricted_tool_output: true,
      tool_output_cap_level: 'max',
      fallback_provider: 'openai',
      fallback_model: 'gpt-fallback',
      base_commit_sha: 'abc123',
      memory_distilled_seq: 12,
      group_id: group.id,
    });
    expect(await store.getSessionConfigLock(session.id)).toEqual({
      provider: 'test',
      model: 'locked',
    });
    expect([...(await store.getSessionDisabledTools(session.id))]).toEqual([
      'delete_file',
      'run_command',
    ]);
    expect((await store.getSession(session.id))?.state.tools).toMatchObject({
      profile: 'full',
      active_skills: ['skill-a', 'skill-b'],
    });
    expect((await store.listGroups(7))[0]).toMatchObject({
      id: group.id,
      name: 'Runtime',
    });
    expect((await store.listSessions(7, { groupId: group.id }))).toHaveLength(1);
    expect(await store.listSessionFilesystemRoots(session.id)).toEqual([
      expect.objectContaining({
        id: firstRoot.id,
        root_path: firstRoot.root_path,
        access: 'write',
      }),
    ]);
    expect((await store.consumePendingAgentTransition(session.id))?.id).toBe(
      transition?.id,
    );
    expect(await store.getPendingAgentTransition(session.id)).toBeNull();
  });

  it('journals goals atomically and persists plans, memory, tasks and tool stats', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Operational entities',
      provider: 'test',
      model: 'test',
    });
    const createdAt = new Date().toISOString();
    const goalToolUseId = 'goal-create-1';
    const goalTurn = {
      session_id: session.id,
      operation_id: 'assistant:goal-create-1',
      message: {
        role: 'assistant' as const,
        content: [
          {
            type: 'tool_use' as const,
            id: goalToolUseId,
            name: 'create_goal',
            input: { text: 'Move runtime state to files' },
          },
        ],
      },
      usage: null,
      tool_calls: [
        {
          tool_use_id: goalToolUseId,
          tool_name: 'create_goal',
          args: { text: 'Move runtime state to files' },
          result_text: 'created',
          is_error: false,
          duration_ms: 3,
        },
      ],
      goal_mutations: [
        {
          tool_use_id: goalToolUseId,
          tool_name: 'create_goal',
          expected: null,
          next: {
            text: 'Move runtime state to files',
            status: 'in_progress',
            budget_tokens: 10_000,
            completion_note: null,
            created_at: createdAt,
            updated_at: createdAt,
          },
        },
      ],
    };
    expect(await store.persistAssistantTurn(goalTurn)).toBe(1);
    expect(await store.persistAssistantTurn(goalTurn)).toBe(1);

    const initialGoal = await store.getSessionGoal(session.id);
    expect(initialGoal).toMatchObject({
      text: 'Move runtime state to files',
      status: 'in_progress',
      revision: 1,
      mutation_seq: 1,
    });
    expect(initialGoal?.id).toMatch(UUID_PATTERN);

    const updatedAt = new Date(Date.now() + 1_000).toISOString();
    const completedGoal = await store.upsertSessionGoal(session.id, {
      text: initialGoal!.text,
      status: 'complete',
      budgetTokens: initialGoal!.budget_tokens,
      completionNote: 'done',
      createdAt: initialGoal!.created_at,
      updatedAt,
      expected_revision: 1,
      operation_id: 'goal:complete',
    });
    const replayedGoal = await store.upsertSessionGoal(session.id, {
      text: initialGoal!.text,
      status: 'complete',
      budgetTokens: initialGoal!.budget_tokens,
      completionNote: 'done',
      createdAt: initialGoal!.created_at,
      updatedAt,
      expected_revision: 1,
      operation_id: 'goal:complete',
    });
    expect(replayedGoal).toEqual(completedGoal);

    const goalNoopToolUseId = 'goal-complete-noop-1';
    expect(await store.persistAssistantTurn({
      session_id: session.id,
      operation_id: 'assistant:goal-complete-noop-1',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: goalNoopToolUseId,
          name: 'update_goal',
          input: { status: 'complete' },
        }],
      },
      usage: null,
      tool_calls: [{
        tool_use_id: goalNoopToolUseId,
        tool_name: 'update_goal',
        args: { status: 'complete' },
        result_text: 'Goal is already complete; no state change was needed.',
        is_error: false,
        duration_ms: 1,
      }],
      goal_noop_tool_use_ids: [goalNoopToolUseId],
    })).toBe(3);
    expect(await store.getSessionGoal(session.id)).toEqual(completedGoal);

    await expect(
      store.upsertSessionGoal(session.id, {
        text: 'conflict',
        status: 'in_progress',
        createdAt,
        updatedAt,
        expected_revision: 1,
      }),
    ).rejects.toThrow(/expected revision 1, got 2/);
    expect(
      await store.clearSessionGoal(session.id, {
        expected_revision: 2,
        operation_id: 'goal:clear',
      }),
    ).toBe(true);
    expect(await store.getSessionGoal(session.id)).toBeNull();
    const recreatedAt = new Date(Date.now() + 2_000).toISOString();
    const recreatedGoal = await store.upsertSessionGoal(session.id, {
      text: 'Verify the cutover',
      status: 'in_progress',
      budgetTokens: null,
      createdAt: recreatedAt,
      updatedAt: recreatedAt,
      expected_revision: 0,
      operation_id: 'goal:recreate',
    });
    expect(recreatedGoal).toMatchObject({
      revision: 1,
      mutation_seq: 4,
    });
    expect(
      await store.clearSessionGoal(session.id, {
        expected_revision: 2,
        operation_id: 'goal:clear',
      }),
    ).toBe(true);
    expect(
      await store.upsertSessionGoal(session.id, {
        text: initialGoal!.text,
        status: 'complete',
        budgetTokens: initialGoal!.budget_tokens,
        completionNote: 'done',
        createdAt: initialGoal!.created_at,
        updatedAt,
        expected_revision: 1,
        operation_id: 'goal:complete',
      }),
    ).toEqual(completedGoal);

    const plan = await store.recordPlan({
      session_id: session.id,
      tool_use_id: 'plan-1',
      plan_text: 'Persist everything under the bundle',
      message_seq: 1,
      operation_id: 'plan:create:1',
    });
    const replayedPlan = await store.recordPlan({
      session_id: session.id,
      tool_use_id: 'plan-1',
      plan_text: 'Persist everything under the bundle',
      message_seq: 1,
      operation_id: 'plan:create:1',
    });
    expect(plan.id).toMatch(UUID_PATTERN);
    expect(replayedPlan).toEqual(plan);
    expect(
      await store.resolvePlan(
        session.id,
        'plan-1',
        'approved',
        'go',
        'plan:resolve:1',
      ),
    ).toBe(true);
    expect(
      await store.recordPlan({
        session_id: session.id,
        tool_use_id: 'plan-1',
        plan_text: 'Persist everything under the bundle',
        message_seq: 1,
        operation_id: 'plan:create:1',
      }),
    ).toMatchObject({ id: plan.id, status: 'approved' });
    await expect(
      store.recordPlan({
        session_id: session.id,
        tool_use_id: 'plan-1',
        plan_text: 'Different plan',
        message_seq: 1,
        operation_id: 'plan:create:1',
      }),
    ).rejects.toThrow(/different entity update input/);

    expect(
      await store.recordSessionInput({
        session_id: session.id,
        kind: 'system_prompt',
        source_label: 'runtime',
        content: 'filesystem only',
        operation_id: 'input:1',
      }),
    ).not.toBeNull();
    expect(
      await store.recordSessionInput({
        session_id: session.id,
        kind: 'system_prompt',
        source_label: 'runtime',
        content: 'filesystem only',
        operation_id: 'input:2',
      }),
    ).toBeNull();

    const memory = await store.rememberMemory(session.id, {
      title: 'Architecture',
      body: 'SQLite is not session storage.',
      pinned: true,
      operation_id: 'memory:1',
    });
    const investigation = await store.recordInvestigation({
      session_id: session.id,
      topic: 'writer contention',
      summary: 'Per-session leases eliminate cross-session contention.',
      tokens: 42,
      operation_id: 'investigation:1',
    });
    expect(memory.id).toMatch(UUID_PATTERN);
    expect(investigation.id).toMatch(UUID_PATTERN);
    await store.setSessionMemoryPinned(session.id, memory.id, false);
    expect(
      await store.rememberMemory(session.id, {
        title: 'Architecture',
        body: 'SQLite is not session storage.',
        pinned: true,
        operation_id: 'memory:1',
      }),
    ).toMatchObject({ id: memory.id, pinned: false });

    const task = {
      id: randomUUID(),
      title: 'Finish migration',
      description: 'Exercise the file-backed task repository.',
      files: ['src/a.ts'],
      references: [],
      depends_on: [],
      suggested_mode: 'inline' as const,
      estimated_complexity: 'small' as const,
      kind: 'implement' as const,
      status: 'running' as const,
    };
    const board = await store.recordTasks({
      session_id: session.id,
      tool_use_id: 'tasks-1',
      state: {
        gate: 'approve',
        summary: 'Finish the migration',
        tasks: [task],
        execution_mode: 'inline',
        approved: true,
        current_task_id: task.id,
      },
      operation_id: 'tasks:record:1',
    });
    expect(board.id).toMatch(UUID_PATTERN);

    await expect(
      store.createTaskRun({
        run_id: 'not-a-task-run-uuid',
        session_id: session.id,
        mode: 'auto',
        started_at: createdAt,
      }),
    ).rejects.toThrow(/task run_id must be a UUID/);
    await expect(
      store.getTaskRun(session.id, 'not-a-task-run-uuid'),
    ).rejects.toThrow(/task run_id must be a UUID/);
    await expect(
      store.listTaskRunItems(session.id, 'not-a-task-run-uuid'),
    ).rejects.toThrow(/task run_id must be a UUID/);

    const runId = randomUUID();
    await store.createTaskRun({
      run_id: runId,
      session_id: session.id,
      mode: 'auto',
      started_at: createdAt,
      operation_id: 'task-run:create:1',
    });
    await store.upsertTaskRunItem({
      session_id: session.id,
      run_id: runId,
      task_id: task.id,
      attempt: 0,
      wave_idx: 0,
      parallel_group: null,
      kind: 'implement',
      title: task.title,
      started_at: createdAt,
      finished_at: null,
      status: 'running',
      tool_call_count: 1,
      input_tokens: 10,
      output_tokens: 5,
      inputs_fingerprint: null,
      skip_reason: null,
      error: null,
      summary: null,
      operation_id: 'task-item:create:1',
    });

    await store.persistAssistantTurn({
      session_id: session.id,
      operation_id: 'assistant:edit:1',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'edit-1',
            name: 'edit_file',
            input: { path: 'src/a.ts' },
          },
        ],
      },
      usage: null,
      tool_calls: [
        {
          tool_use_id: 'edit-1',
          tool_name: 'edit_file',
          args: { path: 'src/a.ts' },
          raw_result: 'x'.repeat(100),
          result_text: 'x'.repeat(25),
          output_chars: 100,
          output_chars_shaped: 25,
          reduction_kind: 'semantic',
          reduction_technique: 'summary',
          is_error: false,
          duration_ms: 7,
        },
      ],
    });

    await restart();

    expect(await store.getSessionGoal(session.id)).toEqual(recreatedGoal);
    expect((await store.listPlans(session.id))[0]).toMatchObject({
      id: plan.id,
      status: 'approved',
    });
    expect(await store.listSessionInputs(session.id)).toHaveLength(1);
    expect((await store.listSessionMemory(session.id))[0]).toMatchObject({
      id: memory.id,
      pinned: false,
    });
    expect(await store.listInvestigationsForSemanticIndex(7)).toEqual([
      expect.objectContaining({ id: investigation.id, tokens: 42 }),
    ]);
    expect(await store.investigationProjectId(session.id)).toBe(7);
    expect(await store.recoverStaleTasks(session.id)).toBe(1);
    expect(
      await store.recordTasks({
        session_id: session.id,
        tool_use_id: 'tasks-1',
        state: {
          gate: 'approve',
          summary: 'Finish the migration',
          tasks: [task],
          execution_mode: 'inline',
          approved: true,
          current_task_id: task.id,
        },
        operation_id: 'tasks:record:1',
      }),
    ).toMatchObject({
      id: board.id,
      state: {
        tasks: [expect.objectContaining({ status: 'interrupted' })],
      },
    });
    expect(await store.recoverRunningTaskRuns(session.id)).toBe(1);
    expect(await store.recoverRunningTaskRuns(session.id)).toBe(0);
    await store.createTaskRun({
      run_id: runId,
      session_id: session.id,
      mode: 'auto',
      started_at: createdAt,
      operation_id: 'task-run:create:1',
    });
    await expect(
      store.createTaskRun({
        run_id: runId,
        session_id: session.id,
        mode: 'inline-all',
        started_at: createdAt,
        operation_id: 'task-run:create:1',
      }),
    ).rejects.toThrow(/different entity input/);
    expect((await store.getTaskRun(session.id, runId))?.status).toBe('aborted');
    expect((await store.listTaskRunItems(session.id, runId))[0]).toMatchObject({
      task_id: task.id,
      status: 'interrupted',
    });

    const stats = await store.getToolCallStats(session.id);
    expect(stats.totalCalls).toBe(3);
    expect(stats.byName).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'create_goal', count: 1 }),
        expect.objectContaining({ name: 'update_goal', count: 1 }),
        expect.objectContaining({ name: 'edit_file', count: 1 }),
      ]),
    );
    expect(stats.savings).toMatchObject({
      totalRawChars: 160,
      totalShapedChars: 85,
      totalSavedChars: 75,
      semanticSavedChars: 75,
    });
    expect(stats.recent[0].id).toMatch(UUID_PATTERN);

    const aggregate = await store.getDriveAggregate(session.id);
    expect(aggregate.fileMap.changed).toContain('src/a.ts');
    expect(aggregate.tasks?.tasks[0].status).toBe('interrupted');
  });
});
