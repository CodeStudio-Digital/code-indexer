import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpRouter } from '@mcp/shared/http/router.js';
import { afterEach, describe, expect, it } from 'vitest';
import { asSessionId } from '@mcp/session-storage';
import { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import { mountCoderSnapshotRoutes } from '../snapshot.js';
import { mountToolSnapshotRoutes } from '../tool-snapshot.js';
import type { ServerDeps } from '../../../deps.js';

const SESSION_ID = asSessionId('88888888-8888-4888-8888-888888888888');
const FOREIGN_SESSION_ID = asSessionId(
  '88888888-8888-4888-8888-888888888889',
);

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'round-routes-fs-'));
  const dataDir = join(temporaryRoot, 'data');
  const projectRoot = join(temporaryRoot, 'project');
  await Promise.all([mkdir(dataDir), mkdir(projectRoot)]);
  const store = FsSessionStore.fromRoots({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) =>
        projectId === 10 ? projectRoot : null,
      listProjectRoots: () => [
        { project_id: 10, root_path: projectRoot },
      ],
    },
  });
  await store.createSession({
    id: SESSION_ID,
    project_id: 10,
    title: 'Round route',
    provider: 'test',
    model: 'test',
  });
  await store.createSession({
    id: FOREIGN_SESSION_ID,
    project_id: 10,
    title: 'Foreign round route',
    provider: 'test',
    model: 'test',
  });
  await store.appendMessage({
    session_id: SESSION_ID,
    operation_id: 'round-user-message',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Change a.ts' }],
    },
  });
  const app = new HttpRouter();
  mountCoderSnapshotRoutes(app, {
    sessionStore: store,
    db: {
      getProject: () => ({ root_path: projectRoot }),
    },
    pipelineProviderResolver: {},
  } as unknown as ServerDeps);
  cleanups.push(async () => {
    await store.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  return { app, store };
}

async function insertBaseline(
  store: FsSessionStore,
  input: {
    sessionId: typeof SESSION_ID;
    projectId: number;
    filePath: string;
  },
) {
  return (
    await store.recordBaselineAndEdit(
      {
        session_kind: 'coder',
        session_id: input.sessionId,
        project_id: input.projectId,
        file_path: input.filePath,
        content_before: 'before\n',
        rollback_content: 'before\n',
        existed_before: true,
        baseline_hash: 'hash',
        oversized: false,
      },
      {
        turn_number: 1,
        tool_name: 'edit_file',
        content_after_hash: 'after',
        was_delete: false,
      },
    )
  ).baseline;
}

describe('coder per-round snapshot routes', () => {
  it('serves invocation-local counts and line numbers without crossing session or company ownership', async () => {
    const { app, store } = await setup();
    mountToolSnapshotRoutes(app, store, async id => id === SESSION_ID ? [SESSION_ID] : [FOREIGN_SESSION_ID]);
    const baseline = await insertBaseline(store, { sessionId: SESSION_ID, projectId: 10, filePath: 'a.ts' });
    await store.recordToolSnapshotMutation!({ session_kind: 'coder', session_id: SESSION_ID, tool_use_id: 'call-1',
      round_message_id: 1, global_baseline_id: baseline.id, project_id: 10, file_path: 'a.ts',
      content_before: 'before\n', content_after: 'after\nextra\n', existed_before: true, existed_after: true, oversized: false });
    const url = `/api/coder/sessions/${SESSION_ID}/snapshot/tool/call-1`;
    expect(await (await app.request(url)).json()).toMatchObject({ files: [{ addedLines: 2, removedLines: 1, fileIndex: 0 }] });
    expect(await (await app.request(`${url}/file/0/diff`)).json()).toMatchObject({ currentContent: 'after\nextra\n',
      hunks: [{ lines: [{ type: 'add', newLine: 1 }, { type: 'add', newLine: 2 }, { type: 'remove', oldLine: 1 }] }] });
    expect((await app.request(`${url}/file/-1/diff`)).status).toBe(404);
    expect((await app.request(`${url.replace(SESSION_ID, FOREIGN_SESSION_ID)}/file/0/diff`)).status).toBe(404);
    expect(await (await app.request(url.replace('/coder/', '/company/'))).json()).toMatchObject({ files: [{ addedLines: 2 }] });
    expect(await (await app.request(url.replace('/coder/', '/company/').replace(SESSION_ID, FOREIGN_SESSION_ID))).json()).toEqual({ files: [] });
  });

  it('lists a frozen round only when the user message and global baseline share its context', async () => {
    const { app, store } = await setup();
    const baseline = await insertBaseline(store, {
      sessionId: SESSION_ID,
      projectId: 10,
      filePath: 'a.ts',
    });
    await store.recordRoundSnapshotMutation({
      session_kind: 'coder',
      session_id: SESSION_ID,
      round_message_id: 1,
      global_baseline_id: baseline.id,
      project_id: 10,
      file_path: 'a.ts',
      content_before: 'before\n',
      existed_before: true,
      content_after: 'after\n',
      existed_after: true,
      oversized: false,
    });

    const response = await app.request(
      `/api/coder/sessions/${SESSION_ID}/snapshot/round/1`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      roundSeq: 1,
      files: [
        expect.objectContaining({
          filePath: 'a.ts',
          globalBaselineId: baseline.id,
          addedLines: 1,
          removedLines: 1,
        }),
      ],
    });
  });

  it('rejects a round snapshot linked to a baseline from another session', async () => {
    const { app, store } = await setup();
    const foreignBaseline = await insertBaseline(store, {
      sessionId: FOREIGN_SESSION_ID,
      projectId: 10,
      filePath: 'a.ts',
    });
    await store.recordRoundSnapshotMutation({
      session_kind: 'coder',
      session_id: SESSION_ID,
      round_message_id: 1,
      global_baseline_id: foreignBaseline.id,
      project_id: 10,
      file_path: 'a.ts',
      content_before: 'before\n',
      existed_before: true,
      content_after: 'after\n',
      existed_after: true,
      oversized: false,
    });

    const response = await app.request(
      `/api/coder/sessions/${SESSION_ID}/snapshot/round/1`,
    );

    expect(response.status).toBe(404);
  });
});
