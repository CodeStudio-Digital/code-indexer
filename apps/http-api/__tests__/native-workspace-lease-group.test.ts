import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { NativeWorkspaceLeaseStore } from '../native-workspace-leases.js';
import { NativeWorkspaceLeaseGroup } from '../native-workspace-lease-group.js';

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'native-workspace-group-')); directories.push(directory);
  const root = join(directory, 'project'); await mkdir(root);
  const sharedRoot = join(directory, 'shared');
  const store = (path: string) => new NativeWorkspaceLeaseStore(path, () => 10_000);
  const shared = store(sharedRoot);
  const profile = (name: string) => store(join(directory, name));
  const group = (name: string) => new NativeWorkspaceLeaseGroup(profile(name), shared);
  const request = { root, ownerAgentRunId: 'run-1', attemptId: 'attempt-1', access: 'read_only' as const,
    expiresAtUnixMs: 20_000, assertOwner: async () => {} };
  return { directory, root, sharedRoot, shared, profile, group, request };
}

it('shares reads across profiles but rejects any overlapping writer', async () => {
  const f = await fixture(); const a = f.group('a'), b = f.group('b');
  const one = await a.acquire(f.request);
  const two = await b.acquire({ ...f.request, attemptId: 'attempt-2' });
  await expect(f.group('c').acquire({ ...f.request, attemptId: 'writer', access: 'exclusive_write' })).rejects.toThrow('leased');
  await a.release(one, async () => {});
  await expect(f.group('c').acquire({ ...f.request, attemptId: 'writer', access: 'exclusive_write' })).rejects.toThrow('leased');
  await b.release(two, async () => {});
  const writer = f.group('c');
  const lease = await writer.acquire({ ...f.request, attemptId: 'writer', access: 'exclusive_write' });
  await expect(f.group('a').acquire(f.request)).rejects.toThrow('leased');
  writer.assertCurrentForMutation(lease);
});

it('fences parent dispatch synchronously before draining and keeps both delegated fences until reap', async () => {
  const f = await fixture(); const parent = f.group('a');
  const lease = await parent.acquire({ ...f.request, access: 'exclusive_write' });
  let finishDrain!: () => void; const drained = new Promise<void>(resolve => { finishDrain = resolve; });
  const delegated = parent.delegate(lease, { ...f.request, attemptId: 'child', ownerAgentRunId: 'child' }, () => drained);
  expect(() => parent.assertCurrentForMutation(lease)).toThrow('during child admission');
  expect(() => parent.assertCurrentForCoordination(lease)).not.toThrow();
  finishDrain(); const child = await delegated;
  expect(child.group.sharedLease?.parentLeaseId).toBe(parent.sharedLease!.leaseId);
  expect(child.lease.parentLeaseId).toBe(lease.leaseId);
  expect(() => parent.assertCurrentForMutation(lease)).toThrow('descendants');
  expect(() => parent.assertCurrentForCoordination(lease)).not.toThrow();
  await expect(f.group('other').acquire({ ...f.request, attemptId: 'other', access: 'exclusive_write' })).rejects.toThrow('leased');
  await expect(child.group.release(child.lease, async () => { throw new Error('unconfirmed reap'); })).rejects.toThrow('unconfirmed reap');
  expect(() => parent.assertCurrentForMutation(lease)).toThrow('descendants');
  await child.group.release(child.lease, async () => {}); parent.assertCurrentForMutation(lease);
  await parent.release(lease, async () => {});
});

it('rolls back a child shared reservation when the compatibility profile refuses it', async () => {
  const f = await fixture(); const parent = f.group('a');
  const lease = await parent.acquire({ ...f.request, access: 'exclusive_write' });
  const oldChild = await f.profile('a').acquire({ ...f.request, parentLease: lease, attemptId: 'old-child', access: 'exclusive_write' });
  await expect(parent.delegate(lease, { ...f.request, attemptId: 'new-child' }, async () => {})).rejects.toThrow('leased');
  expect(JSON.parse(await readFile(join(f.sharedRoot, 'leases.json'), 'utf8')).state.leases).toHaveLength(1);
  await f.profile('a').release(oldChild, async () => {}); parent.assertCurrentForMutation(lease);
  await expect(parent.delegate(lease, { ...f.request, attemptId: 'new-child' }, async () => { throw new Error('parent busy'); })).rejects.toThrow('parent busy');
  parent.assertCurrentForMutation(lease);
});

it('preserves old profile ownership and rolls back a denied shared reservation', async () => {
  const f = await fixture();
  const old = await f.profile('a').acquire({ ...f.request, access: 'exclusive_write' });
  await expect(f.group('a').acquire({ ...f.request, attemptId: 'new', access: 'exclusive_write' })).rejects.toThrow('leased');
  expect(JSON.parse(await readFile(join(f.sharedRoot, 'leases.json'), 'utf8')).state.leases).toEqual([]);
  await expect(f.profile('a').assertCurrent(old)).resolves.toEqual(old);
});

it('checks both fences at the actual effect boundary, including shared revocation', async () => {
  const f = await fixture(); const group = f.group('a');
  const lease = await group.acquire({ ...f.request, access: 'exclusive_write' });
  await f.shared.release(group.sharedLease!, async () => {});
  await expect(f.profile('a').assertCurrent(lease)).resolves.toEqual(lease);
  await expect(group.assertCurrent(lease)).rejects.toThrow('revoked');
  expect(() => group.assertCurrentForMutation(lease)).toThrow('revoked');
  expect(() => group.assertCurrentForCoordination(lease)).toThrow('revoked');
});

it('keeps both authorities after an unconfirmed physical cleanup and rejects foreign release', async () => {
  const f = await fixture(); const group = f.group('a');
  const lease = await group.acquire({ ...f.request, access: 'exclusive_write' });
  await expect(group.release(lease, async () => { throw new Error('reap unconfirmed'); })).rejects.toThrow('reap unconfirmed');
  await expect(f.shared.assertCurrent(group.sharedLease!)).resolves.toBeDefined();
  await expect(f.profile('a').assertCurrent(lease)).resolves.toBeDefined();
  await expect(group.release({ ...lease, attemptId: 'foreign' }, async () => {})).rejects.toThrow('does not belong');
  await group.release(lease, async () => {});
  await group.release(lease, async () => {});
  expect(JSON.parse(await readFile(join(f.sharedRoot, 'leases.json'), 'utf8')).state.leases).toEqual([]);
});

it('supports compatibility-only owners and does not expose mutable shared grants', async () => {
  const f = await fixture(); const local = new NativeWorkspaceLeaseGroup(f.profile('a'));
  const lease = await local.acquire(f.request); expect(local.sharedLease).toBeUndefined();
  await local.release(lease, async () => {});
  const group = f.group('b'); const owned = await group.acquire({ ...f.request, attemptId: 'second' });
  const changed = group.sharedLease! as { attemptId: string }; changed.attemptId = 'foreign';
  await expect(group.assertCurrent(owned)).resolves.toEqual(owned);
});
