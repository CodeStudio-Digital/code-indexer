/**
 * Single-use 2FA challenge tokens, stored in `auth_tokens` (purpose
 * 'twofa_challenge'). The opaque token goes to the client; only its sha256 hash
 * is kept. `verify` peeks (so the user can retry the code under throttle);
 * `consume` burns it on success so a captured token can't mint extra sessions.
 */
import type { AccountId, Clock, IdGen } from '@cloudstudio/cloud-kernel';
import type { ChallengeTokenPort, OneTimeTokenRepo, OpaqueTokenFactory } from '@cloudstudio/cloud-identity';

export function createChallengeTokens(
  tokens: OneTimeTokenRepo,
  opaque: OpaqueTokenFactory,
  ids: IdGen,
  clock: Clock,
): ChallengeTokenPort {
  return {
    async issue(accountId: AccountId, ttlSeconds: number) {
      const { token, hash } = await opaque.issue();
      await tokens.create({
        id: ids.uuid(),
        accountId,
        purpose: 'twofa_challenge',
        tokenHash: hash,
        expiresAtMs: clock.now() + ttlSeconds * 1000,
      });
      return token;
    },
    async verify(token: string) {
      const row = await tokens.findValid(await opaque.hashOf(token), 'twofa_challenge');
      return row ? { accountId: row.accountId } : null;
    },
    async consume(token: string) {
      const row = await tokens.findValid(await opaque.hashOf(token), 'twofa_challenge');
      return row ? tokens.consume(row.id, clock.isoNow()) : false;
    },
  };
}
