import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, realpath, stat, unlink } from 'node:fs/promises';
import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWriteJson } from '../../packages/session-storage/src/atomic-file.js';
import { workspaceRuntimeConflict } from '@mcp/code-agent/runtime/workspace-runtime-error.js';
import { withinWorkspace, workspaceAncestors, assertWorkspaceDescendantsReaped } from './native-workspace-delegation.js';

export interface NativeWorkspaceLease {
  readonly leaseId: string;
  readonly ownerAgentRunId: string;
  readonly attemptId: string;
  readonly environmentId: string;
  readonly environmentVersion: number;
  readonly root: string;
  readonly access: 'read_only' | 'exclusive_write';
  readonly fencingEpoch: number;
  readonly version: number;
  readonly acquiredAtUnixMs: number;
  readonly expiresAtUnixMs: number;
  readonly parentLeaseId?: string;
}
interface LeaseState { schemaVersion: 1 | 2; nextEpoch: number; leases: NativeWorkspaceLease[] }
export type NativeWorkspaceTransaction = <T>(operation: () => Promise<T>) => Promise<T>;

/** A bounded durable product authority. Expiry fences effects but never frees
 * an exclusive writer: physical recovery must prove it is gone before release.
 * A crashed transaction lock also fails closed rather than guessing liveness. */
export class NativeWorkspaceLeaseStore {
  readonly #directory: string;
  constructor(directory: string, readonly now = Date.now, readonly transaction?: NativeWorkspaceTransaction) {
    this.#directory = resolve(directory);
  }

  /** Read-only physical verifier for authority files written under the OS lock. */
  static verifier(directory: string): NativeWorkspaceLeaseStore {
    return new NativeWorkspaceLeaseStore(directory, Date.now, async () => {
      throw new Error('Workspace verifier cannot mutate authority');
    });
  }

  async acquire(input: { root: string; ownerAgentRunId: string; attemptId: string;
    access: NativeWorkspaceLease['access']; expiresAtUnixMs: number;
    /** Host-only; caller must fence and drain parent effects before delegation. */
    parentLease?: NativeWorkspaceLease;
    assertOwner(): Promise<void> }): Promise<NativeWorkspaceLease> {
    const root = await canonicalRoot(input.root);
    if (!input.ownerAgentRunId || !input.attemptId || !['read_only', 'exclusive_write'].includes(input.access)
      || !Number.isSafeInteger(input.expiresAtUnixMs) || input.expiresAtUnixMs <= this.now()) {
      throw new Error('Invalid native workspace lease request');
    }
    return this.#mutate(async (state) => {
      await input.assertOwner();
      const parent = input.parentLease;
      let ancestors = new Set<string>();
      if (parent) {
        const current = state.leases.find(lease => lease.leaseId === parent.leaseId);
        if (!current || JSON.stringify(current) !== JSON.stringify(parent) || parent.expiresAtUnixMs <= this.now()
          || parent.attemptId === input.attemptId || input.expiresAtUnixMs > parent.expiresAtUnixMs
          || !withinWorkspace(parent.root, root) || input.access === 'exclusive_write' && parent.access !== 'exclusive_write') {
          throw new Error('Native workspace delegation exceeds current parent authority');
        }
        ancestors = workspaceAncestors(state.leases, parent, this.now()); ancestors.add(parent.leaseId);
      }
      const existing = state.leases.find((lease) => lease.attemptId === input.attemptId);
      if (existing) {
        if (existing.ownerAgentRunId !== input.ownerAgentRunId || existing.root !== root
          || existing.access !== input.access || existing.expiresAtUnixMs !== input.expiresAtUnixMs
          || existing.parentLeaseId !== parent?.leaseId || existing.expiresAtUnixMs <= this.now()) throw new Error('Native workspace lease replay diverged');
        return existing;
      }
      const delegatedParents = new Set(state.leases.map(lease => lease.parentLeaseId).filter(Boolean));
      state.leases = state.leases.filter((lease) => lease.parentLeaseId || delegatedParents.has(lease.leaseId)
        || lease.access === 'exclusive_write' || lease.expiresAtUnixMs > this.now());
      if (state.leases.some((lease) => !ancestors.has(lease.leaseId) && overlaps(lease.root, root)
        && (lease.access === 'exclusive_write' || input.access === 'exclusive_write'))) {
        throw workspaceRuntimeConflict('Native workspace is leased by another attempt, including unresolved expired writers');
      }
      if (state.leases.length >= 256 || !Number.isSafeInteger(state.nextEpoch + 1)) throw new Error('Native workspace lease capacity exceeded');
      const lease: NativeWorkspaceLease = { leaseId: randomUUID(), ownerAgentRunId: input.ownerAgentRunId,
        attemptId: input.attemptId, environmentId: `environment:${hash(root)}`, environmentVersion: 1,
        root, access: input.access, fencingEpoch: state.nextEpoch++, version: 1,
        acquiredAtUnixMs: this.now(), expiresAtUnixMs: input.expiresAtUnixMs,
        ...(parent ? { parentLeaseId: parent.leaseId } : {}) };
      state.leases.push(lease);
      await input.assertOwner(); return lease;
    });
  }

  async assertCurrent(lease: NativeWorkspaceLease): Promise<NativeWorkspaceLease> {
    if (lease.expiresAtUnixMs <= this.now() || await canonicalRoot(lease.root) !== lease.root) {
      throw new Error('Native workspace lease expired or its root changed');
    }
    const state = await this.#read();
    const current = state.leases.find((entry) => entry.leaseId === lease.leaseId);
    if (!current || JSON.stringify(current) !== JSON.stringify(lease)) throw new Error('Native workspace authority was revoked or replaced');
    workspaceAncestors(state.leases, lease, this.now());
    return structuredClone(current);
  }

  /** Worker-only physical effect fence. No await may separate this check from
   * the filesystem adapter's dispatch. The small authority file is bounded;
   * transcript/history and SQLite are never read here. */
  assertCurrentForMutation(lease: NativeWorkspaceLease): void {
    this.#assertCurrentSynchronously(lease, true);
  }

  /** Tree coordination needs current authority but never a workspace write.
   * Live descendants remain fenced against filesystem/shell mutations. */
  assertCurrentForCoordination(lease: NativeWorkspaceLease): void {
    this.#assertCurrentSynchronously(lease, false);
  }

  #assertCurrentSynchronously(lease: NativeWorkspaceLease, mutation: boolean): void {
    if (lease.access !== 'exclusive_write' || lease.expiresAtUnixMs <= this.now()) {
      throw new Error('Native workspace mutation requires a live exclusive lease');
    }
    const root = realpathSync(lease.root);
    if ((process.platform === 'win32' ? root.toLowerCase() : root) !== lease.root) {
      throw new Error('Native workspace root changed before mutation');
    }
    const descriptor = openSync(join(this.#directory, 'leases.json'), 'r');
    try {
      const size = fstatSync(descriptor).size;
      if (size > 1024 * 1024) throw new Error('Native workspace authority exceeds its bound');
      const bytes = Buffer.alloc(size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (!count) break;
        offset += count;
      }
      if (offset !== size) throw new Error('Native workspace authority changed during its read');
      const state = this.#decode(bytes.subarray(0, size));
      const current = state.leases.find(entry => entry.leaseId === lease.leaseId);
      if (!current || JSON.stringify(current) !== JSON.stringify(lease)) throw new Error('Native workspace authority was revoked or replaced');
      workspaceAncestors(state.leases, lease, this.now());
      if (mutation) assertWorkspaceDescendantsReaped(state.leases, lease);
    } finally { closeSync(descriptor); }
  }

  async release(lease: NativeWorkspaceLease, proveReaped: () => Promise<void>): Promise<void> {
    await this.#mutate(async (state) => {
      const current = state.leases.find((entry) => entry.leaseId === lease.leaseId);
      if (!current) return;
      if (JSON.stringify(current) !== JSON.stringify(lease)) throw new Error('Cannot release a different workspace authority');
      assertWorkspaceDescendantsReaped(state.leases, lease);
      // The proof is mandatory even for a read-only lease: the same API is used
      // by exclusive writers and cannot accidentally treat expiry as cleanup.
      await proveReaped();
      state.leases = state.leases.filter((entry) => entry.leaseId !== lease.leaseId);
    });
  }

  async #mutate<T>(operation: (state: LeaseState) => Promise<T>): Promise<T> {
    await mkdir(this.#directory, { recursive: true });
    const lockPath = join(this.#directory, 'transaction.lock');
    const commit = async () => {
      const state = await this.#read(true);
      const result = await operation(state);
      await atomicWriteJson(join(this.#directory, 'leases.json'), { state, sha256: hash(JSON.stringify(state)) });
      return structuredClone(result);
    };
    if (this.transaction) return this.transaction(async () => {
      // An older process uses exclusive-create locking. Do not steal its
      // authority merely because the new process owns a different OS lock.
      try { await stat(lockPath); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return commit(); throw cause; }
      throw new Error('Legacy workspace transaction requires crash reconciliation');
    });
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { lock = await open(lockPath, 'wx', 0o600); break; }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
        await delay(10);
      }
    }
    if (!lock) throw new Error('Native workspace authority is busy or requires crash reconciliation');
    try {
      return await commit();
    } finally { await lock.close(); await unlink(lockPath); }
  }

  async #read(initialize = false): Promise<LeaseState> {
    let bytes: Buffer;
    try {
      const handle = await open(join(this.#directory, 'leases.json'), 'r');
      try {
        const size = (await handle.stat()).size;
        if (size > 1024 * 1024) throw new Error('Native workspace authority exceeds its bound');
        bytes = Buffer.alloc(size + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (offset !== size) throw new Error('Native workspace authority changed during its read');
        bytes = bytes.subarray(0, size);
      } finally { await handle.close(); }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT' && initialize) {
        // Retained independently of leases.json: deletion/corruption must not
        // silently reset the workspace fence to one after a restart.
        const marker = await open(join(this.#directory, 'initialized'), 'wx', 0o600);
        try { await marker.writeFile(`native-workspace-authority-v${this.transaction ? 2 : 1}\n`); await marker.sync(); }
        finally { await marker.close(); }
        return { schemaVersion: this.transaction ? 2 : 1, nextEpoch: 1, leases: [] };
      }
      throw cause;
    }
    return this.#decode(bytes);
  }

  #decode(bytes: Buffer): LeaseState {
    const { state, sha256 } = JSON.parse(bytes.toString('utf8')) as { state: LeaseState; sha256: string };
    if (!state || state.schemaVersion !== (this.transaction ? 2 : 1) || !Number.isSafeInteger(state.nextEpoch) || state.nextEpoch < 1
      || !Array.isArray(state.leases) || state.leases.length > 256 || hash(JSON.stringify(state)) !== sha256
      || state.leases.some((lease) => !lease.leaseId || !lease.attemptId || !lease.ownerAgentRunId
        || !isAbsolute(lease.root) || !['read_only', 'exclusive_write'].includes(lease.access)
        || !Number.isSafeInteger(lease.fencingEpoch) || lease.fencingEpoch < 1 || lease.fencingEpoch >= state.nextEpoch
        || !Number.isSafeInteger(lease.expiresAtUnixMs) || lease.version !== 1
        || lease.parentLeaseId !== undefined && (typeof lease.parentLeaseId !== 'string' || !lease.parentLeaseId || lease.parentLeaseId === lease.leaseId))) {
      throw new Error('Native workspace authority is corrupt');
    }
    return state;
  }
}

async function canonicalRoot(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('Workspace root must be absolute');
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) throw new Error('Workspace root is not a directory');
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}
function overlaps(a: string, b: string): boolean {
  const within = (root: string, candidate: string) => {
    const rel = relative(root, candidate);
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
  };
  return within(a, b) || within(b, a);
}
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
