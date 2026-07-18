import type { AuthContext } from '../domain/auth-context.js';
import { ScopeSet } from '../domain/scope.js';
import type { ApiTokenReaderRepo } from '../ports/api-token-repository.js';
import type { Clock } from '../ports/clock.js';
import type { TokenHasher } from '../ports/token-hasher.js';
import type { TokenSigner } from '../ports/token-signer.js';
import { err, ok, type Result } from './result.js';

export interface ValidateInput {
  rawBearer: string;
  requestId: string;
  requestHeaders: Readonly<Record<string, string>>;
}

/**
 * ValidateBearerToken — resolves a raw bearer string into an AuthContext.
 *
 * Strategy: try JWT first (OAuth access token), fallback to opaque API token
 * lookup. Both paths converge on the same AuthContext shape, so callers
 * (middleware, scope enforcement) remain agnostic of the underlying type.
 */
export class ValidateBearerToken {
  constructor(
    private readonly apiTokens: ApiTokenReaderRepo,
    private readonly signer: TokenSigner,
    private readonly hasher: TokenHasher,
    private readonly clock: Clock,
  ) {}

  execute(input: ValidateInput): Result<AuthContext> {
    if (!input.rawBearer) return err({ kind: 'missing_bearer' });

    const jwtCtx = this.tryJwt(input);
    if (jwtCtx) return ok(jwtCtx);

    return this.tryApiToken(input);
  }

  private tryJwt(input: ValidateInput): AuthContext | null {
    if (!looksLikeJwt(input.rawBearer)) return null;
    const claims = this.signer.verify(input.rawBearer);
    if (!claims) return null;
    return {
      principal: claims.sub,
      tokenType: 'oauth',
      scopes: ScopeSet.of(typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : []),
      expiresAt: claims.exp * 1000,
      requestId: input.requestId,
      requestHeaders: input.requestHeaders,
    };
  }

  private tryApiToken(input: ValidateInput): Result<AuthContext> {
    const hash = this.hasher.hash(input.rawBearer);
    const token = this.apiTokens.findByHash(hash);
    if (!token) return err({ kind: 'invalid_token' });
    if (token.isRevoked()) return err({ kind: 'revoked_token' });

    const now = this.clock.now();
    if (token.isExpired(now)) return err({ kind: 'expired_token' });

    this.apiTokens.touchLastUsed(token.id, now);

    return ok({
      principal: token.id,
      tokenType: 'api_token',
      scopes: token.scopes,
      expiresAt: token.expiresAt,
      requestId: input.requestId,
      requestHeaders: input.requestHeaders,
      tier: token.tier,
      policy: token.policy,
    });
  }
}

function looksLikeJwt(token: string): boolean {
  return token.split('.').length === 3;
}
