/**
 * SessionIssuer — the single place tokens are minted, shared by signup, login,
 * and refresh. `issue()` opens a NEW session (signup/login); `rotate()` mints a
 * fresh token pair WITHIN an existing session + rotation family (refresh).
 *
 * Token model (locked decision #5): short-lived signed access token + opaque
 * rotating refresh token (only its SHA-256 hash is stored). TTLs are env-tunable
 * later via the composition root; the defaults here are the policy baseline.
 */
import type { Clock, IdGen, AccountId, SessionId } from '@cloudstudio/cloud-kernel';
import { asSessionId } from '@cloudstudio/cloud-kernel';
import type {
  AccessTokenSigner,
  OpaqueTokenFactory,
  SessionRepo,
  RefreshTokenRepo,
} from '../domain/ports.js';

export interface IssuedSession {
  sessionId: string;
  accessToken: string;
  accessExpiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
}

const ACCESS_TTL_S = 15 * 60; // 15 minutes
const REFRESH_TTL_S = 30 * 24 * 60 * 60; // 30 days (sliding on each rotation)

export class SessionIssuer {
  constructor(
    private readonly sessions: SessionRepo,
    private readonly refreshTokens: RefreshTokenRepo,
    private readonly signer: AccessTokenSigner,
    private readonly opaque: OpaqueTokenFactory,
    private readonly ids: IdGen,
    private readonly clock: Clock,
  ) {}

  /** Open a brand-new session (signup / login). */
  async issue(input: {
    accountId: AccountId;
    emailVerified: boolean;
    userAgent: string | null;
    ipHash: string | null;
  }): Promise<IssuedSession> {
    const sessionId = asSessionId(this.ids.uuid());
    await this.sessions.insert({
      id: sessionId,
      accountId: input.accountId,
      userAgent: input.userAgent,
      ipHash: input.ipHash,
    });
    return this.mint(sessionId, input.accountId, input.emailVerified, this.ids.uuid(), null);
  }

  /** Rotate within an existing session + family (refresh). */
  async rotate(input: {
    sessionId: SessionId;
    accountId: AccountId;
    emailVerified: boolean;
    familyId: string;
    prevId: string;
  }): Promise<IssuedSession> {
    await this.sessions.touch(input.sessionId, this.clock.isoNow());
    return this.mint(input.sessionId, input.accountId, input.emailVerified, input.familyId, input.prevId);
  }

  private async mint(
    sessionId: SessionId,
    accountId: AccountId,
    emailVerified: boolean,
    familyId: string,
    prevId: string | null,
  ): Promise<IssuedSession> {
    const { token: refreshToken, hash } = await this.opaque.issue();
    const expiresAtIso = new Date(this.clock.now() + REFRESH_TTL_S * 1000).toISOString();
    await this.refreshTokens.insert({
      id: this.ids.uuid(),
      sessionId,
      accountId,
      tokenHash: hash,
      familyId,
      prevId,
      expiresAtIso,
    });
    const accessToken = await this.signer.sign({ sub: accountId, sid: sessionId, ev: emailVerified }, ACCESS_TTL_S);
    return {
      sessionId,
      accessToken,
      accessExpiresIn: ACCESS_TTL_S,
      refreshToken,
      refreshExpiresIn: REFRESH_TTL_S,
    };
  }
}
