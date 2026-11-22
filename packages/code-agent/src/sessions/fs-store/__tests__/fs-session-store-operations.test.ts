import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asSessionId } from '@mcp/session-storage';
import { FsSessionStore } from '../fs-session-store.js';

let temporaryRoot: string;
let projectRoot: string;
let store: FsSessionStore;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'mcp-fs-session-ops-'));
  const dataDir = join(temporaryRoot, 'data');
  projectRoot = join(temporaryRoot, 'project');
  await Promise.all([mkdir(dataDir), mkdir(projectRoot)]);
  store = FsSessionStore.fromRoots({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (id) => (id === 7 ? projectRoot : null),
      listProjectRoots: () => [
        { project_id: 7, root_path: projectRoot },
      ],
    },
    projectInfoResolver: () => ({
      project_id: 7,
      name: 'Project',
      root_path: projectRoot,
    }),
  });
});

afterEach(async () => {
  await store.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('filesystem session operations', () => {
  it.each([
    ['zai', 159_126, 158_976, 0],
    ['claude-code', 100, 158_976, 50],
  ])('recovers the last measured context for a legacy %s session and its copy', async (provider, input, read, write) => {
    const session = await store.createSession({ project_id: 7, title: 'Context', provider, model: 'test' });
    await store.persistAssistantTurn({
      session_id: session.id, message: { role: 'assistant', content: [{ type: 'text', text: 'Measured' }] },
      usage: { input_tokens: input, output_tokens: 24, cache_read_input_tokens: read, cache_creation_input_tokens: write },
      tool_calls: [],
    });
    await store.persistAssistantTurn({
      session_id: session.id, message: { role: 'assistant', content: [{ type: 'text', text: 'Checkpoint' }] },
      usage: null, tool_calls: [],
    });
    const copy = await store.duplicateSession(session.id);
    for (const id of [session.id, copy.id]) {
      expect((await store.getSessionStats(id))?.last_turn_prompt_tokens).toBe(159_126);
    }
  });

  it('keeps a runner estimate through checkpoint, commit, replay, and copy without adding billed tokens', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Estimate', provider: 'zai', model: 'glm-5.3' });
    const context = { prompt_tokens: 158_989, context_window: 991_808, source: 'estimate' as const };
    const turn = {
      session_id: session.id, message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Ready' }] },
      usage: null, tool_calls: [], context,
    };
    const seq = await store.persistAssistantTurn({ ...turn, operation_id: 'checkpoint' });
    expect((await store.getSessionStats(session.id))?.last_turn_context).toEqual(context);
    const commit = { ...turn, operation_id: 'finish', existing_message_seq: seq };
    await store.persistAssistantTurn(commit);
    expect(await store.persistAssistantTurn(commit)).toBe(seq);
    const copy = await store.duplicateSession(session.id);
    expect(await store.getSessionStats(copy.id)).toMatchObject({
      last_turn_prompt_tokens: 158_989, last_turn_context: context,
      total_input_tokens: 0, total_output_tokens: 0, assistant_turns: 1,
    });
  });

  it('duplicates and forks conversation artifacts without SQLite', async () => {
    const source = await store.createSession({
      project_id: 7,
      title: 'Source',
      provider: 'openai',
      model: 'gpt-test',
    });
    const imageBase64 = Buffer.from('image-bytes').toString('base64');
    await store.appendMessage({
      session_id: source.id,
      operation_id: 'source-user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect' },
          { type: 'image', mediaType: 'image/png', base64: imageBase64 },
        ],
      },
    });
    await store.persistAssistantTurn({
      session_id: source.id,
      operation_id: 'source-assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Done' },
          {
            type: 'tool_use',
            id: 'call-1',
            name: 'read_file',
            input: { path: 'a.ts' },
          },
        ],
      },
      usage: { input_tokens: 10, output_tokens: 4 },
      tool_calls: [
        {
          tool_use_id: 'call-1',
          tool_name: 'read_file',
          args: { path: 'a.ts' },
          raw_result: 'raw-output',
          result_text: 'shaped-output',
          is_error: false,
          duration_ms: 9,
        },
      ],
    });
    const targetSeq = await store.appendMessage({
      session_id: source.id,
      operation_id: 'source-editable-user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Edit this request' }],
      },
    });
    const sourceLocation = (await store.getSessionLocation(source.id))!;
    const sourceCommits = store.repository.readConversationSync(sourceLocation);

    const duplicate = await store.duplicateSession(source.id);
    expect(duplicate.id).not.toBe(source.id);
    expect(duplicate.title).toBe('Source (cópia)');
    const duplicateData = await store.loadAllSessionMessages(duplicate.id);
    expect(duplicateData?.messages).toHaveLength(4);
    expect(duplicateData?.messages[0].content[1]).toMatchObject({
      type: 'image',
      base64: imageBase64,
    });
    expect(
      Buffer.from(
        (await store.getToolOutput(duplicate.id, 'call-1'))!.shaped!,
      ).toString('utf8'),
    ).toBe('shaped-output');
    const duplicateLocation = (await store.getSessionLocation(duplicate.id))!;
    expect(
      store.repository.readConversationSync(duplicateLocation),
    ).toEqual(sourceCommits);

    const deterministicId = asSessionId('99999999-9999-4999-8999-999999999999');
    const deterministic = await store.duplicateSession(source.id, {
      targetId: deterministicId,
      title: 'Command copy',
    });
    const retried = await store.duplicateSession(source.id, {
      targetId: deterministicId,
      title: 'Command copy',
    });
    expect(retried.id).toBe(deterministic.id);
    expect(retried.title).toBe('Command copy');
    expect((await store.loadAllSessionMessages(retried.id))?.messages).toHaveLength(4);

    const fork = await store.forkSessionBeforeSeq(source.id, targetSeq);
    expect(fork.seed_text).toBe('Edit this request');
    expect(fork.session.id).not.toBe(source.id);
    expect(
      (await store.loadAllSessionMessages(fork.session.id))?.messages,
    ).toHaveLength(3);
    const forkLocation = (await store.getSessionLocation(fork.session.id))!;
    const forkCommits = store.repository.readConversationSync(forkLocation);
    expect(forkCommits.slice(0, sourceCommits.length)).toEqual(sourceCommits);
    expect(forkCommits).toHaveLength(sourceCommits.length + 1);

    const stats = await store.getSessionStats(source.id);
    expect(stats).toMatchObject({
      message_count: 4,
      assistant_turns: 1,
      tool_call_count: 1,
      tool_error_count: 0,
      distinct_tools: 1,
      total_tool_duration_ms: 9,
    });
  });

  it('rolls back through an append-only marker and never reuses message seq', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Rollback',
      provider: 'openai',
      model: 'gpt-test',
    });
    await store.appendMessage({
      session_id: session.id,
      operation_id: 'rollback-user-1',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Keep me' }],
      },
    });
    await store.persistAssistantTurn({
      session_id: session.id,
      operation_id: 'rollback-assistant-1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Kept answer' }],
      },
      usage: { input_tokens: 5, output_tokens: 2 },
      tool_calls: [],
      nested_tool_calls: [{
        tool_use_id: 'kept-tool',
        tool_name: 'read_file',
        args: { path: 'kept.ts' },
        raw_result: 'kept',
        result_text: 'kept',
        is_error: false,
        duration_ms: 3,
      }],
    });
    const targetSeq = await store.appendMessage({
      session_id: session.id,
      operation_id: 'rollback-user-2',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Edit me' },
          {
            type: 'document',
            name: 'note.txt',
            mediaType: 'text/plain',
            text: 'attachment',
          },
        ],
      },
    });
    await store.persistAssistantTurn({
      session_id: session.id,
      operation_id: 'rollback-assistant-2',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Discarded answer' }],
      },
      usage: { input_tokens: 11, output_tokens: 7 },
      tool_calls: [],
      nested_tool_calls: [{
        tool_use_id: 'discarded-tool',
        tool_name: 'write_file',
        args: { path: 'discarded.ts' },
        raw_result: 'discarded',
        result_text: 'discarded',
        is_error: false,
        duration_ms: 5,
      }],
    });
    await store.recordPlan({
      session_id: session.id,
      tool_use_id: 'plan-after-target',
      message_seq: targetSeq,
      plan_text: 'Discarded plan',
    });
    await store.recordTasks({
      session_id: session.id,
      tool_use_id: 'tasks-after-target',
      state: {
        summary: 'Discarded tasks',
        tasks: [],
        execution_mode: null,
        approved: false,
        current_task_id: null,
      },
    });
    const location = (await store.getSessionLocation(session.id))!;
    const beforeCommits =
      store.repository.readConversationSync(location).length;
    expect((await store.getSessionStats(session.id))?.message_count).toBe(4);

    const rolledBack = await store.rollbackSessionToSeq(
      session.id,
      targetSeq,
    );
    expect(rolledBack).toMatchObject({
      seed_text: 'Edit me',
      seed_attachments: [
        {
          name: 'note.txt',
          mediaType: 'text/plain',
          text: 'attachment',
        },
      ],
      had_attachments: true,
    });
    expect(
      store.repository.readConversationSync(location),
    ).toHaveLength(beforeCommits + 1);
    expect(
      (await store.loadAllSessionMessages(session.id))?.messages.map(
        (message) => message.content[0],
      ),
    ).toEqual([
      { type: 'text', text: 'Keep me' },
      { type: 'text', text: 'Kept answer' },
    ]);
    expect(await store.listPlans(session.id)).toEqual([]);
    expect(await store.getTasksState(session.id)).toBeNull();
    expect(await store.getSessionStats(session.id)).toMatchObject({
      total_input_tokens: 5,
      total_output_tokens: 2,
      message_count: 2,
      assistant_turns: 1,
    });
    const toolPage = await store.listToolCallSummaries(session.id, 0, 10);
    expect(toolPage.items).toEqual([
      expect.objectContaining({ name: 'read_file', count: 1 }),
    ]);

    // A replay returns the original seed without appending another marker.
    expect(
      (await store.rollbackSessionToSeq(session.id, targetSeq)).seed_text,
    ).toBe('Edit me');
    expect(
      store.repository.readConversationSync(location),
    ).toHaveLength(beforeCommits + 1);

    const nextSeq = await store.appendMessage({
      session_id: session.id,
      operation_id: 'rollback-new-user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Replacement' }],
      },
    });
    expect(nextSeq).toBeGreaterThan(targetSeq + 1);
  });
});
