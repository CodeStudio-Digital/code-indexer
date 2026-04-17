import { RefreshToken } from '../domain/refresh-token.js';
import type { AuthCodeRepo } from '../ports/auth-code-repository.js';
import type { Clock } from '../ports/clock.js';
import type { OAuthClientReaderRepo } from '../ports/oauth-client-repository.js';
import type { RandomId } from '../ports/random-id.js';
import type { RefreshTokenRepo } from '../ports/refresh-token-repository.js';
import type { TokenHasher } from '../ports/token-hasher.js';
import type { TokenSigner } from '../ports/token-signer.js';
import { verifyPkceS256 } from './pkce.js';
import { err, ok, type Result } from './result.js';

export interface ExchangeInput {
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  clientSecret?: string; // required for confidential clients
}

export interface ExchangeOutput {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
  scope: string; // space-separated
}

export interface ExchangeConfig {
  issuer: string;
  audience: string;
  accessTtlSec: number;
  refreshTtlSec: number;
}

export class ExchangeAuthorizationCode {
  constructor(
    private readonly clients: OAuthClientReaderRepo,
    private readonly codes: AuthCodeRepo,
    private readonly refreshRepo: RefreshTokenRepo,
    private readonly signer: TokenSigner,
    private readonly hasher: TokenHasher,
    private readonly random: RandomId,
    private readonly clock: Clock,
    private readonly config: ExchangeConfig,
  ) {}

  execute(input: ExchangeInput): Result<ExchangeOutput> {
    const client = this.clients.findById(input.clientId);
    if (!client || client.isRevoked()) {
      return err({ kind: 'client_not_found', clientId: input.clientId });
    }

    if (!client.isPublic()) {
      if (!input.clientSecret || !client.clientSecretHash) {
        return err({ kind: 'invalid_grant' });
      }
      if (!this.hasher.verify(input.clientSecret, client.clientSecretHash)) {
        return err({ kind: 'invalid_grant' });
      }
    }

    const now = this.clock.now();
    const code = this.codes.consume(input.code, now);
    if (!code || !code.isUsable(now + 1)) return err({ kind: 'invalid_grant' });
    if (code.clientId !== client.clientId) return err({ kind: 'invalid_grant' });
    if (code.redirectUri !== input.redirectUri) return err({ kind: 'invalid_grant' });

    if (!verifyPkceS256(input.codeVerifier, code.codeChallenge)) {
      return err({ kind: 'invalid_pkce' });
    }

    const nowSec = Math.floor(now / 1000);
    const accessToken = this.signer.sign({
      iss: this.config.issuer,
      sub: client.clientId,
      aud: this.config.audience,
      exp: nowSec + this.config.accessTtlSec,
      iat: nowSec,
      scope: code.scopes.values().join(' '),
      jti: this.random.uuid(),
    });

    const rawRefresh = this.random.token(32);
    this.refreshRepo.insert(
      RefreshToken.issue({
        tokenHash: this.hasher.hash(rawRefresh),
        clientId: client.clientId,
        scopes: code.scopes,
        expiresAt: now + this.config.refreshTtlSec * 1000,
        now,
      }),
    );

    return ok({
      accessToken,
      refreshToken: rawRefresh,
      expiresInSec: this.config.accessTtlSec,
      scope: code.scopes.values().join(' '),
    });
  }
}
