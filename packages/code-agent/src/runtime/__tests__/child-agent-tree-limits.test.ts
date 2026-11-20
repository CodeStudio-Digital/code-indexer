/**
 * Tree-wide creation limits: a tree may create at most 24 child agents in a
 * rolling 24 hours (a creation loop stops even when each child stays inside
 * the concurrency limit), and a child agent cannot escape the depth and
 * capability rules through the peer network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { ChatCollaborationStore } from '@mcp/session-storage/collaboration/store.js';
import { createChildAgentSession, type ChildAgentSessionOptions } from '../child-agent-sessions.js';
import { MAX_TREE_CHILDREN_PER_WINDOW } from '../child-agent-tree.js';
import { SessionNetwork } from '../session-network.js';

let root: string, sessions: FsSessionStore, rootId: string, clock: Date;
const project = (id: number) => id === 1 ? { id, name: 'Project 1', root_path: join(root, 'p1') } : null;
const options = (): ChildAgentSessionOptions => ({ sessions, project, now: () => clock });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'child-agent-tree-limits-'));
  for (const path of ['data/sessions/global', 'p1']) await mkdir(join(root, path), { recursive: true });
  sessions = FsSessionStore.fromRoots({ dataDir: join(root, 'data'), projectRootResolver: {
    resolveProjectRoot: id => project(id)?.root_path, listProjectRoots: () => [{ project_id: 1, root_path: join(root, 'p1') }] } });
  rootId = (await sessions.createSession({ project_id: 1, title: 'Root', provider: 'p1', model: 'm1', agent: 'build' })).id;
  clock = new Date();
});
afterEach(async () => { await sessions.close(); await rm(root, { recursive: true, force: true }); });

describe('child-agent tree limits', () => {
  it('caps the children a tree creates in a rolling window, all levels counted', async () => {
    const first = (await createChildAgentSession(options(), rootId, { key: 'k0', title: 'k0', profile: 'implement' })).child;
    for (let index = 1; index < MAX_TREE_CHILDREN_PER_WINDOW; index++) {
      const parent = index % 2 === 0 ? rootId : first.id;
      await createChildAgentSession(options(), parent, { key: `k${index}`, title: `k${index}`, profile: 'explore' });
    }
    await expect(createChildAgentSession(options(), first.id, { key: 'over', title: 'over', profile: 'explore' })).rejects.toThrow(/limit reached/);
    await expect(createChildAgentSession(options(), rootId, { key: 'over', title: 'over', profile: 'explore' })).rejects.toThrow(/limit reached/);
    // A retried creation adopts its existing child instead of counting again.
    expect((await createChildAgentSession(options(), rootId, { key: 'k2', title: 'k2', profile: 'explore' })).created).toBe(false);
    // A day later the window has moved on.
    clock = new Date(clock.getTime() + 25 * 60 * 60 * 1000);
    expect((await createChildAgentSession(options(), rootId, { key: 'later', title: 'later', profile: 'explore' })).created).toBe(true);
  });

  it('refuses peer-network chat creation from inside a child agent', async () => {
    const mailbox = new ChatCollaborationStore(join(root, 'data'));
    await mailbox.init();
    const network = new SessionNetwork({ sessions, mailbox, project });
    await network.settings(rootId, { enabled: true });
    const childId = (await createChildAgentSession(options(), rootId, { key: 'c', title: 'c', profile: 'explore' })).child.id;
    await network.settings(childId, { enabled: true });
    const input = { title: 'Peer', role: 'Do anything', start: false };
    await expect(network.create(childId, input, 'peer')).rejects.toThrow(/child agent/);
    await expect(network.validateTeam(childId, [input], 'team')).rejects.toThrow(/child agent/);
    // The root itself still creates peers exactly as before.
    expect((await network.create(rootId, input, 'peer')).title).toBe('Peer');
  });
});
