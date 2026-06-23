import { ScopeSet } from './scope.js';

export type CodeChallengeMethod = 'S256';

export interface AuthCodeRow {
  code: string;
  client_id: string;
  redirect_uri: string;
  scopes: string;
  code_challenge: string;
  code_challenge_method: string;
  expires_at: number;
  consumed_at: string | null;
}

/**
 * AuthCode — short-lived authorization code for the PKCE flow.
 * One-time use: `consumed_at` guards replay.
 */
export class AuthCode {
  private constructor(
    readonly code: string,
    readonly clientId: string,
    readonly redirectUri: string,
    readonly scopes: ScopeSet,
    readonly codeChallenge: string,
    readonly codeChallengeMethod: CodeChallengeMethod,
    readonly expiresAt: number,
    readonly consumedAt: number | null,
  ) {}

  static issue(params: {
    code: string;
    clientId: string;
    redirectUri: string;
    scopes: ScopeSet;
    codeChallenge: string;
    codeChallengeMethod: CodeChallengeMethod;
    ttlMs: number;
    now: number;
  }): AuthCode {
    if (!params.codeChallenge) throw new Error('PKCE code_challenge is required');
    if (params.codeChallengeMethod !== 'S256') throw new Error('Only S256 PKCE supported');
    return new AuthCode(
      params.code,
      params.clientId,
      params.redirectUri,
      params.scopes,
      params.codeChallenge,
      params.codeChallengeMethod,
      params.now + params.ttlMs,
      null,
    );
  }

  static fromRow(row: AuthCodeRow): AuthCode {
    return new AuthCode(
      row.code,
      row.client_id,
      row.redirect_uri,
      ScopeSet.fromJson(row.scopes),
      row.code_challenge,
      row.code_challenge_method as CodeChallengeMethod,
      row.expires_at,
      row.consumed_at ? Date.parse(row.consumed_at) : null,
    );
  }

  isUsable(now: number): boolean {
    return this.consumedAt === null && this.expiresAt > now;
  }
}
