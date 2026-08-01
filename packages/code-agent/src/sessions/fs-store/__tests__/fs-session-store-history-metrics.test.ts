import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { FsSessionStore } from '../fs-session-store.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUN_ID = '11111111-1111-4111-8111-111111111111';

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
  temporaryRoot = await mkdtemp(join(tmpdir(), 'mcp-fs-history-'));
  dataDir = join(temporaryRoot, 'data');
  projectRoot = join(temporaryRoot, 'project');
  await Promise.all([mkdir(dataDir), mkdir(projectRoot)]);
  store = openStore();
});

afterEach(async () => {
  await store.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('FsSessionStore chapter and attempt repositories', () => {
  it('persists UUID chapters, source/search and repairs a stale state projection after restart', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Chapter persistence',
      provider: 'test',
      model: 'test',
    });
    await store.appendMessage({
      session_id: session.id,
      operation_id: 'chapter-user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Decida autenticação.' }],
      },
    });
    await store.appendMessage({
      session_id: session.id,
      operation_id: 'chapter-assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Usaremos cookies assinados no primeiro marco.',
          },
        ],
      },
    });

    const input = {
      sessionId: session.id,
      expectedBoundarySeq: 0,
      startMessageSeq: 1,
      endMessageSeq: 2,
      source: 'auto' as const,
      chapterKind: 'context' as const,
      trigger: 'context_threshold',
      title: 'Decisão de autenticação',
      chapterJson: '{"decision":"signed cookies"}',
      chapterText: 'Primeiro marco: usar cookies assinados.',
      resumeJson: '{"next":"implement"}',
      resumeText: 'Continue implementando cookies assinados.',
      version: 3,
      operation_id: 'chapter-checkpoint-run-1',
    };
    const committed = await store.commitConversationChapter(input);
    expect(committed.status).toBe('committed');
    if (committed.status !== 'committed') throw new Error('not committed');
    expect(committed.chapter.id).toMatch(UUID_PATTERN);
    expect(committed.chapter.seq).toBe(1);
    expect(committed.boundary_seq).toBe(2);
    expect(committed.pruned_count).toBe(2);

    const replay = await store.commitConversationChapter(input);
    expect(replay).toMatchObject({
      status: 'noop',
      reason: 'already_committed',
      boundary_seq: 2,
      chapter: { id: committed.chapter.id },
    });
    await expect(
      store.commitConversationChapter({
        ...input,
        title: 'Conflicting replay',
      }),
    ).rejects.toThrow(/operation_id .* different/i);
    expect(await store.countConversationChapters(session.id)).toBe(1);
    expect(
      (
        await store.searchConversationChapters(
          session.id,
          'primeiro cookies',
        )
      ).items[0]?.id,
    ).toBe(committed.chapter.id);
    const readConversation = vi.spyOn(store.repository, 'readConversation');
    const source = await store.listConversationChapterSource(
      session.id,
      committed.chapter.id,
      { limit: 1 },
    );
    expect(source.items).toHaveLength(1);
    expect(source.items[0]).toMatchObject({ seq: 1, role: 'user' });
    expect(source.next_cursor).toBe('message:1');
    const sourceTail = await store.listConversationChapterSource(
      session.id,
      committed.chapter.id,
      { limit: 1, cursor: source.next_cursor },
    );
    expect(sourceTail.items[0]).toMatchObject({ seq: 2, role: 'assistant' });
    expect(sourceTail.next_cursor).toBeNull();
    expect(readConversation).toHaveBeenCalledOnce();

    const bundle = join(
      projectRoot,
      '.mcp-indexer',
      'session',
      session.id,
    );
    await store.close();
    const statePath = join(bundle, 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      compaction: Record<string, unknown>;
    };
    state.compaction = {
      ...state.compaction,
      boundary_seq: 0,
      summary: null,
      count_auto: 0,
    };
    await writeFile(statePath, `${JSON.stringify(state)}\n`, 'utf8');
    store = openStore();

    const recovered = await store.loadSessionWithMessages(session.id);
    expect(recovered?.session.summary_boundary_id).toBe(2);
    expect(recovered?.session.compaction_summary).toBe(
      input.resumeText,
    );
    expect(recovered?.messages).toEqual([]);

    // Idempotent replay repairs state.json without creating a second chapter.
    expect((await store.commitConversationChapter(input)).status).toBe(
      'noop',
    );
    const repairedState = JSON.parse(
      await readFile(statePath, 'utf8'),
    ).compaction;
    expect(repairedState.boundary_seq).toBe(2);
    expect(repairedState.count_auto).toBe(1);
    expect(await store.countConversationChapters(session.id)).toBe(1);
  });

  it('keeps compaction lifecycle and provider attempts idempotent across restart', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Attempt metrics',
      provider: 'test',
      model: 'test',
    });
    const attemptInput = {
      session_id: session.id,
      run_id: RUN_ID,
      turn: 4,
      turn_telemetry_id: null,
      trigger: 'context_threshold',
      provider_chain: [{ provider: 'test', model: 'summary' }],
      prompt_tokens_before: 900,
      history_chars_before: 3_600,
      operation_id: 'compaction-start-run-one-turn-four',
    };
    const attemptId = await store.startCompactionAttempt(attemptInput);
    expect(attemptId).toMatch(UUID_PATTERN);
    expect(await store.startCompactionAttempt(attemptInput)).toBe(
      attemptId,
    );
    const finish = {
      status: 'deterministic_fallback' as const,
      strategy: 'deterministic' as const,
      summarizer_ran: true,
      history_chars_after: 1_800,
      pruned_messages: 3,
      error_message: 'summary provider unavailable',
      operation_id: `finish-${attemptId}`,
    };
    await store.finishCompactionAttempt(
      session.id,
      attemptId,
      finish,
    );
    await store.finishCompactionAttempt(
      session.id,
      attemptId,
      finish,
    );

    const providerInput = {
      session_id: session.id,
      run_id: RUN_ID,
      turn: 4,
      attempt: 1,
      provider: 'test',
      model: 'context',
      status: 200,
      ok: true,
      input_tokens: 100,
      output_tokens: 10,
      cached_tokens: 80,
      cost_usd: 0.001,
      duration_ms: 125.4,
      operation_id: 'provider-run-one-attempt-one',
    };
    const providerAttemptId =
      await store.recordProviderAttempt(providerInput);
    expect(providerAttemptId).toMatch(UUID_PATTERN);
    expect(await store.recordProviderAttempt(providerInput)).toBe(
      providerAttemptId,
    );

    await restart();
    expect(await store.getLatestCompactionAttempt(session.id)).toMatchObject(
      {
        id: attemptId,
        seq: 1,
        revision: 2,
        status: 'deterministic_fallback',
        strategy: 'deterministic',
        pruned_messages: 3,
      },
    );
    expect(await store.getConversationChapterStatus(session.id)).toMatchObject(
      {
        state: 'degraded',
        counters: {
          attempts: 1,
          deterministic_fallbacks: 1,
          failures: 1,
        },
      },
    );
    expect(await store.listProviderAttempts(session.id)).toEqual([
      expect.objectContaining({
        id: providerAttemptId,
        seq: 1,
        run_id: RUN_ID,
        attempt: 1,
        ok: true,
        duration_ms: 125,
      }),
    ]);
    expect(
      (await store.getMetricsSummary(session.id)).provider_attempts,
    ).toBe(1);
  });

  it('rejects invalid compaction and provider run relations without persistence', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Invalid attempt metrics',
      provider: 'test',
      model: 'test',
    });

    expect(
      await store.startCompactionAttempt({
        session_id: session.id,
        run_id: 'not-a-uuid',
        turn: 1,
      }),
    ).toBeNull();
    expect(
      await store.startCompactionAttempt({
        session_id: session.id,
        run_id: RUN_ID,
        turn: 1,
        turn_telemetry_id: 'not-a-telemetry-uuid',
      }),
    ).toBeNull();
    expect(
      await store.recordProviderAttempt({
        session_id: session.id,
        run_id: 'not-a-uuid',
        turn: 1,
        attempt: 1,
        provider: 'test',
        model: 'test',
        status: 500,
        ok: false,
        generation_id: 'opaque-generation-id',
        request_id: 'opaque-request-id',
        duration_ms: 1,
      }),
    ).toBeNull();

    expect(await store.listCompactionAttempts(session.id)).toEqual([]);
    expect(await store.listProviderAttempts(session.id)).toEqual([]);
  });
});
