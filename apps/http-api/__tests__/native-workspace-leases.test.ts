import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeWorkspaceLeaseStore } from '../native-workspace-leases.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'native-workspace-authority-'));
  directories.push(directory);
  const root = join(directory, 'project');
  await mkdir(join(root, 'nested'), { recursive: true });
  let now = 10_000;
  const location = join(directory, 'authority');
  const store = new NativeWorkspaceLeaseStore(location, () => now);
  const request = { root, ownerAgentRunId: 'run-1', attemptId: 'attempt-1',
    access: 'read_only' as const, expiresAtUnixMs: 20_000, assertOwner: async () => {} };
  return { directory, root, location, store, request, advance: () => { now = 30_000; } };
}

describe('native workspace authority', () => {
  it('delegates reads while fencing parent writes and release until every child is physically reaped', async () => {
    const f = await fixture(); const root = await f.store.acquire({ ...f.request, access: 'exclusive_write' });
    const a = await f.store.acquire({ ...f.request, parentLease: root, attemptId: 'child-a', ownerAgentRunId: 'child-a' });
    const b = await f.store.acquire({ ...f.request, parentLease: root, attemptId: 'child-b', ownerAgentRunId: 'child-b' });
    await expect(f.store.assertCurrent(a)).resolves.toEqual(a);
    expect(() => f.store.assertCurrentForCoordination(root)).not.toThrow();
    expect(() => f.store.assertCurrentForMutation(root)).toThrow('descendants');
    await expect(f.store.release(root, async () => {})).rejects.toThrow('descendants');
    await expect(f.store.acquire({ ...f.request, parentLease: root, attemptId: 'writer', access: 'exclusive_write' })).rejects.toThrow('leased');
    await f.store.release(a, async () => {});
    expect(() => f.store.assertCurrentForMutation(root)).toThrow('descendants');
    await f.store.release(b, async () => {}); f.store.assertCurrentForMutation(root);
    const writer = await f.store.acquire({ ...f.request, parentLease: root, attemptId: 'writer', access: 'exclusive_write' });
    f.store.assertCurrentForMutation(writer);
    await expect(f.store.acquire({ ...f.request, parentLease: root, attemptId: 'another-reader' })).rejects.toThrow('leased');
  });

  it('rejects widening parent access, workspace or deadline and divergent delegation replay', async () => {
    const f = await fixture(); const parent = await f.store.acquire(f.request);
    const request = { ...f.request, parentLease: parent, attemptId: 'child' };
    await expect(f.store.acquire({ ...request, access: 'exclusive_write' })).rejects.toThrow('parent authority');
    await expect(f.store.acquire({ ...request, root: f.directory })).rejects.toThrow('parent authority');
    await expect(f.store.acquire({ ...request, expiresAtUnixMs: 20_001 })).rejects.toThrow('parent authority');
    const child = await f.store.acquire(request);
    await expect(f.store.acquire({ ...f.request, attemptId: 'child' })).rejects.toThrow('replay diverged');
    expect(await f.store.acquire(request)).toEqual(child);
    await expect(f.store.acquire({ ...request, attemptId: parent.attemptId })).rejects.toThrow('parent authority');
  });

  it('retains expired delegated reads through restart until cleanup and fences all descendants', async () => {
    const f = await fixture(); const parent = await f.store.acquire(f.request);
    const child = await f.store.acquire({ ...f.request, parentLease: parent, attemptId: 'child' });
    const grandchild = await f.store.acquire({ ...f.request, parentLease: child, attemptId: 'grandchild' });
    f.advance(); const reopened = new NativeWorkspaceLeaseStore(f.location, () => 30_000);
    await expect(reopened.acquire({ ...f.request, attemptId: 'new-writer', expiresAtUnixMs: 40_000, access: 'exclusive_write' })).rejects.toThrow('leased');
    await expect(reopened.assertCurrent(grandchild)).rejects.toThrow('expired');
    await expect(reopened.release(child, async () => {})).rejects.toThrow('descendants');
    await reopened.release(grandchild, async () => {}); await reopened.release(child, async () => {}); await reopened.release(parent, async () => {});
    await expect(reopened.acquire({ ...f.request, attemptId: 'new-writer', expiresAtUnixMs: 40_000, access: 'exclusive_write' })).resolves.toBeDefined();
  });

  it('fences the physical mutation boundary on expiry, revocation and read-only authority', async () => {
    const f = await fixture();
    const read = await f.store.acquire(f.request);
    expect(() => f.store.assertCurrentForMutation(read)).toThrow('exclusive lease');
    expect(() => f.store.assertCurrentForCoordination(read)).toThrow('exclusive lease');
    await f.store.release(read, async () => {});
    const write = await f.store.acquire({ ...f.request, attemptId: 'writer', access: 'exclusive_write' });
    expect(() => f.store.assertCurrentForMutation(write)).not.toThrow();
    await f.store.release(write, async () => {});
    expect(() => f.store.assertCurrentForMutation(write)).toThrow('revoked');
    expect(() => f.store.assertCurrentForCoordination(write)).toThrow('revoked');
    const expiring = await f.store.acquire({ ...f.request, attemptId: 'expiring', access: 'exclusive_write' });
    f.advance();
    expect(() => f.store.assertCurrentForMutation(expiring)).toThrow('live exclusive lease');
    expect(() => f.store.assertCurrentForCoordination(expiring)).toThrow('live exclusive lease');
  });
  it('serializes independent owners and denies a nested writer while readers are active', async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([f.store.acquire(f.request),
      new NativeWorkspaceLeaseStore(f.location, () => 10_000).acquire({ ...f.request, attemptId: 'attempt-2', ownerAgentRunId: 'run-2' })]);
    expect(a.fencingEpoch).not.toBe(b.fencingEpoch);
    await expect(f.store.acquire({ ...f.request, root: join(f.root, 'nested'), access: 'exclusive_write', attemptId: 'write' }))
      .rejects.toThrow('leased by another attempt');
    await f.store.release(a, async () => {});
    await expect(f.store.assertCurrent(a)).rejects.toThrow('revoked');
    await expect(f.store.assertCurrent(b)).resolves.toEqual(b);
  });

  it('retains expired exclusive writers until physical recovery supplies a proof', async () => {
    const f = await fixture();
    const a = await f.store.acquire({ ...f.request, access: 'exclusive_write' });
    f.advance();
    await expect(f.store.assertCurrent(a)).rejects.toThrow('expired');
    const next = { ...f.request, attemptId: 'attempt-2', expiresAtUnixMs: 40_000 };
    await expect(f.store.acquire(next)).rejects.toThrow('unresolved expired writers');
    await expect(f.store.release(a, async () => { throw new Error('process still alive'); })).rejects.toThrow('still alive');
    await expect(f.store.acquire(next)).rejects.toThrow('unresolved expired writers');
    await f.store.release(a, async () => {});
    expect((await f.store.acquire(next)).fencingEpoch).toBeGreaterThan(a.fencingEpoch);
  });

  it('cannot reset the fencing epoch by losing the ledger after restart', async () => {
    const f = await fixture();
    await f.store.acquire(f.request);
    await unlink(join(f.location, 'leases.json'));
    const reopened = new NativeWorkspaceLeaseStore(f.location, () => 10_000);
    await expect(reopened.acquire({ ...f.request, attemptId: 'attempt-2' })).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('rejects corrupt state and divergent acquisition replays', async () => {
    const f = await fixture();
    const a = await f.store.acquire(f.request);
    await expect(f.store.acquire({ ...f.request, expiresAtUnixMs: 21_000 })).rejects.toThrow('replay diverged');
    await writeFile(join(f.location, 'leases.json'), JSON.stringify({ state: { schemaVersion: 1, nextEpoch: 1, leases: [] }, sha256: 'wrong' }));
    await expect(f.store.assertCurrent(a)).rejects.toThrow('corrupt');
  });
});
