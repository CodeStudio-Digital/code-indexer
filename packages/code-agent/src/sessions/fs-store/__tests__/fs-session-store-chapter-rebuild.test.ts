import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsSessionStore } from '../fs-session-store.js';

let temporaryRoot: string;
let dataDir: string;
let projectRoot: string;
let store: FsSessionStore;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'mcp-fs-chapter-rebuild-'));
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

describe('filesystem conversation chapter rebuild', () => {
  it('reads archived rows and replaces rebuild chapters idempotently', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Rebuild',
      provider: 'test',
      model: 'test',
    });
    for (let seq = 1; seq <= 4; seq += 1) {
      await store.appendMessage({
        session_id: session.id,
        operation_id: `message-${seq}`,
        message: {
          role: seq % 2 === 1 ? 'user' : 'assistant',
          content: [{ type: 'text', text: `message ${seq}` }],
        },
      });
    }
    await store.setCompactionBoundary(
      session.id,
      'archived summary',
      2,
      'manual',
    );

    expect(
      (await store.loadSessionWithMessages(session.id))?.message_rows.map(
        (row) => row.seq,
      ),
    ).toEqual([3, 4]);
    expect(
      (await store.loadAllSessionMessages(session.id))?.message_rows.map(
        (row) => row.seq,
      ),
    ).toEqual([1, 2, 3, 4]);

    const whole = [{
      startMessageSeq: 1,
      endMessageSeq: 2,
      trigger: 'user_rebuild:archived',
      title: 'Archived span',
      chapterJson: '{"title":"Archived span"}',
      chapterText: 'Archived span text',
      resumeJson: '{"next":"continue"}',
      resumeText: 'Continue.',
      version: 3,
      chapterKind: 'rebuild' as const,
      advancesContextBoundary: false,
    }];
    const first = await store.insertRebuiltConversationChapters(
      session.id,
      whole,
    );
    const replay = await store.insertRebuiltConversationChapters(
      session.id,
      whole,
    );
    expect(replay).toMatchObject({
      superseded_count: 0,
      items: [{ id: first.items[0]!.id }],
    });

    const split = await store.insertRebuiltConversationChapters(
      session.id,
      [
        {
          ...whole[0]!,
          endMessageSeq: 1,
          title: 'First message',
        },
        {
          ...whole[0]!,
          startMessageSeq: 2,
          title: 'Second message',
        },
      ],
    );
    expect(split.superseded_count).toBe(1);
    expect(split.items).toHaveLength(2);
    expect(
      (await store.listConversationChapters(session.id)).items,
    ).toHaveLength(2);
    expect(
      (
        await store.listConversationChapters(session.id, {
          includeSuperseded: true,
        })
      ).items,
    ).toHaveLength(3);
  });
});
