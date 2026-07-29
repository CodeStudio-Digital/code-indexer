import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toolOutputRecordFileName } from '@mcp/session-storage';
import { FsSessionStore } from '../fs-session-store.js';

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
        'conversation.jsonl',
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
    expect(transcript.trim().split('\n')).toHaveLength(2);
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
