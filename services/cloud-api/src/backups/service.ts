/**
 * Backup use-cases: create (store blob in R2 + index in D1, then prune per the
 * tier's retention), list, download, delete. Owner-guarded throughout. Pruning
 * runs on every create so expired/over-quota backups are reclaimed lazily without
 * needing a cron (a scheduled sweep can call `prune` too). The blob is opaque to
 * the server — it's the client's gzipped metadata bundle.
 */
import type { Clock, IdGen } from '@cloudstudio/cloud-kernel';
import { expiryFor, retentionFor, selectPrunable } from './retention.js';
import type { BackupMeta, BackupRepo, BlobStore } from './types.js';

export interface CreateBackupInput {
  accountId: string;
  tier: string;
  blob: ArrayBuffer;
  contentSha256: string;
  label: string;
  manifest: Record<string, unknown>;
}

export class BackupService {
  constructor(
    private readonly repo: BackupRepo,
    private readonly blobs: BlobStore,
    private readonly ids: IdGen,
    private readonly clock: Clock,
  ) {}

  async create(input: CreateBackupInput): Promise<{ id: string; byteSize: number; expiresAtMs: number | null; prunedCount: number }> {
    const id = this.ids.uuid();
    const r2Key = `backups/${input.accountId}/${id}.gz`;
    const now = this.clock.now();
    const policy = retentionFor(input.tier);

    await this.blobs.put(r2Key, input.blob, 'application/gzip');
    const meta: BackupMeta = {
      id,
      r2Key,
      label: input.label.slice(0, 200),
      byteSize: input.blob.byteLength,
      contentSha256: input.contentSha256,
      manifest: input.manifest,
      createdAtMs: now,
      expiresAtMs: expiryFor(policy, now),
    };
    await this.repo.insert(input.accountId, meta);

    const prunedCount = await this.prune(input.accountId, input.tier, now);
    return { id, byteSize: meta.byteSize, expiresAtMs: meta.expiresAtMs, prunedCount };
  }

  async list(accountId: string): Promise<BackupMeta[]> {
    return this.repo.listByOwner(accountId);
  }

  /** Owner-guarded blob fetch (for download/restore). Null when not found/owned. */
  async download(accountId: string, id: string): Promise<{ blob: ArrayBuffer; meta: BackupMeta } | null> {
    const meta = await this.repo.findById(accountId, id);
    if (!meta) return null;
    const blob = await this.blobs.get(meta.r2Key);
    if (!blob) return null;
    return { blob, meta };
  }

  async remove(accountId: string, id: string): Promise<boolean> {
    const meta = await this.repo.findById(accountId, id);
    if (!meta) return false;
    await this.blobs.delete([meta.r2Key]);
    await this.repo.deleteByIds(accountId, [id]);
    return true;
  }

  /** Delete expired + over-quota backups (R2 + D1). Returns how many were removed. */
  async prune(accountId: string, tier: string, nowMs: number): Promise<number> {
    const refs = await this.repo.listRefs(accountId);
    const ids = selectPrunable(refs, retentionFor(tier), nowMs);
    if (!ids.length) return 0;
    const keys = refs.filter((r) => ids.includes(r.id)).map((r) => r.r2Key);
    await this.blobs.delete(keys);
    await this.repo.deleteByIds(accountId, ids);
    return ids.length;
  }
}
