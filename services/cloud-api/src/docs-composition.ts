/**
 * Docs composition root — wires D1 doc repo + Ed25519 signer (reused from
 * sharing) + billing entitlements → hosted-docs use-cases. Per request, mirroring
 * the other roots. The signer key is optional: absent ⇒ `signerConfigured=false`
 * and the publish route returns 501 (reads/list/revoke still work).
 */
import {
  PublishDocUseCase,
  GetPublicDocUseCase,
  ListOwnDocsUseCase,
  RevokeDocUseCase,
} from '@cloudstudio/cloud-sharing';
import { createD1Executor } from './infra/d1/d1-executor.js';
import { createDocRepo } from './infra/d1/doc-repo.js';
import { createSnapshotSigner } from './infra/ed25519-signer.js';
import { cryptoIdGen, systemClock } from './infra/runtime.js';
import type { Env } from './env.js';

export interface DocsBundle {
  publish: PublishDocUseCase;
  getPublic: GetPublicDocUseCase;
  list: ListOwnDocsUseCase;
  revoke: RevokeDocUseCase;
  signerConfigured: boolean;
}

export function createDocsBundle(env: Env): DocsBundle {
  const db = createD1Executor(env.DB);
  const repo = createDocRepo(db);
  const signer = createSnapshotSigner(env.SHARE_SIGNING_PRIVKEY ?? '');
  return {
    publish: new PublishDocUseCase(repo, signer, cryptoIdGen, systemClock),
    getPublic: new GetPublicDocUseCase(repo),
    list: new ListOwnDocsUseCase(repo),
    revoke: new RevokeDocUseCase(repo, systemClock),
    signerConfigured: !!env.SHARE_SIGNING_PRIVKEY,
  };
}
