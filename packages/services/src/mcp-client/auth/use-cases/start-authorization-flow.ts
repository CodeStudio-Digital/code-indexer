import type { Clock } from '../support/ports/clock.js';
import type { RandomId } from '../support/ports/random-id.js';
import { PendingAuthorization } from '../domain/pending-authorization.js';
import type { McpOAuthRegistrationReaderRepo } from '../ports/oauth-registration-repository.js';
import type { PendingAuthorizationRepo } from '../ports/pending-authorization-repository.js';
import { generatePkcePair } from './pkce-generator.js';
import { err, ok, type Result } from './result.js';

const PENDING_TTL_MS = 10 * 60 * 1000;

export interface StartInput {
  serverId: string;
}

export interface StartOutput {
  /** URL the admin dashboard opens in a new tab/window. */
  authorizationUrl: string;
  state: string;
}

/**
 * Generates PKCE + state, persists the PendingAuthorization, and assembles
 * the authorization URL for the browser to open.
 */
export class StartAuthorizationFlow {
  constructor(
    private readonly registrations: McpOAuthRegistrationReaderRepo,
    private readonly pending: PendingAuthorizationRepo,
    private readonly random: RandomId,
    private readonly clock: Clock,
  ) {}

  execute(input: StartInput): Result<StartOutput> {
    const reg = this.registrations.findByServerId(input.serverId);
    if (!reg) return err({ kind: 'registration_not_found', serverId: input.serverId });

    this.pending.purgeExpired(this.clock.now());
    const pkce = generatePkcePair();
    const state = this.random.token(24);
    const now = this.clock.now();

    this.pending.insert(
      PendingAuthorization.issue({
        state,
        serverId: input.serverId,
        verifier: pkce.verifier,
        redirectUri: reg.redirectUri,
        scopes: reg.scopes,
        ttlMs: PENDING_TTL_MS,
        now,
      }),
    );

    const url = new URL(reg.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', reg.clientId);
    url.searchParams.set('redirect_uri', reg.redirectUri);
    if (reg.scopes.length) url.searchParams.set('scope', reg.scopes.join(' '));
    if (reg.resourceUrl) url.searchParams.set('resource', reg.resourceUrl);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', pkce.method);

    return ok({ authorizationUrl: url.toString(), state });
  }
}
