import { isAbsolute, relative, sep } from 'node:path';
import type { NativeWorkspaceLease } from './native-workspace-leases.js';

export function withinWorkspace(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}

export function workspaceAncestors(leases: readonly NativeWorkspaceLease[], lease: NativeWorkspaceLease,
  now: number): Set<string> {
  const result = new Set<string>();
  let child = lease;
  while (child.parentLeaseId) {
    if (result.has(child.parentLeaseId) || result.size >= 32) throw new Error('Native workspace delegation cycle or excessive depth');
    const parent = leases.find(value => value.leaseId === child.parentLeaseId);
    if (!parent || parent.expiresAtUnixMs <= now || child.expiresAtUnixMs > parent.expiresAtUnixMs
      || child.fencingEpoch <= parent.fencingEpoch || !withinWorkspace(parent.root, child.root)
      || child.access === 'exclusive_write' && parent.access !== 'exclusive_write') {
      throw new Error('Native workspace ancestor is missing, expired or incompatible');
    }
    result.add(parent.leaseId); child = parent;
  }
  return result;
}

export function assertWorkspaceDescendantsReaped(leases: readonly NativeWorkspaceLease[], lease: NativeWorkspaceLease): void {
  if (leases.some(value => value.parentLeaseId === lease.leaseId)) {
    throw new Error('Native workspace descendants require physical reap before parent mutation or release');
  }
}
