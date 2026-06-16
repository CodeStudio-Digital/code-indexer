/**
 * Identity composition root — wires env bindings → infrastructure adapters →
 * application use-cases. Built per request (cheap: the heavy singletons —
 * Argon2id WASM, the imported HMAC key — are module-level; this only closes a
 * few functions over `env.DB`). Mirrors `apps/http-api/auth/composition.ts`.
 */
import {
  Challenge2faUseCase,
  Confirm2faUseCase,
  Disable2faUseCase,
  Enroll2faUseCase,
  ListSessionsUseCase,
  LoginUseCase,
  LogoutAllUseCase,
  LogoutUseCase,
  RefreshUseCase,
  RequestPasswordResetUseCase,
  ResetPasswordUseCase,
  SendVerificationEmailUseCase,
  SessionIssuer,
  SignupUseCase,
  VerifyEmailUseCase,
} from '@cloudstudio/cloud-identity';
import type { AccessClaims, AccountRepo, SessionRepo } from '@cloudstudio/cloud-identity';
import { pbkdf2Hasher } from './infra/pbkdf2-hasher.js';
import { createAccessTokenSigner } from './infra/access-token-signer.js';
import { createAccountRepo } from './infra/d1/account-repo.js';
import { createD1Executor } from './infra/d1/d1-executor.js';
import { createRefreshTokenRepo } from './infra/d1/refresh-token-repo.js';
import { createSessionRepo } from './infra/d1/session-repo.js';
import { opaqueTokens } from './infra/opaque-tokens.js';
import { createLoginThrottle } from './infra/login-throttle.js';
import { createChallengeTokens } from './infra/challenge-token.js';
import { createTwoFactorRepo } from './infra/d1/two-factor-repo.js';
import { createAuthTokenRepo } from './infra/d1/auth-token-repo.js';
import { createEmailSender } from './infra/email-sender.js';
import { createMailComposer } from './infra/mail-composer.js';
import { totp } from './infra/totp.js';
import { recoveryCodes } from './infra/recovery-codes.js';
import { cryptoIdGen, systemClock } from './infra/runtime.js';
import type { Env } from './env.js';

export interface IdentityBundle {
  signup: SignupUseCase;
  login: LoginUseCase;
  refresh: RefreshUseCase;
  logout: LogoutUseCase;
  logoutAll: LogoutAllUseCase;
  listSessions: ListSessionsUseCase;
  enroll2fa: Enroll2faUseCase;
  confirm2fa: Confirm2faUseCase;
  disable2fa: Disable2faUseCase;
  challenge2fa: Challenge2faUseCase;
  sendVerification: SendVerificationEmailUseCase;
  verifyEmail: VerifyEmailUseCase;
  requestPasswordReset: RequestPasswordResetUseCase;
  resetPassword: ResetPasswordUseCase;
  accounts: AccountRepo;
  sessions: SessionRepo;
  verifyAccess: (token: string) => Promise<AccessClaims | null>;
}

export function createIdentityBundle(env: Env): IdentityBundle {
  const db = createD1Executor(env.DB);
  const accounts = createAccountRepo(db);
  const sessions = createSessionRepo(db);
  const refreshTokens = createRefreshTokenRepo(db);
  const signer = createAccessTokenSigner(env.ACCESS_SIGNING_SECRET, systemClock.now);
  const issuer = new SessionIssuer(sessions, refreshTokens, signer, opaqueTokens, cryptoIdGen, systemClock);
  const throttle = createLoginThrottle(env.LOGIN_THROTTLE);
  const twoFactor = createTwoFactorRepo(db, cryptoIdGen);
  const authTokens = createAuthTokenRepo(db);
  const challengeTokens = createChallengeTokens(authTokens, opaqueTokens, cryptoIdGen, systemClock);
  const mail = createMailComposer(env.APP_BASE_URL);
  const sender = createEmailSender(env.EMAIL, env.EMAIL_FROM);

  return {
    signup: new SignupUseCase(accounts, pbkdf2Hasher, issuer, cryptoIdGen, systemClock),
    login: new LoginUseCase(accounts, pbkdf2Hasher, issuer, throttle, twoFactor, challengeTokens),
    refresh: new RefreshUseCase(refreshTokens, sessions, accounts, opaqueTokens, issuer, systemClock),
    logout: new LogoutUseCase(sessions, refreshTokens, systemClock),
    logoutAll: new LogoutAllUseCase(sessions, refreshTokens, systemClock),
    listSessions: new ListSessionsUseCase(sessions),
    enroll2fa: new Enroll2faUseCase(totp, twoFactor),
    confirm2fa: new Confirm2faUseCase(totp, twoFactor, recoveryCodes, throttle),
    disable2fa: new Disable2faUseCase(totp, twoFactor),
    challenge2fa: new Challenge2faUseCase(challengeTokens, twoFactor, totp, recoveryCodes, accounts, issuer, throttle),
    sendVerification: new SendVerificationEmailUseCase(authTokens, opaqueTokens, mail, sender, cryptoIdGen, systemClock),
    verifyEmail: new VerifyEmailUseCase(authTokens, opaqueTokens, accounts, systemClock),
    requestPasswordReset: new RequestPasswordResetUseCase(
      accounts,
      authTokens,
      opaqueTokens,
      mail,
      sender,
      cryptoIdGen,
      systemClock,
    ),
    resetPassword: new ResetPasswordUseCase(
      accounts,
      authTokens,
      opaqueTokens,
      pbkdf2Hasher,
      sessions,
      refreshTokens,
      systemClock,
    ),
    accounts,
    sessions,
    verifyAccess: (token) => signer.verify(token),
  };
}
