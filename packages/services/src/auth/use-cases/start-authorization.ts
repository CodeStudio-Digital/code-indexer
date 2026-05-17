import { AuthCode, type CodeChallengeMethod } from '../domain/auth-code.js';
import { ScopeSet } from '../domain/scope.js';
import type { AuthCodeRepo } from '../ports/auth-code-repository.js';
import type { Clock } from '../ports/clock.js';
import type { OAuthClientReaderRepo } from '../ports/oauth-client-repository.js';
import type { RandomId } from '../ports/random-id.js';
import { err, ok, type Result } from './result.js';

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface StartAuthInput {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  codeChallenge: string;
  codeChallengeMethod: CodeChallengeMethod;
}

export interface StartAuthOutput {
  code: string;
}

/**
 * StartAuthorization — validates client+redirect_uri+PKCE challenge and
 * issues a short-lived authorization code. Scopes requested by the client
 * are intersected with the scopes the client is registered for.
 */
export class StartAuthorization {
  constructor(
    private readonly clients: OAuthClientReaderRepo,
    private readonly codes: AuthCodeRepo,
    private readonly random: RandomId,
    private readonly clock: Clock,
  ) {}

  execute(input: StartAuthInput): Result<StartAuthOutput> {
    const client = this.clients.findById(input.clientId);
    if (!client || client.isRevoked()) {
      return err({ kind: 'client_not_found', clientId: input.clientId });
    }
    if (!client.allowsRedirectUri(input.redirectUri)) {
      return err({ kind: 'invalid_redirect_uri' });
    }
    if (!input.codeChallenge || input.codeChallengeMethod !== 'S256') {
      return err({ kind: 'invalid_pkce' });
    }

    const grantedScopes = ScopeSet.of(input.scopes).intersect(client.scopes);

    const code = this.random.token(32);
    this.codes.insert(
      AuthCode.issue({
        code,
        clientId: client.clientId,
        redirectUri: input.redirectUri,
        scopes: grantedScopes,
        codeChallenge: input.codeChallenge,
        codeChallengeMethod: input.codeChallengeMethod,
        ttlMs: CODE_TTL_MS,
        now: this.clock.now(),
      }),
    );

    return ok({ code });
  }
}
