import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsSessionStore } from '../fs-session-store.js';
import { queryConversationProjection, type FsConversationProjection } from '../conversation-projection-query.js';

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
  it('persists native task admission across restart and refuses to replace a child identity', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Native task ownership', provider: 'test', model: 'test' });
    const runId = randomUUID(), reference = `native-child-journal:${randomUUID()}:${randomUUID()}:${randomUUID()}:${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const identity = { runtime_generation: 'rust_v1' as const, task_plan_sha256: 'a'.repeat(64), owner_tool_use_id: `native-tool:${'b'.repeat(64)}` };
    await store.createTaskRun({ session_id: session.id, run_id: runId, mode: 'auto', started_at: startedAt, ...identity });
    const item = { session_id: session.id, run_id: runId, task_id: 'write', attempt: 0, wave_idx: 1,
      parallel_group: null, kind: 'implement' as const, title: 'Write', started_at: startedAt, finished_at: null,
      status: 'running' as const, tool_call_count: 0, input_tokens: 0, output_tokens: 0,
      inputs_fingerprint: null, skip_reason: null, error: null, summary: null };
    await store.upsertTaskRunItem(item);
    await store.upsertTaskRunItem({ ...item, native_transcript_ref: reference });
    await restart();
    expect(await store.getTaskRun(session.id, runId)).toMatchObject(identity);
    expect((await store.listTaskRunItems(session.id, runId))[0]).toMatchObject({ status: 'running', native_transcript_ref: reference });
    await store.upsertTaskRunItem({ ...item, status: 'done', summary: 'confirmed', finished_at: new Date().toISOString() });
    await expect(store.upsertTaskRunItem({ ...item, native_transcript_ref: reference.replace(/:[^:]+$/, ':' + randomUUID()) }))
      .rejects.toThrow('already owns a different native child');
    await restart();
    expect((await store.listTaskRunItems(session.id, runId))[0]).toMatchObject({ status: 'done', native_transcript_ref: reference });
  });

  it('rejects native children attached to a legacy task run and incomplete native admission', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Generation', provider: 'test', model: 'test' });
    const runId = randomUUID(), startedAt = new Date().toISOString();
    await expect(store.createTaskRun({ session_id: session.id, run_id: runId, mode: 'auto', started_at: startedAt, runtime_generation: 'rust_v1' }))
      .rejects.toThrow('plan digest');
    await store.createTaskRun({ session_id: session.id, run_id: runId, mode: 'auto', started_at: startedAt });
    await expect(store.upsertTaskRunItem({ session_id: session.id, run_id: runId, task_id: 'write', attempt: 0, wave_idx: 1,
      parallel_group: null, kind: 'implement', title: 'Write', started_at: startedAt, finished_at: null,
      status: 'running', tool_call_count: 0, input_tokens: 0, output_tokens: 0, inputs_fingerprint: null,
      skip_reason: null, error: null, summary: null,
      native_transcript_ref: `native-child-journal:${randomUUID()}:${randomUUID()}:${randomUUID()}:${randomUUID()}` }))
      .rejects.toThrow('legacy or absent run');
    expect(await store.listTaskRunItems(session.id, runId)).toEqual([]);
  });

  it('uses the native task projection and never resurrects a cleared legacy board', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Tasks', provider: 'test', model: 'test' });
    const legacy = { gate: 'track' as const, summary: 'Legacy board', tasks: [], approved: true, execution_mode: null, current_task_id: null };
    await store.recordTasks({ session_id: session.id, tool_use_id: 'legacy-tasks', state: legacy });
    let nativeTasks: typeof legacy | null | undefined;
    store.setConversationProjectionLoader(async () => ({ messages: [], rows: [], nativeTasks }));
    expect(await store.getTasksState(session.id)).toEqual(legacy);
    nativeTasks = { ...legacy, summary: 'Native board' };
    expect(await store.getTasksState(session.id)).toEqual(nativeTasks);
    nativeTasks = null;
    expect(await store.getTasksState(session.id)).toBeNull();
    await restart();
    store.setConversationProjectionLoader(async () => ({ messages: [], rows: [], nativeTasks: null }));
    expect(await store.getTasksState(session.id)).toBeNull();
  });
  it('serializes note upserts by title and preserves idempotency after reopening', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Notes', provider: 'test', model: 'test' });
    const writes = await Promise.all(Array.from({ length: 8 }, (_, index) => store.rememberMemory(session.id, {
      title: 'one key', body: `value ${index}`, operation_id: `note:${index}`,
    })));
    expect(new Set(writes.map(row => row.id)).size).toBe(1);
    await restart();
    expect(await store.listSessionMemory(session.id)).toHaveLength(1);
    expect(await store.rememberMemory(session.id, { title: 'one key', body: 'value 7', operation_id: 'note:7' }))
      .toMatchObject({ revision: 8, body: 'value 7' });
    await expect(store.rememberMemory(session.id, { title: 'one key', body: 'changed', operation_id: 'note:7' }))
      .rejects.toThrow('different entity update input');
  });
  it('checks the writer at actual note publication and leaves no note after late revocation', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Guard', provider: 'test', model: 'test' });
    let checks = 0;
    await expect(store.rememberMemory(session.id, { title: 'guarded', body: 'must not appear' }, () => {
      if (++checks > 1) throw new Error('writer revoked');
    })).rejects.toThrow('writer revoked');
    expect(checks).toBe(2);
    expect(await store.listSessionMemory(session.id)).toEqual([]);
  });
  it('paginates notes in the same order as the full view and surfaces corruption or cancellation', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Pages', provider: 'test', model: 'test' });
    for (let i = 0; i < 8; i++) await store.rememberMemory(session.id, { title: `note${i}`, body: 'body', pinned: i % 3 === 0, kind: 'procedure' });
    const all = await store.listSessionMemory(session.id);
    expect(await store.listSessionMemory(session.id, { kind: 'procedure', limit: 3, offset: 2 })).toEqual(all.slice(2, 5));
    await expect(store.listSessionMemory(session.id, { limit: 1, signal: AbortSignal.abort() })).rejects.toThrow();
    const location = (await store.getSessionLocation(session.id))!;
    await writeFile(join(location.bundle_path, 'memory', `${all[0].id}.json`), 'corrupt');
    await expect(store.listSessionMemory(session.id, { limit: 1 })).rejects.toThrow();
  });
  it('hydrates ranked investigation IDs without opening unrelated corrupt records', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Recall', provider: 'test', model: 'test' });
    const first = await store.recordInvestigation({ session_id: session.id, topic: 'first', summary: 'one' });
    const second = await store.recordInvestigation({ session_id: session.id, topic: 'second', summary: 'two' });
    const location = (await store.getSessionLocation(session.id))!;
    await writeFile(join(location.bundle_path, 'memory', `${randomUUID()}.json`), 'not JSON');
    expect((await store.recallInvestigationsByIds(session.id, [second.id, first.id])).map(row => row.id)).toEqual([second.id, first.id]);
    await expect(store.recallInvestigations(session.id, 'first', 1)).rejects.toThrow();
    await expect(store.recallInvestigationsByIds(session.id, [first.id], 1, AbortSignal.abort())).rejects.toThrow();
  });
  it('serializes note upserts by title and preserves idempotency after reopening', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Notes', provider: 'test', model: 'test' });
    const writes = await Promise.all(Array.from({ length: 8 }, (_, index) => store.rememberMemory(session.id, {
      title: 'one key', body: `value ${index}`, operation_id: `note:${index}`,
    })));
    expect(new Set(writes.map(row => row.id)).size).toBe(1);
    await restart();
    expect(await store.listSessionMemory(session.id)).toHaveLength(1);
    expect(await store.rememberMemory(session.id, { title: 'one key', body: 'value 7', operation_id: 'note:7' }))
      .toMatchObject({ revision: 8, body: 'value 7' });
    await expect(store.rememberMemory(session.id, { title: 'one key', body: 'changed', operation_id: 'note:7' }))
      .rejects.toThrow('different entity update input');
  });
  it('checks the writer at actual note publication and leaves no note after late revocation', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Guard', provider: 'test', model: 'test' });
    let checks = 0;
    await expect(store.rememberMemory(session.id, { title: 'guarded', body: 'must not appear' }, () => {
      if (++checks > 1) throw new Error('writer revoked');
    })).rejects.toThrow('writer revoked');
    expect(checks).toBe(2);
    expect(await store.listSessionMemory(session.id)).toEqual([]);
  });
  it('paginates notes in the same order as the full view and surfaces corruption or cancellation', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Pages', provider: 'test', model: 'test' });
    for (let i = 0; i < 8; i++) await store.rememberMemory(session.id, { title: `note${i}`, body: 'body', pinned: i % 3 === 0, kind: 'procedure' });
    const all = await store.listSessionMemory(session.id);
    expect(await store.listSessionMemory(session.id, { kind: 'procedure', limit: 3, offset: 2 })).toEqual(all.slice(2, 5));
    await expect(store.listSessionMemory(session.id, { limit: 1, signal: AbortSignal.abort() })).rejects.toThrow();
    const location = (await store.getSessionLocation(session.id))!;
    await writeFile(join(location.bundle_path, 'memory', `${all[0].id}.json`), 'corrupt');
    await expect(store.listSessionMemory(session.id, { limit: 1 })).rejects.toThrow();
  });
  it('hydrates ranked investigation IDs without opening unrelated corrupt records', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Recall', provider: 'test', model: 'test' });
    const first = await store.recordInvestigation({ session_id: session.id, topic: 'first', summary: 'one' });
    const second = await store.recordInvestigation({ session_id: session.id, topic: 'second', summary: 'two' });
    const location = (await store.getSessionLocation(session.id))!;
    await writeFile(join(location.bundle_path, 'memory', `${randomUUID()}.json`), 'not JSON');
    expect((await store.recallInvestigationsByIds(session.id, [second.id, first.id])).map(row => row.id)).toEqual([second.id, first.id]);
    await expect(store.recallInvestigations(session.id, 'first', 1)).rejects.toThrow();
    await expect(store.recallInvestigationsByIds(session.id, [first.id], 1, AbortSignal.abort())).rejects.toThrow();
  });
  it('reads a native goal through a bounded projection without replaying the legacy journal', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Native goal', provider: 'test', model: 'test' });
    const nativeGoal = { id: randomUUID(), text: 'Native state', status: 'complete' as const,
      budget_tokens: null, completion_note: 'verified', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), revision: 2, mutation_seq: 2 };
    store.setConversationProjectionLoader(async (id, query) => {
      expect(id).toBe(session.id); expect(query).toEqual({ kind: 'stats', boundary: 0 });
      return { messages: [], rows: [], nativeGoal };
    });
    const read = vi.spyOn(store.repository, 'readConversationSync');
    expect(await store.getSessionGoal(session.id)).toEqual(nativeGoal);
    expect(read).not.toHaveBeenCalled();
    await expect(store.clearSessionGoal(session.id)).rejects.toThrow('native session writer');
    expect(await store.getSessionGoal(session.id)).toEqual(nativeGoal);
  });
  it('requests bounded native windows and statistics instead of transferring the transcript', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Bounded native reader', provider: 'test', model: 'test' });
    const projection: FsConversationProjection = { messages: [], rows: [] };
    for (let index = 0; index < 20_000; index++) {
      const role = index % 2 === 0 ? 'user' : 'assistant';
      projection.messages.push({ role, content: [{ type: 'text', text: `message ${index + 1}` }] });
      projection.rows.push({ seq: index + 1, role, is_meta: 0 } as FsConversationProjection['rows'][number]);
    }
    const kinds: string[] = [];
    store.setConversationProjectionLoader(async (id, query) => {
      expect(id).toBe(session.id);
      if (!query) throw new Error('Interactive query attempted full history transport');
      kinds.push(query.kind);
      const selected = queryConversationProjection(projection, query);
      expect(Buffer.byteLength(JSON.stringify(selected))).toBeLessThan(2_000);
      return structuredClone(selected);
    });
    expect(await store.getMessageCount(session.id)).toBe(20_000);
    expect(await store.getArchivedMessageCount(session.id)).toBe(0);
    expect(await store.maxMessageSeq(session.id)).toBe(20_000);
    expect((await store.loadSessionMessagesTail(session.id, 2))?.message_rows.map(row => row.seq)).toEqual([19_999, 20_000]);
    expect((await store.loadMessagesBefore(session.id, 19_999, 2)).message_rows.map(row => row.seq)).toEqual([19_997, 19_998]);
    expect(await store.previousUserMessageSeq(session.id, 19_999)).toBe(19_997);
    expect((await store.getMessageBySeq(session.id, 4))?.row.seq).toBe(4);
    expect(await store.getFirstUserMessageText(session.id)).toBe('message 1');
    expect(await store.getLatestNonMetaUserMessageText(session.id)).toBe('message 19999');
    expect(kinds).toEqual(['stats', 'stats', 'stats', 'tail', 'before', 'previousUser', 'message', 'firstUser', 'latestUser']);
  });

  it('rejects corrupt or oversized worker metadata instead of returning the stale native-session catalog', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Metadata bounds', provider: 'test', model: 'test' });
    const reader = openStore();
    try {
      await reader.getSession(session.id);
      reader.setConversationProjectionLoader(async () => ({ messages: [], rows: [] }));
      const location = (await store.getSessionLocation(session.id))!;
      await writeFile(join(location.bundle_path, 'state.json'), JSON.stringify({ schema_version: 999 }));
      await expect(reader.loadSessionWithMessages(session.id)).rejects.toThrow('identity or schema');
      await writeFile(join(location.bundle_path, 'state.json'), Buffer.alloc(8 * 1024 * 1024 + 1, 32));
      await expect(reader.loadSessionWithMessages(session.id)).rejects.toThrow('metadata bound');
    } finally { await reader.close(); }
  });

  it('refreshes worker-owned metadata while reading a native transcript without a writer or synchronous metadata reads', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Native metadata', provider: 'test', model: 'test' });
    const reader = openStore();
    try {
      expect((await reader.getSession(session.id))?.worktree_path).toBeNull();
      reader.setConversationProjectionLoader(async () => ({ messages: [], rows: [], usage: {
        total_input_tokens: 12, total_output_tokens: 4, total_cache_read_tokens: 0,
        total_cache_creation_tokens: 0, last_turn_input_tokens: 12,
      } }));
      const syncSession = vi.spyOn(reader.repository, 'readSessionSync');
      const syncState = vi.spyOn(reader.repository, 'readStateSync');
      const journal = vi.spyOn(reader.repository, 'readConversation');
      const tree = join(projectRoot, '.mcp-indexer/worktrees/owned');
      await store.setSessionWorktree(session.id, tree);
      await store.setSessionToolPermissionMode(session.id, 'ask');
      const result = await reader.loadSessionWithMessages(session.id);
      expect(result?.session).toMatchObject({ worktree_path: tree, tool_permission_mode: 'ask', total_input_tokens: 12 });
      expect((await reader.getSession(session.id))?.worktree_path).toBe(tree);
      expect(syncSession).not.toHaveBeenCalled();
      expect(syncState).not.toHaveBeenCalled();
      expect(journal).not.toHaveBeenCalled();
    } finally { await reader.close(); }
  });

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
      store.setSessionBlockCodeComments(session.id, false),
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

    await store.mergeSessionToolsetState(session.id, {
      pins: ['look_at', 'save_scene'],
      visibleCap: 64,
    });
    expect((await store.getSession(session.id))?.state.tools.toolset).toEqual({
      v: 1,
      extraTiers: ['company'],
      pins: ['look_at', 'save_scene'],
      visibleCap: 64,
    });

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
      block_code_comments: false,
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
    expect(await store.getSessionEventByOperationId(
      session.id,
      'event:policy:1',
      'policy_decision',
    )).toEqual(firstEvent);
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
    const taskRunPage = await store.listTaskRunsPage(session.id, 0, 1);
    expect(taskRunPage).toMatchObject({
      totalCount: 1,
      nextOffset: null,
      items: [expect.objectContaining({ run_id: runId, mode: 'auto' })],
    });
    expect(taskRunPage.revision).toBeGreaterThan(0);
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

    const readConversationSync = vi.spyOn(store.repository, 'readConversationSync');
    const toolPage = await store.listToolCallSummaries(session.id, 0, 2);
    expect(toolPage.totalCount).toBe(3);
    expect(toolPage.items).toHaveLength(2);
    expect(toolPage.nextOffset).toBe(2);
    expect(toolPage.revision).toBeGreaterThan(0);
    expect(readConversationSync).not.toHaveBeenCalled();

    const aggregate = await store.getDriveAggregate(session.id);
    expect(aggregate.fileMap.changed).toContain('src/a.ts');
    expect(aggregate.tasks?.tasks[0].status).toBe('interrupted');
  });
});
