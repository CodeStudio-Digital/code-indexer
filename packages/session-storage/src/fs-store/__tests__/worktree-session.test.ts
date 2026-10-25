import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { FsSessionStore } from '../fs-session-store.js';

it('publishes worktree scope atomically and preserves it through reopen, duplicate and fork', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codestudio-wt-sessions-'));
  const project = join(root, 'project');
  await mkdir(project);
  const options = { dataDir: join(root, 'data'), projectRootResolver: {
    resolveProjectRoot: () => project,
    listProjectRoots: () => [{ project_id: 1, root_path: project }],
  } };
  let store = FsSessionStore.fromRoots(options);
  try {
    const path = join(project, '.mcp-indexer', 'worktrees', 'feature');
    const session = await store.createSession({ project_id: 1, title: 'Feature', provider: 'test', model: 'test', worktree_path: path });
    expect(session.worktree_path).toBe(path);
    const normal = await store.createSession({ project_id: 1, title: 'Main', provider: 'test', model: 'test' });
    expect(normal.worktree_path).toBeNull();
    await store.close();
    store = FsSessionStore.fromRoots(options);
    expect((await store.getSession(session.id))?.worktree_path).toBe(path);
    expect((await store.duplicateSession(session.id)).worktree_path).toBe(path);
    const seq = await store.appendMessage({ session_id: session.id, operation_id: 'first-message',
      message: { role: 'user', content: [{ type: 'text', text: 'work here' }] } });
    expect((await store.forkSessionBeforeSeq(session.id, seq)).session.worktree_path).toBe(path);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
