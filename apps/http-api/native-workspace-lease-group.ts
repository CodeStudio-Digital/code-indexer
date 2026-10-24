import { withNativeStorageRootLock, type VerifiedRuntimePackage } from '@mcp/agent-runtime-host';
import { NativeWorkspaceLeaseStore, type NativeWorkspaceLease } from './native-workspace-leases.js';

type Request = Parameters<NativeWorkspaceLeaseStore['acquire']>[0];
type Owner = { store: NativeWorkspaceLeaseStore; lease: NativeWorkspaceLease };

/** Shared authority fences profiles; the profile authority remains held for
 * compatibility with older workers. Neither is freed on expiry or lost ACK. */
export class NativeWorkspaceLeaseGroup {
  private readonly owners: Owner[] = [];
  private primary?: NativeWorkspaceLease;
  private pendingDelegations = 0;
  constructor(private readonly profile: NativeWorkspaceLeaseStore,
    private readonly shared?: NativeWorkspaceLeaseStore) {}

  get sharedLease(): NativeWorkspaceLease | undefined {
    return this.shared && this.owners[0] ? structuredClone(this.owners[0].lease) : undefined;
  }

  async acquire(request: Request): Promise<NativeWorkspaceLease> {
    if (this.owners.length) throw new Error('Workspace lease group already acquired');
    try {
      for (const store of this.shared ? [this.shared, this.profile] : [this.profile]) {
        this.owners.push({ store, lease: await store.acquire(request) });
      }
      this.primary = this.owners.at(-1)!.lease;
      return structuredClone(this.primary);
    } catch (cause) {
      // No effect can run before this admission returns. Existing conflicting
      // owners are untouched; only this unsuccessful reservation is rolled back.
      for (const owner of [...this.owners].reverse()) await owner.store.release(owner.lease, async () => {});
      this.owners.length = 0;
      throw cause;
    }
  }

  async assertCurrent(lease: NativeWorkspaceLease): Promise<NativeWorkspaceLease> {
    this.assertAssociated(lease);
    for (const owner of this.owners) await owner.store.assertCurrent(owner.lease);
    return structuredClone(lease);
  }

  assertCurrentForMutation(lease: NativeWorkspaceLease): void {
    this.assertAssociated(lease);
    if (this.pendingDelegations) throw new Error('Parent workspace mutations are fenced during child admission');
    for (const owner of this.owners) owner.store.assertCurrentForMutation(owner.lease);
  }

  assertCurrentForCoordination(lease: NativeWorkspaceLease): void {
    this.assertAssociated(lease);
    for (const owner of this.owners) owner.store.assertCurrentForCoordination(owner.lease);
  }

  /** Fence new effects synchronously, then drain in-flight effects before
   * reserving either durable child authority. No child process may exist yet. */
  async delegate(lease: NativeWorkspaceLease, request: Omit<Request, 'parentLease'>,
    quiesceParent: () => Promise<void>): Promise<{ group: NativeWorkspaceLeaseGroup; lease: NativeWorkspaceLease }> {
    this.assertAssociated(lease);
    this.pendingDelegations++;
    const child = new NativeWorkspaceLeaseGroup(this.profile, this.shared);
    try {
      await quiesceParent();
      await this.assertCurrent(lease);
      for (const owner of this.owners) child.owners.push({ store: owner.store,
        lease: await owner.store.acquire({ ...request, parentLease: owner.lease }) });
      child.primary = child.owners.at(-1)!.lease;
      return { group: child, lease: structuredClone(child.primary) };
    } catch (cause) {
      for (const owner of [...child.owners].reverse()) await owner.store.release(owner.lease, async () => {});
      throw cause;
    } finally { this.pendingDelegations--; }
  }

  async release(lease: NativeWorkspaceLease, proveReaped: () => Promise<void>): Promise<void> {
    this.assertAssociated(lease);
    await proveReaped();
    // Compatibility owner first, shared owner last. A failed write leaves the
    // remaining fence in place and can be reconciled without repeating effects.
    for (const owner of [...this.owners].reverse()) await owner.store.release(owner.lease, async () => {});
  }

  private assertAssociated(lease: NativeWorkspaceLease) {
    if (!this.primary || JSON.stringify(this.primary) !== JSON.stringify(lease)) {
      throw new Error('Workspace lease does not belong to this admission');
    }
  }
}

export function nativeWorkspaceLeaseGroup(config: { workspaceLeaseRoot: string; sharedWorkspaceLeaseRoot?: string },
  runtimePackage: VerifiedRuntimePackage): NativeWorkspaceLeaseGroup {
  const store = (root: string) => new NativeWorkspaceLeaseStore(root, Date.now,
    operation => withNativeStorageRootLock(runtimePackage, root, 'workspace-leases', operation));
  const shared = config.sharedWorkspaceLeaseRoot;
  return new NativeWorkspaceLeaseGroup(store(config.workspaceLeaseRoot), shared ? store(shared) : undefined);
}
