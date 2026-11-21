/**
 * A child agent runs on its profile's configured model and effort (the
 * subagent.ts targets, keyed by the creator's provider), unless the creation
 * request pins its own; without a target it keeps the creator's.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { createChildAgentSession, type ChildAgentSessionOptions } from '../child-agent-sessions.js';

let root: string, sessions: FsSessionStore, parentId: string;
const project = (id: number) => id === 1 ? { id, name: 'Project 1', root_path: join(root, 'p1') } : null;
const targets: Record<string, { provider: string; model: string; effort: string } | undefined> = {
  explore: { provider: 'cheap', model: 'fast-1', effort: 'low' },
  implement: { provider: 'strong', model: 'code-2', effort: 'high' },
  verify: { provider: 'cheap', model: 'fast-1', effort: 'medium' },
  review: { provider: 'strong', model: 'review-3', effort: 'xhigh' },
  full: undefined,
};
const seen: Array<[string, string]> = [];
const options = (): ChildAgentSessionOptions => ({ sessions, project, resolveProfileTarget: (creator, profile) => {
  seen.push([creator, profile]);
  return targets[profile];
} });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'child-agent-models-'));
  for (const path of ['data/sessions/global', 'p1']) await mkdir(join(root, path), { recursive: true });
  sessions = FsSessionStore.fromRoots({ dataDir: join(root, 'data'), projectRootResolver: {
    resolveProjectRoot: id => project(id)?.root_path,
    listProjectRoots: () => [{ project_id: 1, root_path: join(root, 'p1') }],
  } });
  parentId = (await sessions.createSession({ project_id: 1, title: 'Parent', provider: 'parent-p', model: 'parent-m',
    reasoning_effort_override: 'medium' })).id;
  seen.length = 0;
});
afterEach(async () => { await sessions.close(); await rm(root, { recursive: true, force: true }); });

describe('child-agent model and effort', () => {
  it.each(Object.keys(targets))('%s uses its configured target, or the creator model without one', async (profile) => {
    const { child } = await createChildAgentSession(options(), parentId, { key: profile, title: profile, profile });
    const stored = (await sessions.getSession(child.id))!;
    const target = targets[profile];
    expect([stored.provider, stored.model, stored.reasoning_effort_override])
      .toEqual(target ? [target.provider, target.model, target.effort] : ['parent-p', 'parent-m', 'medium']);
    expect(seen).toEqual([['parent-p', profile]]);
  });

  it('keeps a model and effort pinned by the creation request', async () => {
    const { child } = await createChildAgentSession(options(), parentId,
      { key: 'pinned', title: 'Pinned', profile: 'implement', provider: 'own', model: 'own-m', effort: 'minimal' });
    expect(await sessions.getSession(child.id)).toMatchObject({ provider: 'own', model: 'own-m', reasoning_effort_override: 'minimal' });
  });

  it('keeps the profile model when only the effort is specified', async () => {
    const { child } = await createChildAgentSession(options(), parentId, {
      key: 'effort-only', title: 'Review', profile: 'review', effort: 'max',
    });
    expect(await sessions.getSession(child.id)).toMatchObject({ provider: 'strong', model: 'review-3', reasoning_effort_override: 'max' });
  });

  it.each([['review', 'xhigh'], ['full', 'medium']])('inherits effort for %s even when the model is explicitly selected', async (profile, expected) => {
    const { child } = await createChildAgentSession(options(), parentId, {
      key: 'model-only', title: 'Review', profile, provider: 'own', model: 'own-m',
    });
    expect((await sessions.getSession(child.id))?.reasoning_effort_override).toBe(expected);
  });
});
