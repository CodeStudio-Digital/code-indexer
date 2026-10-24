import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { parseRuntimePackageAnchor, verifyRuntimePackage, withNativeStorageRootLock } from '@mcp/agent-runtime-host';
import { NativeWorkspaceLeaseStore } from '../native-workspace-leases.js';
import { nativeWorkspaceLeaseGroup } from '../native-workspace-lease-group.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;

physicalIt('fences independent profile writers through the shared native OS authority and preserves parallel reads', async () => {
  const pkg = await verifyRuntimePackage(resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
    parseRuntimePackageAnchor(await readFile(resolve('dist/apps/electron/native-agent-runtime-integrity.json'))));
  const root = await mkdtemp(join(tmpdir(), 'native-profiles-lock-'));
  const group = (profile: string) => nativeWorkspaceLeaseGroup({ workspaceLeaseRoot: join(root, profile),
    sharedWorkspaceLeaseRoot: join(root, 'shared') }, pkg);
  const request = { root, ownerAgentRunId: 'run', access: 'read_only' as const,
    expiresAtUnixMs: Date.now() + 60_000, assertOwner: async () => {} };
  const a = group('profile-a'), b = group('profile-b'), writer = group('profile-c');
  try {
    const [one, two] = await Promise.all([a.acquire({ ...request, attemptId: 'a' }), b.acquire({ ...request, attemptId: 'b' })]);
    await expect(writer.acquire({ ...request, attemptId: 'write', access: 'exclusive_write' }))
      .rejects.toMatchObject({ code: 'WORKSPACE_RUNTIME_CONFLICT' });
    await Promise.all([a.release(one, async () => {}), b.release(two, async () => {})]);
    const write = await writer.acquire({ ...request, attemptId: 'write', access: 'exclusive_write' });
    writer.assertCurrentForMutation(write);
    await expect(group('profile-d').acquire({ ...request, attemptId: 'd' })).rejects.toThrow('leased');
    await writer.release(write, async () => {});
    expect(JSON.parse(await readFile(join(root, 'shared', 'leases.json'), 'utf8')).state.leases).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

physicalIt('serializes independent native owners without blocking the event loop and releases on failure', async () => {
  const pkg = await verifyRuntimePackage(resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
    parseRuntimePackageAnchor(await readFile(resolve('dist/apps/electron/native-agent-runtime-integrity.json'))));
  const root = await mkdtemp(join(tmpdir(), 'native-storage-mutex-'));
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  let secondEntered = false;
  try {
    const first = withNativeStorageRootLock(pkg, root, 'workspace-leases', async () => { enter(); await wait; });
    await entered;
    const second = withNativeStorageRootLock(pkg, root, 'workspace-leases', async () => { secondEntered = true; });
    // Contention consumes typed failure responses, then succeeds on the same
    // authenticated sequence after release. The timer must remain responsive.
    await delay(50);
    expect(secondEntered).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
    await expect(withNativeStorageRootLock(pkg, root, 'workspace-leases', async () => { throw new Error('interrupted transaction'); }))
      .rejects.toThrow('interrupted transaction');
    await expect(withNativeStorageRootLock(pkg, root, 'workspace-leases', async () => 42)).resolves.toBe(42);
  } finally { release?.(); await rm(root, { recursive: true, force: true }); }
});

physicalIt('keeps monotonic workspace fencing across owners and rejects the previous ledger format', async () => {
  const pkg = await verifyRuntimePackage(resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
    parseRuntimePackageAnchor(await readFile(resolve('dist/apps/electron/native-agent-runtime-integrity.json'))));
  const root = await mkdtemp(join(tmpdir(), 'native-workspace-v2-'));
  const location = join(root, 'authority');
  const store = () => new NativeWorkspaceLeaseStore(location, Date.now,
    operation => withNativeStorageRootLock(pkg, location, 'workspace-leases', operation));
  const request = { root, access: 'read_only' as const, ownerAgentRunId: 'owner', attemptId: 'a',
    expiresAtUnixMs: Date.now() + 60_000, assertOwner: async () => {} };
  try {
    const leases = await Promise.all([store().acquire(request), store().acquire({ ...request, attemptId: 'b' })]);
    expect(leases.map(lease => lease.fencingEpoch).sort()).toEqual([1, 2]);
    await Promise.all(leases.map(lease => store().release(lease, async () => {})));
    expect((await store().acquire({ ...request, attemptId: 'c' })).fencingEpoch).toBe(3);
    // Old code rejects v2 before it can write under its incompatible mutex.
    await expect(new NativeWorkspaceLeaseStore(location).acquire({ ...request, attemptId: 'old' })).rejects.toThrow('corrupt');
    const old = join(root, 'old'); await mkdir(old);
    await writeFile(join(old, 'transaction.lock'), 'old owner');
    const migrated = new NativeWorkspaceLeaseStore(old, Date.now,
      operation => withNativeStorageRootLock(pkg, old, 'workspace-leases', operation));
    await expect(migrated.acquire(request)).rejects.toThrow('requires crash reconciliation');
  } finally { await rm(root, { recursive: true, force: true }); }
});
