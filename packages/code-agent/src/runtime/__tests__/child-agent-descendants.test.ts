/**
 * A descendant is never more capable than the child agent that creates it:
 * capability follows the profile allowlists (read < shell < write < all),
 * and a read-only posture passes down every level up to the depth cap.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { createChildAgentSession, type ChildAgentSessionOptions } from '../child-agent-sessions.js';

let root: string, sessions: FsSessionStore, options: ChildAgentSessionOptions, rootId: string;
const project = (id: number) => id === 1 ? { id, name: 'Project 1', root_path: join(root, 'p1') } : null;
let counter = 0;

async function child(parentId: string, profile: string) {
  return (await createChildAgentSession(options, parentId, { key: `k${++counter}`, title: `${profile} child`, profile })).child;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'child-agent-descendants-'));
  for (const path of ['data/sessions/global', 'p1']) await mkdir(join(root, path), { recursive: true });
  sessions = FsSessionStore.fromRoots({ dataDir: join(root, 'data'), projectRootResolver: {
    resolveProjectRoot: id => project(id)?.root_path,
    listProjectRoots: () => [{ project_id: 1, root_path: join(root, 'p1') }],
  } });
  options = { sessions, project };
  rootId = (await sessions.createSession({ project_id: 1, title: 'Root', provider: 'p1', model: 'm1', agent: 'build' })).id;
});
afterEach(async () => { await sessions.close(); await rm(root, { recursive: true, force: true }); });

describe('child-agent descendants', () => {
  it('a read-level child creates only read-level descendants, which become read-only', async () => {
    const explorer = await child(rootId, 'explore');
    expect(explorer.read_only).toBe(false);
    for (const profile of ['implement', 'full', 'verify']) {
      await expect(child(explorer.id, profile)).rejects.toThrow(/more capable/);
    }
    const reviewer = await child(explorer.id, 'review');
    expect(reviewer).toMatchObject({ profile: 'review', read_only: true });
    expect(await sessions.getSession(reviewer.id)).toMatchObject({ agent: 'explore' });
    expect(await sessions.listChildAgentSessions(explorer.id)).toHaveLength(1);
  });

  it('a verify child cannot create an implementer, an implementer can create readers', async () => {
    const verifier = await child(rootId, 'verify');
    await expect(child(verifier.id, 'implement')).rejects.toThrow(/more capable/);
    expect((await child(verifier.id, 'verify')).profile).toBe('verify');
    const implementer = await child(rootId, 'implement');
    await expect(child(implementer.id, 'full')).rejects.toThrow(/more capable/);
    expect(await child(implementer.id, 'explore')).toMatchObject({ profile: 'explore', read_only: false });
  });

  it('a chain of four levels never goes up in capability', async () => {
    const chain = [await child(rootId, 'full')];
    for (const profile of ['implement', 'verify', 'explore']) chain.push(await child(chain.at(-1)!.id, profile));
    expect(chain.map(step => [step.depth, step.profile])).toEqual([[1, 'full'], [2, 'implement'], [3, 'verify'], [4, 'explore']]);
    await expect(child(chain[2]!.id, 'implement')).rejects.toThrow(/more capable/);
    await expect(child(chain[3]!.id, 'explore')).rejects.toThrow(/depth/);
  });

  it('keeps a read-only posture through every level', async () => {
    const readOnlyRoot = (await sessions.createSession({ project_id: 1, title: 'Plan', provider: 'p1', model: 'm1', agent: 'plan' })).id;
    const first = await child(readOnlyRoot, 'explore');
    const second = await child(first.id, 'review');
    expect([first.read_only, second.read_only]).toEqual([true, true]);
    await expect(child(second.id, 'verify')).rejects.toThrow(/read-only|more capable/);
  });
});
