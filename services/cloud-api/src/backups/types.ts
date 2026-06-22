/**
 * Backups domain types + ports. A backup is a gzipped bundle of CodeStudio
 * METADATA (sessions/collections/environment-structure/memory/checkpoints — never
 * source) stored in R2, indexed in D1 with per-tier retention. Pure (no I/O); the
 * D1 + R2 adapters implement the ports.
 */

export interface BackupMeta {
  id: string;
  r2Key: string;
  label: string;
  byteSize: number;
  contentSha256: string;
  manifest: Record<string, unknown>;
  createdAtMs: number;
  expiresAtMs: number | null;
}

/** What listings/prune need (no blob, no manifest). */
export interface BackupRef {
  id: string;
  r2Key: string;
  createdAtMs: number;
  expiresAtMs: number | null;
}

export interface BackupRepo {
  insert(accountId: string, meta: BackupMeta): Promise<void>;
  listByOwner(accountId: string): Promise<BackupMeta[]>;
  findById(accountId: string, id: string): Promise<BackupMeta | null>;
  /** All refs for the account (for retention pruning). */
  listRefs(accountId: string): Promise<BackupRef[]>;
  deleteByIds(accountId: string, ids: string[]): Promise<void>;
}

/** R2 blob seam — keys are server-generated. */
export interface BlobStore {
  put(key: string, body: ArrayBuffer | Uint8Array, contentType: string): Promise<void>;
  /** Raw bytes, or null when absent. */
  get(key: string): Promise<ArrayBuffer | null>;
  delete(keys: string[]): Promise<void>;
}

export interface BackupEntitlement {
  backup: boolean;
  /** Tier drives the retention policy (count + ttl). */
  tier: string;
}
