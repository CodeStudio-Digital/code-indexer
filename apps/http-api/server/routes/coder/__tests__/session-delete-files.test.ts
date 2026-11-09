import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { deleteCoderSession } from '../delete-session.js';

let root: string;
let dataDir: string;
let projectRoot: string;
let apiStore: FsSessionStore;
let workerStore: FsSessionStore;
function openStore(owner: string) {
  return FsSessionStore.fromRoots({ dataDir, writerOwnerId: owner,
    projectRootResolver: { resolveProjectRoot: id => id === 7 ? projectRoot : null,
      listProjectRoots: () => [{ project_id: 7, root_path: projectRoot }] },
  });
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'chat-delete-files-'));
  dataDir = join(root, 'data'); projectRoot = join(root, 'project');
  await Promise.all([mkdir(dataDir), mkdir(projectRoot)]);
  vi.stubEnv('MCP_DATA_DIR', dataDir);
  workerStore = openStore('worker-fixture'); apiStore = openStore('api-fixture');
});
afterEach(async () => {
  await workerStore.close(); await apiStore.close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('complete chat-owned file deletion', () => {
  it.each(['project', 'global'])('drains the %s writer and purges the entire bundle and spool', async scope => {
    const input = { title: 'delete fixture', provider: 'fixture', model: 'fixture' };
    const session = scope === 'project'
      ? await workerStore.createSession({ ...input, project_id: 7 })
      : await workerStore.createGlobalSession({ ...input, realProjects: [{ projectId: 7, rootPath: projectRoot }] });
    await workerStore.appendMessage({ session_id: session.id, operation_id: 'initial-message', message: {
      role: 'user', content: [{ type: 'text', text: 'private conversation fixture' }],
    } });
    const location = (await workerStore.getSessionLocation(session.id))!;
    for (const name of ['attachments', 'logs', 'snapshots', 'tool_outputs', 'subagents']) {
      await mkdir(join(location.bundle_path, name), { recursive: true });
      await writeFile(join(location.bundle_path, name, 'fixture.bin'), 'owned fixture');
    }
    const output = join(dataDir, 'process-output', createHash('sha256').update(session.id).digest('hex'));
    await mkdir(output, { recursive: true }); await writeFile(join(output, 'fixture.log'), 'output');
    const kept = await workerStore.createSession({ ...input, project_id: 7, title: 'keep me' });
    const source = join(projectRoot, 'source.ts'); await writeFile(source, 'keep source');
    await apiStore.ensureCatalog();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const workers = { abort: vi.fn(async () => undefined), evict: vi.fn(async () => { await barrier; await workerStore.close(); }) };
    const pending = deleteCoderSession(session.id, true, apiStore, workers);
    await vi.waitFor(() => expect(workers.evict).toHaveBeenCalledOnce());
    await expect(access(location.bundle_path)).resolves.toBeUndefined();
    release();
    await expect(pending).resolves.toEqual({ session_id: session.id, permanent: true });
    await expect(access(location.bundle_path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(output)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await apiStore.listTrashedSessions(location.scope)).toEqual([]);
    expect(await apiStore.getSession(session.id)).toBeNull();
    expect(await apiStore.getSession(kept.id)).toMatchObject({ title: 'keep me' });
    expect(await readFile(source, 'utf8')).toBe('keep source');
  });

  it('preserves the bundle on an unconfirmed writer shutdown', async () => {
    const session = await workerStore.createSession({ project_id: 7, title: 'retained', provider: 'fixture', model: 'fixture' });
    const location = (await workerStore.getSessionLocation(session.id))!;
    await expect(deleteCoderSession(session.id, true, apiStore, {
      abort: vi.fn(async () => { throw new Error('not responsive'); }),
      evict: vi.fn(async () => { throw new Error('stop unconfirmed'); }),
    })).rejects.toThrow('stop unconfirmed');
    await expect(access(join(location.bundle_path, 'session.json'))).resolves.toBeUndefined();
  });
});
