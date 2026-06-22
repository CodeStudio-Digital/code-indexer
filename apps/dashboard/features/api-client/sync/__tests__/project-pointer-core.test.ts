/** Pure project-pointer core tests: credential stripping, push shaping, apply plan. */
import { describe, it, expect } from 'vitest';
import type { SyncPullItem } from '@mcp/api-bus';
import { sanitizeGitRemote, projectPointerToPush, planProjectApply } from '../project-pointer-core.js';

describe('sanitizeGitRemote', () => {
  it('strips embedded https credentials', () => {
    expect(sanitizeGitRemote('https://x-access-token:ghp_secret@github.com/o/r.git')).toBe('https://github.com/o/r.git');
  });
  it('passes clean https + scp-style ssh through', () => {
    expect(sanitizeGitRemote('https://github.com/o/r.git')).toBe('https://github.com/o/r.git');
    expect(sanitizeGitRemote('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
  });
});

describe('projectPointerToPush', () => {
  it('uses workspaceId as clientDocId, kind=project, and sanitizes the remote', () => {
    const item = projectPointerToPush({ name: 'API', gitRemote: 'https://u:p@github.com/o/r.git', description: 'd', defaultBranch: 'main', workspaceId: 'ws-1' }, 0, 123);
    expect(item.kind).toBe('project');
    expect(item.clientDocId).toBe('ws-1');
    expect(item.updatedAtMs).toBe(123);
    expect((item.body as { gitRemote: string }).gitRemote).toBe('https://github.com/o/r.git');
  });
});

describe('planProjectApply', () => {
  const pulled: SyncPullItem[] = [
    { kind: 'project', clientDocId: 'ws-a', version: 5, deleted: false, body: { name: 'A', gitRemote: 'https://github.com/o/a.git', defaultBranch: 'main' } },
    { kind: 'project', clientDocId: 'ws-b', version: 3, deleted: true, body: null },
    { kind: 'collection', clientDocId: 'ws-c', version: 9, deleted: false, body: {} },
  ];
  it('keeps only newer project docs, hydrates the pointer with its workspaceId, maps tombstones', () => {
    const actions = planProjectApply(pulled, (cid) => (cid === 'ws-a' ? 5 : 0));
    // ws-a skipped (5 not > 5); collection ignored; ws-b is a newer tombstone.
    expect(actions.map((a) => a.clientDocId)).toEqual(['ws-b']);
    expect(actions[0].deleted).toBe(true);
    expect(actions[0].pointer).toBeNull();
  });
  it('hydrates a fresh pointer with workspaceId = clientDocId', () => {
    const actions = planProjectApply(pulled, () => 0);
    const a = actions.find((x) => x.clientDocId === 'ws-a')!;
    expect(a.pointer).toMatchObject({ name: 'A', gitRemote: 'https://github.com/o/a.git', workspaceId: 'ws-a', defaultBranch: 'main' });
  });
});
