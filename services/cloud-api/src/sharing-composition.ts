/**
 * Sharing composition root — wires D1 share repo + Ed25519 signer + billing
 * entitlements → sharing use-cases. Per request, mirroring the other roots. The
 * signer key is optional: absent ⇒ `signerConfigured=false` and the create route
 * returns 501 (reads/list/revoke still work).
 */
import {
  CreateShareUseCase,
  GetPublicShareUseCase,
  ListOwnSharesUseCase,
  RevokeShareUseCase,
} from '@cloudstudio/cloud-sharing';
import { createD1Executor } from './infra/d1/d1-executor.js';
import { createShareRepo } from './infra/d1/share-repo.js';
import { createSnapshotSigner } from './infra/ed25519-signer.js';
import { cryptoIdGen, systemClock } from './infra/runtime.js';
import { createBillingBundle } from './billing-composition.js';
import type { Env } from './env.js';

export interface SharingBundle {
  createShare: CreateShareUseCase;
  getPublic: GetPublicShareUseCase;
  list: ListOwnSharesUseCase;
  revoke: RevokeShareUseCase;
  getEntitlements: ReturnType<typeof createBillingBundle>['getEntitlements'];
  signerConfigured: boolean;
}

export function createSharingBundle(env: Env): SharingBundle {
  const db = createD1Executor(env.DB);
  const repo = createShareRepo(db);
  const signer = createSnapshotSigner(env.SHARE_SIGNING_PRIVKEY ?? '');
  return {
    createShare: new CreateShareUseCase(repo, signer, cryptoIdGen, systemClock),
    getPublic: new GetPublicShareUseCase(repo, systemClock),
    list: new ListOwnSharesUseCase(repo),
    revoke: new RevokeShareUseCase(repo, systemClock),
    getEntitlements: createBillingBundle(env).getEntitlements,
    signerConfigured: !!env.SHARE_SIGNING_PRIVKEY,
  };
}
