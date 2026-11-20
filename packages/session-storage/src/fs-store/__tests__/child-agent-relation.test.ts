/**
 * The explicit parent → child-agent relation is additive: bundles without it
 * (every session on disk today, forks, Company sessions) read, list and
 * project exactly as before, and nothing is inferred from parent_session_id.
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsSessionStore } from '../fs-session-store.js';
import {
  canCreateChildAgent,
  MAX_CHILD_AGENT_DEPTH,
  nextChildAgentRelation,
  readChildAgentRelation,
} from '../../child-agent-relation.js';

let root: string;
let dataDir: string;
let projectRoot: string;
let store: FsSessionStore;

function openStore(): FsSessionStore {
  return FsSessionStore.fromRoots({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) => (projectId === 7 ? projectRoot : null),
      listProjectRoots: () => [{ project_id: 7, root_path: projectRoot }],
    },
  });
}

async function rawSessionJson(id: string): Promise<Record<string, unknown>> {
  const location = await store.getSessionLocation(id);
  return JSON.parse(await readFile(join(location!.bundle_path, 'session.json'), 'utf8')) as Record<string, unknown>;
}

const base = { project_id: 7, provider: 'test', model: 'test' } as const;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'child-agent-relation-'));
  dataDir = join(root, 'data');
  projectRoot = join(root, 'project');
  // The global root exists in a real install; without it the catalog reports
  // a missing-root issue unrelated to the bundles under test.
  await Promise.all([mkdir(join(dataDir, 'sessions', 'global'), { recursive: true }), mkdir(projectRoot)]);
  store = openStore();
});

afterEach(async () => {
  await store.close();
  await rm(root, { recursive: true, force: true });
});

describe('child-agent relation', () => {
  it('leaves bundles without the field exactly as today and never reads them as child agents', async () => {
    const parent = await store.createSession({ ...base, title: 'Parent' });
    // A fork-like child: parent_session_id set, and a copied metadata bag
    // carrying a look-alike key. Neither may create the relation.
    const fork = await store.createSession({
      ...base, title: 'Fork', parent_session_id: parent.id,
      metadata: { agent_relation: { kind: 'child_agent', depth: 1 } },
    });

    // Same session.json keys as before the relation existed.
    expect(Object.keys(await rawSessionJson(parent.id))).toEqual([
      'schema_version', 'id', 'kind', 'created_at', 'updated_at', 'storage_scope', 'owner_project_id',
      'linked_projects', 'parent_session_id', 'provider', 'model', 'title', 'favorite', 'archived_at', 'metadata',
    ]);
    expect(await rawSessionJson(fork.id)).not.toHaveProperty('agent_relation');
    expect(parent).not.toHaveProperty('agent_relation');
    expect(readChildAgentRelation((await store.catalog.get(fork.id))!.session)).toBeNull();
    expect(await store.listChildAgentSessions(parent.id)).toEqual([]);
    expect((await store.listSessions(7)).map((session) => session.id).sort()).toEqual([parent.id, fork.id].sort());
  });

  it('persists the relation only when given and lists children by parent', async () => {
    const parent = await store.createSession({ ...base, title: 'Parent' });
    const other = await store.createSession({ ...base, title: 'Other parent' });
    const child = await store.createSession({
      ...base, title: 'Child', parent_session_id: parent.id, agent_relation: nextChildAgentRelation(null),
    });
    await store.createSession({ ...base, title: 'Other child', parent_session_id: other.id, agent_relation: { kind: 'child_agent', depth: 1 } });

    expect(await rawSessionJson(child.id)).toMatchObject({ parent_session_id: parent.id, agent_relation: { kind: 'child_agent', depth: 1 } });
    // The projection the sidebar reads is unchanged for children too.
    expect(child).not.toHaveProperty('agent_relation');

    const expected = [{ id: child.id, parent_session_id: parent.id, depth: 1, status: 'idle', is_archived: false }];
    expect(await store.listChildAgentSessions(parent.id)).toMatchObject(expected);

    // A fresh store rescans the bundles from disk: same answer, no scan issues.
    await store.close();
    store = openStore();
    expect(await store.listChildAgentSessions(parent.id)).toMatchObject(expected);
    expect(store.catalog.issues).toEqual([]);
  });

  it('rejects a malformed relation instead of writing it', async () => {
    const parent = await store.createSession({ ...base, title: 'Parent' });
    await expect(store.createSession({ ...base, title: 'No parent', agent_relation: { kind: 'child_agent', depth: 1 } }))
      .rejects.toThrow(/parent_session_id/);
    await expect(store.createSession({
      ...base, title: 'Depth 0', parent_session_id: parent.id, agent_relation: { kind: 'child_agent', depth: 0 },
    })).rejects.toThrow(/depth/);
  });
});

describe('child-agent depth limit', () => {
  // Owner decision: grandchildren are allowed; the cap only stops a runaway
  // creation loop. Concurrency is bounded per tree, not by depth.
  it('lets children create grandchildren up to a safety cap of 4 levels', () => {
    expect(MAX_CHILD_AGENT_DEPTH).toBe(4);
    expect(canCreateChildAgent(null)).toBe(true);
    expect(canCreateChildAgent({ kind: 'child_agent', depth: 1 })).toBe(true);
    expect(canCreateChildAgent({ kind: 'child_agent', depth: 3 })).toBe(true);
    expect(canCreateChildAgent({ kind: 'child_agent', depth: 4 })).toBe(false);
    expect(nextChildAgentRelation({ kind: 'child_agent', depth: 1 })).toEqual({ kind: 'child_agent', depth: 2 });
  });

  it('reads only a well-formed relation on a session that has a parent', () => {
    const parentId = '11111111-1111-4111-8111-111111111111';
    expect(readChildAgentRelation({ parent_session_id: parentId })).toBeNull();
    expect(readChildAgentRelation({ parent_session_id: null, agent_relation: { kind: 'child_agent', depth: 1 } })).toBeNull();
    expect(readChildAgentRelation({ parent_session_id: parentId, agent_relation: { kind: 'fork', depth: 1 } as never })).toBeNull();
    expect(readChildAgentRelation({ parent_session_id: parentId, agent_relation: { kind: 'child_agent', depth: 1.5 } })).toBeNull();
    expect(readChildAgentRelation({ parent_session_id: parentId, agent_relation: { kind: 'child_agent', depth: 1 } }))
      .toEqual({ kind: 'child_agent', depth: 1 });
  });
});
