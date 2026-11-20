/**
 * Child-agent creation is idempotent per creation key and atomic: the bundle
 * is published with all inherited state at once, so a failure around it
 * leaves either nothing or a complete child that a retry adopts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { createChildAgentSession, type ChildAgentSessionOptions } from '../child-agent-sessions.js';

let root: string, sessions: FsSessionStore, parentId: string;
const project = (id: number) => id === 1 ? { id, name: 'Project 1', root_path: join(root, 'p1') } : null;
const request = { key: 'call-1', title: 'Check the build', profile: 'verify' };

function withCreateSession(createSession: FsSessionStore['createSession']): ChildAgentSessionOptions {
  return { project, sessions: {
    createSession,
    getSession: (id) => sessions.getSession(id),
    getSessionDisabledTools: (id) => sessions.getSessionDisabledTools(id),
    getChildAgentSession: (id) => sessions.getChildAgentSession(id),
    listChildAgentSessions: (id) => sessions.listChildAgentSessions(id),
  } };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'child-agent-retry-'));
  for (const path of ['data/sessions/global', 'p1']) await mkdir(join(root, path), { recursive: true });
  sessions = FsSessionStore.fromRoots({ dataDir: join(root, 'data'), projectRootResolver: {
    resolveProjectRoot: id => project(id)?.root_path,
    listProjectRoots: () => [{ project_id: 1, root_path: join(root, 'p1') }],
  } });
  const parent = await sessions.createSession({ project_id: 1, title: 'Parent', provider: 'p1', model: 'm1' });
  await sessions.setSessionToolPermissionMode(parent.id, 'auto');
  parentId = parent.id;
});
afterEach(async () => { await sessions.close(); await rm(root, { recursive: true, force: true }); });

describe('child-agent creation retries', () => {
  it('returns the same child for the same key and refuses the key with other settings', async () => {
    const options = { sessions, project };
    const first = await createChildAgentSession(options, parentId, request);
    const again = await createChildAgentSession(options, parentId, request);
    expect(again).toEqual({ child: first.child, created: false });
    await expect(createChildAgentSession(options, parentId, { ...request, title: 'Something else' })).rejects.toThrow(/key reused/);
    await expect(createChildAgentSession(options, parentId, { ...request, profile: 'explore' })).rejects.toThrow(/key reused/);
    expect(await sessions.listChildAgentSessions(parentId)).toHaveLength(1);
  });

  it('adopts the complete child when a failure follows its publication', async () => {
    const failing = withCreateSession(async (input) => {
      await sessions.createSession(input);
      throw new Error('injected failure after publishing the child');
    });
    await expect(createChildAgentSession(failing, parentId, request)).rejects.toThrow('injected failure');

    const retried = await createChildAgentSession({ sessions, project }, parentId, request);
    expect(retried.created).toBe(false);
    expect(retried.child).toMatchObject({ depth: 1, profile: 'verify', read_only: false });
    expect(await sessions.getSession(retried.child.id)).toMatchObject({ tool_permission_mode: 'auto', parent_session_id: parentId });
    expect(await sessions.listChildAgentSessions(parentId)).toHaveLength(1);
  });

  it('leaves nothing behind when the publication itself fails', async () => {
    const failing = withCreateSession(async () => { throw new Error('injected failure before publishing'); });
    await expect(createChildAgentSession(failing, parentId, request)).rejects.toThrow('injected failure');
    expect(await sessions.listChildAgentSessions(parentId)).toEqual([]);
    expect((await sessions.listSessions(1)).map(session => session.id)).toEqual([parentId]);
    const { created } = await createChildAgentSession({ sessions, project }, parentId, request);
    expect(created).toBe(true);
  });
});
