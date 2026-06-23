/**
 * Pure client core for the E2E SSH vault sync (no React, no I/O). Mirrors
 * api-sync-core but INVERTS its secrecy model: instead of stripping secrets, it
 * ENCRYPTS the full record (incl. the SSH password/key) with the vault data key
 * and ships the ciphertext. The hook (use-ssh-vault-sync) owns persistence, the
 * SshStore reads/writes, the safeStorage re-encryption, and the cloud calls.
 *
 * Records are workspace-scoped (`<workspaceId>:<uuid>`), like the api-client
 * sync, so each project syncs its own hosts while the account-global vault_meta
 * (salt + wrapped VDK) is shared. Unchanged records reuse their cached envelope
 * so a re-sync is a true byte no-op (no random-IV churn → no spurious conflicts).
 */
import type { SyncPushItem, SyncPullItem } from '@mcp/api-bus';
import type { RecordEnvelope, RecordAad } from '@mcp/vault-crypto';

export type VaultKind = 'ssh_host' | 'ssh_identity';

/** Stable JSON (recursively sorted keys) so an unchanged record hashes identically. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

function aadFor(scope: string, clientDocId: string, kind: VaultKind, kid: string, seq: number): RecordAad {
  // `scope` binds the isolation domain (personal workspaceId / `org:<id>`) and
  // `ver` carries a CLIENT-side monotonic per-doc sequence — both independent
  // splice/rollback barriers beyond per-key separation. The seq is bound here so
  // a server can't replay a stale body under a fresh version number undetected.
  return { scope, doc: clientDocId, ver: seq, kid, kind };
}

export interface VaultPushRecord {
  clientDocId: string;
  kind: VaultKind;
  /** Plaintext record (secrets already decrypted from the local keychain). */
  record: object;
}
export interface VaultCacheEntry {
  hash: string;
  body: RecordEnvelope;
  /** Monotonic sequence assigned to this body (bumped only when the plaintext changes). */
  seq: number;
}
export interface VaultPushPlan {
  items: SyncPushItem[];
  /** New per-doc {hash, ciphertext, seq} cache the hook should persist. */
  cache: Record<string, VaultCacheEntry>;
}

/** Encrypt each record, reusing the cached envelope (and its seq) when the plaintext is unchanged. */
export async function planVaultPush(
  records: VaultPushRecord[],
  scope: string,
  vdkId: string,
  encrypt: (value: unknown, aad: RecordAad) => Promise<RecordEnvelope>,
  knownVersion: (clientDocId: string) => number,
  prevCache: (clientDocId: string) => VaultCacheEntry | undefined,
  nowMs: number,
): Promise<VaultPushPlan> {
  const items: SyncPushItem[] = [];
  const cache: Record<string, VaultCacheEntry> = {};
  for (const { clientDocId, kind, record } of records) {
    const hash = stableStringify(record);
    const cached = prevCache(clientDocId);
    let body: RecordEnvelope;
    let seq: number;
    if (cached && cached.hash === hash) {
      body = cached.body; // unchanged → reuse ciphertext AND its seq (no IV churn, no seq bump)
      seq = cached.seq;
    } else {
      seq = (cached?.seq ?? 0) + 1; // changed → advance the monotonic seq
      body = await encrypt(record, aadFor(scope, clientDocId, kind, vdkId, seq));
    }
    cache[clientDocId] = { hash, body, seq };
    items.push({ kind, clientDocId, baseVersion: knownVersion(clientDocId), updatedAtMs: nowMs, body });
  }
  return { items, cache };
}

export interface VaultApplyAction<T = object> {
  clientDocId: string;
  kind: VaultKind;
  version: number;
  deleted: boolean;
  /** Authenticated monotonic seq of this body (the caller persists it as the new high-water). */
  seq: number;
  /** Decrypted plaintext record, or null for a tombstone. */
  record: T | null;
}

/**
 * Decrypt pulled vault docs for THIS workspace that are newer than what we have.
 * Enforces seq monotonicity: a body whose authenticated seq does not strictly
 * exceed the last-applied seq for its doc is dropped (rollback/replay defense).
 * A doc whose decryption fails (e.g. a tampered seq) is skipped, not applied.
 */
export async function planVaultApply<T = object>(
  pulled: SyncPullItem[],
  scope: string,
  workspaceId: string,
  vdkId: string,
  decrypt: (env: RecordEnvelope, aad: RecordAad) => Promise<T>,
  knownVersion: (clientDocId: string) => number,
  appliedSeq: (clientDocId: string) => number,
): Promise<VaultApplyAction<T>[]> {
  const prefix = `${workspaceId}:`;
  const out: VaultApplyAction<T>[] = [];
  for (const d of pulled) {
    if (d.kind !== 'ssh_host' && d.kind !== 'ssh_identity') continue;
    if (!d.clientDocId.startsWith(prefix)) continue;
    if (d.version <= knownVersion(d.clientDocId)) continue;
    if (d.deleted) {
      out.push({ clientDocId: d.clientDocId, kind: d.kind, version: d.version, deleted: true, seq: 0, record: null });
      continue;
    }
    const env = d.body as RecordEnvelope | null;
    const seq = env?.seq ?? 0;
    if (seq <= appliedSeq(d.clientDocId)) continue; // not strictly newer → rollback/replay, reject
    let record: T;
    try {
      record = await decrypt(env as RecordEnvelope, aadFor(scope, d.clientDocId, d.kind, vdkId, seq));
    } catch {
      continue; // tampered/unauthenticated body (e.g. a lied-about seq) → skip
    }
    out.push({ clientDocId: d.clientDocId, kind: d.kind, version: d.version, deleted: false, seq, record });
  }
  return out;
}
