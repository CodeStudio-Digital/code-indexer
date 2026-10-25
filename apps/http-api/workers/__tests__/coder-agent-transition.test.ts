import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SessionLeaseHeldError } from '@mcp/session-storage';
import { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { materializePendingAgentTransition } from '../coder-agent-transition.js';

let root: string;
const stores: FsSessionStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  if (root) await rm(root, { recursive: true, force: true });
});

it('persists mode changes through the writer owner across cold and warm turns', async () => {
  root = await mkdtemp(join(tmpdir(), 'coder-mode-writer-'));
  const projectRoot = join(root, 'project');
  await mkdir(projectRoot);
  const openStore = (writerOwnerId: string) => {
    const store = FsSessionStore.fromRoots({
      dataDir: join(root, 'data'), writerOwnerId,
      projectRootResolver: {
        resolveProjectRoot: id => id === 7 ? projectRoot : null,
        listProjectRoots: () => [{ project_id: 7, root_path: projectRoot }],
      },
    });
    stores.push(store);
    return store;
  };
  const main = openStore('http-main');
  const session = await main.createSession({
    project_id: 7, title: 'Mode changes', provider: 'test', model: 'test', agent: 'explore',
  });
  await main.stageManualAgentTransition(session.id, 'build');
  const location = (await main.getSessionLocation(session.id))!;
  await main.repository.closeSession(location);
  const worker = openStore('coder-worker:test');
  await worker.repository.primeSession(location);

  for (const [index, mode] of ['build', 'plan', 'explore', 'build'].entries()) {
    if (index > 0) await worker.stageManualAgentTransition(session.id, mode);
    // Reproduce the old HTTP path while the warm worker retains its lease.
    await expect(materializePendingAgentTransition(main, session.id))
      .rejects.toBeInstanceOf(SessionLeaseHeldError);
    await materializePendingAgentTransition(worker, session.id);
    await materializePendingAgentTransition(worker, session.id);
    expect(await worker.getPendingAgentTransition(session.id)).toBeNull();
    const { messages } = (await worker.loadSessionWithMessages(session.id))!;
    expect(messages).toHaveLength(index + 1);
    expect(messages.at(-1)).toMatchObject({
      role: 'user', isMeta: true,
      content: [{ type: 'text', text: expect.stringContaining(`The active agent is now ${mode}.`) }],
    });
    expect(await worker.listSessionInputs(session.id)).toHaveLength(index + 1);
  }
}, 15_000);
