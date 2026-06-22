/**
 * Backups composition root — D1 backup repo + R2 blob store → BackupService, plus
 * billing entitlements for the route's `backup` gate + tier-driven retention. Per
 * request, mirroring the other roots.
 */
import { createD1Executor } from './infra/d1/d1-executor.js';
import { createBackupRepo } from './infra/d1/backup-repo.js';
import { createBlobStore } from './infra/r2-blob-store.js';
import { cryptoIdGen, systemClock } from './infra/runtime.js';
import { BackupService } from './backups/service.js';
import type { Env } from './env.js';

export interface BackupBundle {
  service: BackupService;
}

export function createBackupBundle(env: Env): BackupBundle {
  const db = createD1Executor(env.DB);
  const repo = createBackupRepo(db);
  const blobs = createBlobStore(env.ASSETS);
  return { service: new BackupService(repo, blobs, cryptoIdGen, systemClock) };
}
