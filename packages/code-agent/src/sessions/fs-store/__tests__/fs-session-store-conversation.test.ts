import { randomUUID } from 'node:crypto';
import { prepareMessage, requestKey, toJsonValue } from '@mcp/session-storage/fs-store/conversation-codec.js';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore, toolOutputRecordFileName } from '@mcp/session-storage';
import { FsSessionStore } from '../fs-session-store.js';
import { unresolvedToolOutcomes } from '../../../core/uncertain-tool-outcome.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let temporaryRoot: string;
let dataDir: string;
let projectRoot: string;
let store: FsSessionStore;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'mcp-fs-conversation-'));
  dataDir = join(temporaryRoot, 'data');
  projectRoot = join(temporaryRoot, 'project');
  await Promise.all([mkdir(dataDir), mkdir(projectRoot)]);
  store = FsSessionStore.fromRoots({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) =>
        projectId === 7 ? projectRoot : null,
      listProjectRoots: () => [
        { project_id: 7, root_path: projectRoot },
      ],
    },
  });
});

afterEach(async () => {
  await store.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('FsSessionStore conversation journal', () => {
  it('replays a pre-removal turn without duplicating it and omits Meta from new records', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Legacy replay', provider: 'test', model: 'test' });
    const location = (await store.getSessionLocation(session.id))!;
    const input = {
      session_id: session.id, operation_id: 'legacy-assistant',
      message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Approved plan remains available' }] },
      usage: null, tool_calls: [],
    };
    const prepared = prepareMessage(location, input.message, input.usage);
    const legacyKey = requestKey({ type: 'persist-assistant-turn', message: prepared.stored,
      tool_calls: [], nested_tool_calls: [], existing_message_seq: null,
      goal_mutations: [], goal_noop_tool_use_ids: [],
    });
    await store.repository.commitTurn(location, {
      operation_id: input.operation_id,
      payload: toJsonValue({ schema_version: 1, type: 'coder.turn', request_key: legacyKey,
        messages: [{ ...prepared.stored, id: randomUUID(), seq: 1 }], message_patches: [], tool_calls: [], goal_mutations: [],
      }),
    });
    await expect(store.persistAssistantTurn(input)).resolves.toBe(1);
    expect(await store.getMessageCount(session.id)).toBe(1);
    await store.persistAssistantTurn({ ...input, operation_id: 'new-assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Continuing the tasks' }] },
    });
    const commits = await store.repository.readConversation(location);
    expect(commits).toHaveLength(2);
    expect(commits[1].payload).not.toHaveProperty('goal_mutations');
  });

  it('hydrates only the selected window and lists every sent attachment without opening blobs', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Bounded attachments', provider: 'test', model: 'test' });
    for (let index = 0; index < 24; index++) {
      await store.appendMessage({ session_id: session.id, operation_id: `attachment-${index}`, message: {
        role: 'user', content: [{ type: 'document', name: `file-${index}.txt`, mediaType: 'text/plain', text: `body-${index}`.repeat(4096) }],
      } });
    }
    const read = vi.spyOn(ArtifactStore.prototype, 'read');
    try {
      const tail = await store.loadSessionMessagesTail(session.id, 2);
      expect(tail?.messages).toHaveLength(2);
      expect(read).toHaveBeenCalledTimes(2);
      read.mockClear();
      expect(await store.getMessageCount(session.id)).toBe(24);
      expect(await store.getArchivedMessageCount(session.id)).toBe(0);
      const first = await store.listSessionAttachments(session.id, 0, 10);
      const second = await store.listSessionAttachments(session.id, first.next_offset!, 10);
      expect(first).toMatchObject({ total: 24, next_offset: 10 });
      expect(first.items[0]?.name).toBe('file-0.txt');
      expect(second.items[0]?.name).toBe('file-10.txt');
      expect(read).not.toHaveBeenCalled();
      const download = await store.readSessionAttachment(session.id, first.items[0]!.seq, first.items[0]!.index);
      expect(Buffer.from(download!.bytes).toString()).toBe('body-0'.repeat(4096));
      await store.loadAllSessionMessages(session.id);
      expect(read).toHaveBeenCalledTimes(24);
    } finally { read.mockRestore(); }
  });

  it('keeps image filenames and local references discoverable after compaction', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Named image', provider: 'test', model: 'test' });
    await store.appendMessage({ session_id: session.id, message: { role: 'user', content: [
      { type: 'image', name: 'capture.png', mediaType: 'image/png', base64: Buffer.from('image fixture').toString('base64') },
      { type: 'document', name: 'external.txt', mediaType: 'text/plain', path: 'D:/fixture/external.txt' },
    ] } });
    await store.persistAssistantTurn({ session_id: session.id, operation_id: 'generated-image', usage: null, tool_calls: [], message: {
      role: 'assistant', content: [{ type: 'image', name: 'generated-image.png', mediaType: 'image/png', base64: Buffer.from('generated pixels').toString('base64') }],
    } });
    await store.appendMessage({ session_id: session.id, message: { role: 'user', content: [
      { type: 'text', text: '(Image(s) attached from the tool call above.)' },
      { type: 'image', name: 'tool-preview.png', mediaType: 'image/png', base64: Buffer.from('preview pixels').toString('base64') },
    ] } });
    await store.setCompactionBoundary(session.id, 'summary', 1, 'manual');
    const all = await store.listSessionAttachments(session.id);
    expect(all.items.map(item => [item.name, item.downloadable, item.origin])).toEqual([
      ['capture.png', true, 'sent'], ['external.txt', false, 'sent'], ['generated-image.png', true, 'generated'], ['tool-preview.png', true, 'tool'],
    ]);
    const generated = all.items.find(item => item.origin === 'generated')!;
    const original = await store.readSessionAttachment(session.id, generated.seq, generated.index);
    expect(Buffer.from(original!.bytes).toString()).toBe('generated pixels');
    expect(await store.readSessionAttachment(session.id, 1, 1)).toBeNull();
  });

  it('retains uncertain-effect authority across close and recovery', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Unknown effect', provider: 'test', model: 'test' });
    await store.persistAssistantTurn({ session_id: session.id, operation_id: 'uncertain-turn', usage: null,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'uncertain-call', name: 'ext_test__write', input: {} }] },
      tool_calls: [{ tool_use_id: 'uncertain-call', tool_name: 'ext_test__write', args: {}, result_text: 'lost ACK',
        is_error: true, effect_outcome: 'unknown', duration_ms: 1 }] });
    await store.close();
    store = FsSessionStore.fromRoots({ dataDir, projectRootResolver: {
      resolveProjectRoot: id => id === 7 ? projectRoot : null,
      listProjectRoots: () => [{ project_id: 7, root_path: projectRoot }],
    } });
    const history = await store.listMessagesAfter(session.id, 0);
    expect(unresolvedToolOutcomes(history.messages)[0]).toBe('uncertain-call');
    const boundary = (await store.loadSessionWithMessages(session.id))!.message_rows.at(-1)!.seq;
    await store.setCompactionBoundary(session.id, 'The operation was interrupted.', boundary, 'manual');
    await store.appendMessage({ session_id: session.id, message: { role: 'user', content: [{ type: 'text', text: 'Continue' }] } });
    await store.close();
    store = FsSessionStore.fromRoots({ dataDir, projectRootResolver: {
      resolveProjectRoot: id => id === 7 ? projectRoot : null,
      listProjectRoots: () => [{ project_id: 7, root_path: projectRoot }],
    } });
    const compacted = await store.loadSessionWithMessages(session.id);
    expect(unresolvedToolOutcomes(compacted!.messages)[0]).toBeUndefined();
    expect(compacted!.unresolved_tool_outcomes).toEqual(['uncertain-call']);
  });
  it('persists warmed turns without rereading the full journal', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Warm turns', provider: 'test', model: 'test' });
    const syncRead = vi.spyOn(store.repository, 'readConversationSync');
    const asyncRead = vi.spyOn(store.repository, 'readConversation');
    for (let turn = 0; turn < 8; turn++) {
      await store.persistAssistantTurn({ session_id: session.id, operation_id: `warm-${turn}`,
        message: { role: 'assistant', content: [{ type: 'text', text: `turn ${turn}` }] },
        tool_calls: [],
        usage: null,
      });
    }
    expect(syncRead).not.toHaveBeenCalled();
    expect(asyncRead).not.toHaveBeenCalled();
  });

  it('reads the highest message sequence from the committed JSONL tail without hydrating history', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Cheap tail sequence',
      provider: 'test',
      model: 'test',
    });
    await store.appendMessage({
      session_id: session.id,
      operation_id: 'tail-user-1',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'first' }],
      },
    });
    const location = await store.getSessionLocation(session.id);
    expect(location).not.toBeNull();
    await store.repository.commitTurn(location!, {
      operation_id: 'tail-patch-only',
      payload: {
        schema_version: 1,
        type: 'coder.turn',
        request_key: 'tail-patch-only',
        messages: [],
        message_patches: [],
        tool_calls: [],
        goal_mutations: [],
      },
    });
    await appendFile(
      join(location!.bundle_path, 'journal.jsonl'),
      '{"uncommitted":true',
      'utf8',
    );

    const fullRead = vi
      .spyOn(store.repository, 'readConversationSync')
      .mockImplementation(() => {
        throw new Error('full conversation hydration is forbidden');
      });

    await expect(store.maxMessageSeq(session.id)).resolves.toBe(1);
    await expect(store.listMessagesAfter(session.id, 0)).resolves.toMatchObject({
      maxSeq: 1,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'first' }],
      }],
    });
    expect(fullRead).not.toHaveBeenCalled();
  });

  it('shares one hydrated projection across a session detail request', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Shared detail projection',
      provider: 'test',
      model: 'test',
    });
    await store.appendMessage({
      session_id: session.id,
      operation_id: 'detail-user-1',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'first' }],
      },
    });
    await store.appendMessage({
      session_id: session.id,
      operation_id: 'detail-assistant-1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
      },
    });
    const readConversation = vi.spyOn(store.repository, 'readConversation');

    const tail = await store.loadSessionMessagesTail(session.id, 40);
    const count = await store.getMessageCount(session.id);
    const archived = await store.getArchivedMessageCount(session.id);
    const preceding = await store.previousUserMessageSeq(
      session.id,
      tail!.message_rows[0]!.seq,
    );

    expect(tail?.message_rows).toHaveLength(2);
    expect(count).toBe(2);
    expect(archived).toBe(0);
    expect(preceding).toBeNull();
    expect(readConversation).toHaveBeenCalledOnce();

    await store.appendMessage({
      session_id: session.id,
      operation_id: 'detail-user-2',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'changed' }],
      },
    });
    await expect(store.getMessageCount(session.id)).resolves.toBe(3);
    expect(readConversation).toHaveBeenCalledTimes(2);
  });

  it('persists the public assistant phase through journal hydration and rows', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Assistant phase',
      provider: 'openai-chatgpt',
      model: 'gpt-5.6-sol',
    });
    await store.appendMessage({
      session_id: session.id,
      operation_id: 'phase-assistant-1',
      message: {
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'text', text: 'Checking the backend.' }],
      },
    });

    const loaded = await store.loadSessionMessagesTail(session.id, 10);
    expect(loaded?.messages).toEqual([{
      role: 'assistant',
      phase: 'commentary',
      content: [{ type: 'text', text: 'Checking the backend.' }],
    }]);
    expect(loaded?.message_rows[0]?.phase).toBe('commentary');
  });

  it('persists every tool-bearing assistant turn from the same agent run', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Multi-turn worker transcript',
      provider: 'test',
      model: 'test',
    });
    const persist = (ordinal: number) => store.persistAssistantTurn({
      session_id: session.id,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: `assistant turn ${ordinal}` },
          {
            type: 'tool_use',
            id: `call-${ordinal}`,
            name: 'read_file',
            input: { path: `file-${ordinal}.ts` },
          },
        ],
      },
      usage: null,
      tool_calls: [{
        tool_use_id: `call-${ordinal}`,
        tool_name: 'read_file',
        args: { path: `file-${ordinal}.ts` },
        result_text: `result ${ordinal}`,
        is_error: false,
        duration_ms: ordinal,
        run_id: 'same-agent-run',
      }],
    });

    await expect(persist(1)).resolves.toBe(1);
    await expect(persist(2)).resolves.toBe(3);

    const loaded = await store.loadSessionWithMessages(session.id);
    expect(
      loaded?.message_rows
        .filter((row) => row.role === 'assistant')
        .map((row) => JSON.parse(row.content_json)[0]?.text),
    ).toEqual(['assistant turn 1', 'assistant turn 2']);

    const journal = await readFile(
      join(
        projectRoot,
        '.mcp-indexer',
        'session',
        session.id,
        'journal.jsonl',
      ),
      'utf8',
    );
    expect(
      journal
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).operation_id),
    ).toEqual([
      'assistant:tool:call-1',
      'assistant:tool:call-2',
    ]);
  });

  it('extracts attachments/tool outputs, hydrates reads and replays idempotently', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Filesystem transcript',
      provider: 'test',
      model: 'test',
    });
    const imageBytes = Buffer.from('not-a-real-image-but-stable');
    const imageBase64 = imageBytes.toString('base64');
    const documentText = 'DOCUMENT-BODY-MUST-NOT-BE-IN-JSONL';
    const userSeq = await store.appendMessage({
      session_id: session.id,
      operation_id: 'user-turn-1',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect these files' },
          {
            type: 'image',
            mediaType: 'image/png',
            base64: imageBase64,
          },
          {
            type: 'document',
            name: 'notes.txt',
            mediaType: 'text/plain',
            text: documentText,
          },
        ],
        selectedSkillIds: ['skill-a'],
      },
    });
    expect(userSeq).toBe(1);
    expect(
      await store.appendMessage({
        session_id: session.id,
        operation_id: 'user-turn-1',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect these files' },
            {
              type: 'image',
              mediaType: 'image/png',
              base64: imageBase64,
            },
            {
              type: 'document',
              name: 'notes.txt',
              mediaType: 'text/plain',
              text: documentText,
            },
          ],
          selectedSkillIds: ['skill-a'],
        },
      }),
    ).toBe(1);

    const toolUseId = 'CON:call_1';
    const rawResult = 'RAW-TOOL-OUTPUT-MUST-NOT-BE-IN-JSONL';
    const shapedResult = 'SHAPED-TOOL-OUTPUT-MUST-NOT-BE-IN-JSONL';
    const assistantSeq = await store.persistAssistantTurn({
      session_id: session.id,
      operation_id: 'assistant-turn-1',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I inspected it.' },
          {
            type: 'tool_use',
            id: toolUseId,
            name: 'read_file',
            input: { path: 'notes.txt' },
          },
        ],
      },
      usage: {
        input_tokens: 100,
        output_tokens: 25,
        cache_read_input_tokens: 40,
      },
      tool_calls: [
        {
          tool_use_id: toolUseId,
          tool_name: 'read_file',
          args: { path: 'notes.txt' },
          raw_result: rawResult,
          result_text: shapedResult,
          is_error: false,
          duration_ms: 12,
        },
      ],
    });
    expect(assistantSeq).toBe(2);
    expect(
      await store.persistAssistantTurn({
        session_id: session.id,
        operation_id: 'assistant-turn-1',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I inspected it.' },
            {
              type: 'tool_use',
              id: toolUseId,
              name: 'read_file',
              input: { path: 'notes.txt' },
            },
          ],
        },
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          cache_read_input_tokens: 40,
        },
        tool_calls: [
          {
            tool_use_id: toolUseId,
            tool_name: 'read_file',
            args: { path: 'notes.txt' },
            raw_result: rawResult,
            result_text: shapedResult,
            is_error: false,
            duration_ms: 12,
          },
        ],
      }),
    ).toBe(2);

    const bundle = join(
      projectRoot,
      '.mcp-indexer',
      'session',
      String(session.id),
    );
    const transcript = await readFile(
      join(bundle, 'conversation.jsonl'),
      'utf8',
    );
    expect(transcript.trim().split('\n').map(line => JSON.parse(line).role)).toEqual(['user', 'assistant', 'tool']);
    expect(transcript).not.toContain(imageBase64);
    expect(transcript).not.toContain(documentText);
    expect(transcript).not.toContain(rawResult);
    expect(transcript).not.toContain(shapedResult);

    const loaded = await store.loadSessionWithMessages(session.id);
    expect(loaded?.message_rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(loaded?.message_rows.map((row) => row.id)).toEqual([
      expect.stringMatching(UUID_PATTERN),
      expect.stringMatching(UUID_PATTERN),
      expect.stringMatching(UUID_PATTERN),
    ]);
    expect(new Set(loaded?.message_rows.map((row) => row.id)).size).toBe(3);
    expect(loaded?.messages[0].content[1]).toMatchObject({
      type: 'image',
      base64: imageBase64,
    });
    expect(loaded?.messages[0].content[2]).toMatchObject({
      type: 'document',
      text: documentText,
    });
    expect(loaded?.messages[2].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: shapedResult,
    });

    const output = await store.getToolOutput(session.id, toolUseId);
    expect(Buffer.from(output!.raw!).toString('utf8')).toBe(rawResult);
    expect(Buffer.from(output!.shaped!).toString('utf8')).toBe(shapedResult);
    const results = await store.getToolResultsByToolUseIds(session.id, [
      toolUseId,
    ]);
    expect(results[0]).toMatchObject({
      id: expect.stringMatching(UUID_PATTERN),
      message_seq: 2,
      result_text: shapedResult,
      raw_result_text: rawResult,
    });

    expect(
      (await store.loadSessionMessagesTail(session.id, 1))?.message_rows.map(
        (row) => row.seq,
      ),
    ).toEqual([2, 3]);
    expect(
      (
        await store.loadMessagesBefore(session.id, 4, 1)
      ).message_rows.map((row) => row.seq),
    ).toEqual([2, 3]);
    expect((await store.listMessagesAfter(session.id, 1)).maxSeq).toBe(3);

    const compacted = await store.setCompactionBoundary(
      session.id,
      'Earlier summary',
      1,
      'manual',
    );
    expect(compacted).toEqual({ boundary_seq: 1, pruned_count: 1 });
    expect(await store.getArchivedMessageCount(session.id)).toBe(1);
    expect(
      (await store.loadSessionWithMessages(session.id))?.message_rows.map(
        (row) => row.seq,
      ),
    ).toEqual([2, 3]);

    await Promise.all([
      stat(join(bundle, 'metrics', 'turns', 'turn-1.json')),
      stat(join(bundle, 'metrics', 'turns', 'turn-2.json')),
      stat(
        join(
          bundle,
          'tools_outputs',
          'calls',
          toolOutputRecordFileName(toolUseId),
        ),
      ),
    ]);
    const attachmentBlobs = await readdir(
      join(bundle, 'attachments', 'blobs', 'sha256'),
      { recursive: true },
    );
    expect(attachmentBlobs.length).toBeGreaterThanOrEqual(2);

    const location = store.locator.locate(
      { kind: 'project', project_id: 7 },
      session.id,
    );
    await store.repository.writeEntity(
      location,
      'metrics/provider_attempts',
      'attempt-1',
      { schema_version: 1, provider: 'test' },
    );
    expect(await store.getMetricsSummary(session.id)).toMatchObject({
      turns: 2,
      tool_calls: 1,
      provider_attempts: 1,
      tokens: {
        input: 100,
        output: 25,
        cache_read: 40,
        cache_creation: 0,
      },
    });
    expect(await store.getSession(session.id)).toMatchObject({
      total_input_tokens: 100,
      total_output_tokens: 25,
      total_cache_read_tokens: 40,
      total_cache_creation_tokens: 0,
    });

    await store.close();
    await rm(join(bundle, 'metrics', 'summary.json'));
    store = FsSessionStore.fromRoots({
      dataDir,
      projectRootResolver: {
        resolveProjectRoot: (projectId) =>
          projectId === 7 ? projectRoot : null,
        listProjectRoots: () => [
          { project_id: 7, root_path: projectRoot },
        ],
      },
    });
    expect(await store.rebuildMetricsSummary(session.id)).toMatchObject({
      turns: 2,
      tool_calls: 1,
      provider_attempts: 1,
      tokens: {
        input: 100,
        output: 25,
        cache_read: 40,
        cache_creation: 0,
      },
    });
  });

  it('completes a checkpointed assistant message without duplicating it', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Checkpoint',
      provider: 'test',
      model: 'test',
    });
    const checkpointSeq = await store.appendMessage({
      session_id: session.id,
      operation_id: 'assistant-checkpoint',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Waiting for approval' }],
      },
    });
    const completed = await store.persistAssistantTurn({
      session_id: session.id,
      operation_id: 'assistant-checkpoint-complete',
      existing_message_seq: checkpointSeq,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Approval received' }],
      },
      usage: { input_tokens: 10, output_tokens: 3 },
      tool_calls: [],
    });
    expect(completed).toBe(checkpointSeq);
    const loaded = await store.loadSessionWithMessages(session.id);
    expect(loaded?.message_rows).toHaveLength(1);
    expect(loaded?.messages[0].content[0]).toMatchObject({
      type: 'text',
      text: 'Approval received',
    });
    expect(loaded?.message_rows[0].input_tokens).toBe(10);
  });
});
