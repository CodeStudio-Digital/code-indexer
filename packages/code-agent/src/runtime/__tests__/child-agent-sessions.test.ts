/**
 * Creating a child-agent session: a real session nested under its parent,
 * with the relation and depth recorded and a snapshot of the parent's
 * authority that is never more permissive than the parent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { createChildAgentSession, type ChildAgentSessionOptions } from '../child-agent-sessions.js';

let root: string, sessions: FsSessionStore, options: ChildAgentSessionOptions;
const project = (id: number) => [1, 2].includes(id) ? { id, name: `Project ${id}`, root_path: join(root, `p${id}`) } : null;
const request = { key: 'call-1', title: 'Investigate cache', profile: 'implement' };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'child-agent-sessions-'));
  for (const path of ['data/sessions/global', 'p1', 'p2', 'wt']) await mkdir(join(root, path), { recursive: true });
  sessions = FsSessionStore.fromRoots({ dataDir: join(root, 'data'), projectRootResolver: {
    resolveProjectRoot: id => project(id)?.root_path,
    listProjectRoots: () => [1, 2].map(id => ({ project_id: id, root_path: project(id)!.root_path })),
  } });
  options = { sessions, project, validateModel: (provider) => { if (provider !== 'p1') throw new Error('Unavailable model'); } };
});
afterEach(async () => { await sessions.close(); await rm(root, { recursive: true, force: true }); });

async function parentWithAuthority(agent: string | null = 'build') {
  const parent = await sessions.createSession({ project_id: 1, title: 'Parent', provider: 'p1', model: 'm1', agent,
    worktree_path: join(root, 'wt'), reasoning_effort_override: 'high', thinking_enabled: true });
  await sessions.setSessionToolPermissionMode(parent.id, 'ask');
  await sessions.addToolPermissionGrant(parent.id, 'exec_command');
  await sessions.bulkSetSessionToolsDisabled(parent.id, ['web_fetch'], true);
  return parent;
}

describe('child-agent session creation', () => {
  it('nests a real session under the parent with a snapshot of its authority', async () => {
    const parent = await parentWithAuthority();
    const { child, created } = await createChildAgentSession(options, parent.id, request);
    await sessions.addToolPermissionGrant(parent.id, 'apply_patch');

    expect(created).toBe(true);
    expect(child).toMatchObject({ parent_session_id: parent.id, depth: 1, profile: 'implement', read_only: false, status: 'idle' });
    const stored = (await sessions.getSession(child.id))!;
    expect(stored).toMatchObject({ parent_session_id: parent.id, project_id: 1, title: 'Investigate cache', provider: 'p1', model: 'm1',
      agent: 'build', tool_permission_mode: 'ask', tool_permission_grants: '["exec_command"]', reasoning_effort_override: 'high',
      thinking_enabled: true, worktree_path: join(root, 'wt'), execution_mode_override: 'standard' });
    expect([...await sessions.getSessionDisabledTools(child.id)]).toEqual(['web_fetch']);
    const location = await sessions.getSessionLocation(child.id);
    const raw = JSON.parse(await readFile(join(location!.bundle_path, 'session.json'), 'utf8'));
    expect(raw.agent_relation).toEqual({ kind: 'child_agent', depth: 1 });
    expect(await sessions.listChildAgentSessions(parent.id)).toEqual([child]);
  });

  it('keeps a worktree only inside the parent project and never leaves the parent projects', async () => {
    // Only a global session links several projects.
    const parent = await sessions.createGlobalSession({ title: 'Global parent', provider: 'p1', model: 'm1', owner_project_id: 1,
      realProjects: [{ projectId: 1, rootPath: join(root, 'p1'), isPrimary: true }, { projectId: 2, rootPath: join(root, 'p2') }] });
    await sessions.setSessionWorktree(parent.id, join(root, 'wt'));
    const same = await createChildAgentSession(options, parent.id, { ...request, projectId: 1 });
    const other = await createChildAgentSession(options, parent.id, { ...request, key: 'call-2', projectId: 2 });
    expect(await sessions.getSession(same.child.id)).toMatchObject({ project_id: 1, is_global: false, worktree_path: join(root, 'wt') });
    expect(await sessions.getSession(other.child.id)).toMatchObject({ project_id: 2, is_global: false, worktree_path: null });
    await expect(createChildAgentSession(options, parent.id, { ...request, key: 'call-3', projectId: 3 })).rejects.toThrow(/project/i);
    const projectChild = await createChildAgentSession(options, (await parentWithAuthority()).id, { ...request, key: 'call-4', projectId: 2 }).catch((error: Error) => error);
    expect(String(projectChild)).toMatch(/project/i);
  });

  it('makes children of plan or read-only parents read-only too', async () => {
    for (const [agent, parentReadOnly] of [['plan', false], ['explore', false], ['build', true]] as const) {
      const parent = await parentWithAuthority(agent);
      await expect(createChildAgentSession(options, parent.id, { ...request, parentReadOnly })).rejects.toThrow(/read-only/);
      await expect(createChildAgentSession(options, parent.id, { ...request, profile: 'verify', parentReadOnly })).rejects.toThrow(/read-only/);
      expect(await sessions.listChildAgentSessions(parent.id)).toEqual([]);
      const { child } = await createChildAgentSession(options, parent.id, { ...request, profile: 'review', parentReadOnly });
      expect(child).toMatchObject({ profile: 'review', read_only: true });
      expect(await sessions.getSession(child.id)).toMatchObject({ agent: 'explore' });
    }
  });

  it('validates the profile and the model before creating anything', async () => {
    const parent = await parentWithAuthority();
    await expect(createChildAgentSession(options, parent.id, { ...request, profile: 'admin' })).rejects.toThrow(/profile/);
    await expect(createChildAgentSession(options, parent.id, { ...request, provider: 'p9' })).rejects.toThrow('Unavailable model');
    expect(await sessions.listChildAgentSessions(parent.id)).toEqual([]);
    const { child } = await createChildAgentSession(options, parent.id, { ...request, profile: 'reviewer' });
    expect(child.profile).toBe('review');
  });

  it('lets children create grandchildren up to depth 4 and refuses the fifth level', async () => {
    let current = (await parentWithAuthority()).id;
    for (let depth = 1; depth <= 4; depth++) {
      const { child } = await createChildAgentSession(options, current, { ...request, key: `level-${depth}` });
      expect(child.depth).toBe(depth);
      current = child.id;
    }
    await expect(createChildAgentSession(options, current, { ...request, key: 'level-5' })).rejects.toThrow(/depth/);
    expect(await sessions.listChildAgentSessions(current)).toEqual([]);
  });
});
