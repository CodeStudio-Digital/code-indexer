import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ArtifactStore,
  FileSessionRepository,
  SessionCatalog,
  SessionLocator,
  type SessionId,
} from '@mcp/session-storage';
import {
  createBuilderCheckpointFile,
  findBuilderCheckpointFile,
  listBuilderCheckpointFiles,
  readBuilderCheckpointThumbnail,
  resolveBuilderCheckpointOwner,
  setBuilderCheckpointScreenshot,
  type BuilderCheckpointSessionStore,
} from '../../builder-checkpoint-files.js';

const cleanup: string[] = [];

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'builder-checkpoint-files-'));
  cleanup.push(root);
  const dataDir = join(root, 'data');
  const projectRoot = join(root, 'project');
  const otherRoot = join(root, 'other');
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
    mkdir(otherRoot, { recursive: true }),
  ]);
  const projectRoots = new Map([
    [71, projectRoot],
    [72, otherRoot],
  ]);
  const locator = new SessionLocator({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) => projectRoots.get(projectId),
      listProjectRoots: () =>
        [...projectRoots].map(([project_id, root_path]) => ({
          project_id,
          root_path,
        })),
    },
  });
  const repository = new FileSessionRepository({ locator });
  const catalog = new SessionCatalog({ locator, repository });
  const queues = new Map<string, Promise<void>>();
  const sessions: BuilderCheckpointSessionStore = {
    catalog,
    ensureCatalog: async () => {
      await catalog.refresh();
    },
    runSessionMutation: <T>(
      id: SessionId | string,
      task: () => Promise<T>,
    ): Promise<T> => {
      const key = String(id);
      const previous = queues.get(key) ?? Promise.resolve();
      const result = previous.then(task, task);
      const settled = result.then(
        () => undefined,
        () => undefined,
      );
      queues.set(key, settled);
      return result;
    },
  };
  const owner = await repository.createSession({
    kind: 'coder',
    scope: { kind: 'project', project_id: 71 },
    owner_project_id: 71,
    linked_projects: [{ project_id: 71 }],
    title: 'Builder',
  });
  await repository.createSession({
    kind: 'coder',
    scope: { kind: 'project', project_id: 72 },
    owner_project_id: 72,
    linked_projects: [{ project_id: 72 }],
    title: 'Other',
  });
  await catalog.refresh();
  return { sessions, owner };
}

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe('builder checkpoint filesystem repository', () => {
  it('uses UUID records inside the owning session and never crosses projects', async () => {
    const { sessions, owner } = await harness();
    const created = await createBuilderCheckpointFile(
      sessions,
      owner,
      {
        project_id: 71,
        commit_sha: 'a'.repeat(40),
        label: 'First',
        kind: 'auto',
      },
    );

    expect(created.checkpoint.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.checkpoint.session_id).toBe(owner.session.id);
    expect(await listBuilderCheckpointFiles(sessions, 72)).toEqual([]);
    expect(await listBuilderCheckpointFiles(sessions, 71)).toEqual([
      expect.objectContaining({
        id: created.checkpoint.id,
        session_id: owner.session.id,
        seq: 1,
      }),
    ]);
    expect(
      (
        await findBuilderCheckpointFile(
          sessions,
          71,
          created.checkpoint.id,
        )
      )?.checkpoint,
    ).toEqual(created.checkpoint);
  });

  it('stores and verifies thumbnails as session-local artifacts', async () => {
    const { sessions, owner } = await harness();
    const created = await createBuilderCheckpointFile(
      sessions,
      owner,
      {
        project_id: 71,
        commit_sha: 'b'.repeat(40),
        label: 'With image',
        kind: 'visual',
      },
    );
    const artifact = await new ArtifactStore({
      bundlePath: owner.location.bundle_path,
      sessionId: owner.location.session_id,
    }).put({
      kind: 'snapshot_blob',
      data: new Uint8Array([1, 2, 3, 4]),
      media_type: 'image/jpeg',
    });
    await setBuilderCheckpointScreenshot(
      sessions,
      owner,
      created.checkpoint.id,
      artifact,
    );

    const located = await findBuilderCheckpointFile(
      sessions,
      71,
      created.checkpoint.id,
    );
    expect(located).not.toBeNull();
    const thumbnail = readBuilderCheckpointThumbnail(located!);
    expect(thumbnail?.mediaType).toBe('image/jpeg');
    expect([...thumbnail!.bytes]).toEqual([1, 2, 3, 4]);
  });

  it('resolves only a linked bundle and fails closed without one', async () => {
    const { sessions, owner } = await harness();
    expect(
      await resolveBuilderCheckpointOwner(
        sessions,
        71,
        owner.session.id,
      ),
    ).toMatchObject({ session: { id: owner.session.id } });
    expect(
      await resolveBuilderCheckpointOwner(
        sessions,
        72,
        owner.session.id,
      ),
    ).toBeNull();
    expect(
      await resolveBuilderCheckpointOwner(
        sessions,
        999,
      ),
    ).toBeNull();
  });

  it('serializes concurrent records inside one session without cross-session SQL locks', async () => {
    const { sessions, owner } = await harness();
    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        createBuilderCheckpointFile(
          sessions,
          owner,
          {
            project_id: 71,
            commit_sha: index.toString(16).padStart(40, '0'),
            label: `Checkpoint ${index}`,
            kind: 'auto',
          },
        ),
      ),
    );
    const rows = await listBuilderCheckpointFiles(sessions, 71);
    expect(rows).toHaveLength(24);
    expect(rows.map((row) => row.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 24 }, (_, index) => index + 1),
    );
  });
});
