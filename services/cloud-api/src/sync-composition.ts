/**
 * Sync composition root — wires the account-scoped D1 sync repo + a SHA-256 hasher
 * → the SyncService, plus billing entitlements for the route's `sync` gate. Per
 * request, mirroring the other roots. The repo is account-scoped, so the bundle
 * takes the authenticated accountId.
 */
import { createD1Executor } from './infra/d1/d1-executor.js';
import { createSyncRepo } from './infra/d1/sync-repo.js';
import { sha256Hex } from './infra/hash.js';
import { cryptoIdGen, systemClock } from './infra/runtime.js';
import { SyncService } from './sync/service.js';
import type { Env } from './env.js';

export interface SyncBundle {
  service: SyncService;
}

export function createSyncBundle(env: Env, accountId: string): SyncBundle {
  const db = createD1Executor(env.DB);
  const repo = createSyncRepo(db, accountId, cryptoIdGen, systemClock);
  return { service: new SyncService(repo, sha256Hex) };
}
