/**
 * Identity ports — implemented by infrastructure adapters (Argon2id via WASM,
 * WebCrypto signer/random, D1 repos). Use-cases depend ONLY on these.
 */
import type { Account } from './account.js';
import type { AccountId, SessionId } from '@cloudstudio/cloud-kernel';

/** Password hashing (PBKDF2-HMAC-SHA256; see services/cloud-api/src/infra/pbkdf2-hasher.ts). */
export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, phc: string): Promise<boolean>;
  /** True when `phc` was made with weaker params than current → re-hash on login. */
  needsRehash(phc: string): boolean;
  /** Constant-time dummy verify to equalize timing when an account is absent. */
  dummyVerify(plain: string): Promise<void>;
}

export interface AccessClaims {
  sub: string; // account id
  sid: string; // session id
  ev: boolean; // email verified
  iat: number;
  exp: number;
}
export interface AccessTokenSigner {
  sign(input: { sub: string; sid: string; ev: boolean }, ttlSeconds: number): Promise<string>;
  verify(token: string): Promise<AccessClaims | null>;
}

/** Opaque refresh tokens: raw goes to the client, only the hash is persisted. */
export interface OpaqueTokenFactory {
  issue(): Promise<{ token: string; hash: string }>;
  hashOf(token: string): Promise<string>;
}

/**
 * Per-key login throttle (failed-attempt lockout), backed by a Durable Object.
 * v1 keys by client IP (avoids the "lock out a victim's account by spamming
 * their email" DoS). Next layer: per-account step-up (Turnstile/email challenge).
 */
export interface LoginThrottle {
  check(key: string): Promise<{ locked: boolean; retryAfterMs: number }>;
  recordFailure(key: string): Promise<void>;
  recordSuccess(key: string): Promise<void>;
}

/** TOTP (RFC 6238). Crypto lives in infrastructure (WebCrypto HMAC-SHA1). */
export interface TotpPort {
  generateSecret(): string; // base32
  keyUri(secret: string, accountLabel: string): string; // otpauth://…
  verify(secret: string, code: string): Promise<boolean>; // current ±1 step
}

/** One-time recovery (backup) codes for 2FA. */
export interface RecoveryCodeService {
  generate(count: number): Promise<{ code: string; hash: string }[]>;
  hashOf(code: string): Promise<string>;
}

export interface TwoFactorRepo {
  getSecret(accountId: AccountId): Promise<{ secret: string; enabled: boolean } | null>;
  upsertPending(accountId: AccountId, secret: string): Promise<void>;
  enable(accountId: AccountId): Promise<void>;
  disable(accountId: AccountId): Promise<void>;
  addRecoveryCodes(accountId: AccountId, hashes: string[]): Promise<void>;
  /** Consume an unused recovery code by hash; true if it existed and was unused. */
  consumeRecoveryCode(accountId: AccountId, hash: string): Promise<boolean>;
}

/**
 * Short-lived, SINGLE-USE token proving "password verified, awaiting the 2FA
 * code". Backed by a server-side store (auth_tokens) so a successful challenge
 * can't be replayed to mint multiple sessions.
 */
export interface ChallengeTokenPort {
  issue(accountId: AccountId, ttlSeconds: number): Promise<string>;
  /** Validate WITHOUT consuming — lets the user retry the 2FA code under throttle. */
  verify(token: string): Promise<{ accountId: AccountId } | null>;
  /** Burn the token (single-use); called on a SUCCESSFUL challenge. True if claimed. */
  consume(token: string): Promise<boolean>;
}

/** Transactional email delivery (Cloudflare Email Sending in prod). */
export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}
export interface EmailSender {
  send(message: MailMessage): Promise<void>;
}

/** Builds branded email bodies (knows the app URLs + templates). */
export interface MailComposer {
  verification(to: string, token: string): MailMessage;
  passwordReset(to: string, token: string): MailMessage;
}

/** One-time tokens for email verification + password reset (only hashes stored). */
export type OneTimeTokenPurpose = 'verify_email' | 'password_reset' | 'twofa_challenge';
export interface OneTimeTokenRepo {
  create(input: {
    id: string;
    accountId: AccountId;
    purpose: OneTimeTokenPurpose;
    tokenHash: string;
    expiresAtMs: number; // epoch ms (avoids the SQLite ISO vs datetime('now') gotcha)
  }): Promise<void>;
  /** An unconsumed, unexpired token of this purpose, or null. */
  findValid(tokenHash: string, purpose: OneTimeTokenPurpose): Promise<{ id: string; accountId: AccountId } | null>;
  /** Atomically claim (single-use). True iff THIS call consumed it (gate the
   *  privileged side-effect on this, not on the earlier findValid — closes TOCTOU). */
  consume(id: string, atIso: string): Promise<boolean>;
  consumeAllForAccount(accountId: AccountId, purpose: OneTimeTokenPurpose, atIso: string): Promise<void>;
}

// ── Repositories ────────────────────────────────────────────────────────────

export interface NewAccount {
  id: AccountId;
  email: string;
  emailCanonical: string;
  passwordHash: string;
}
export interface AccountRepo {
  findByCanonical(canonical: string): Promise<Account | null>;
  findById(id: AccountId): Promise<Account | null>;
  /** Login credential read — carries the hash; kept off the entity path. */
  findCredentialByCanonical(canonical: string): Promise<{ account: Account; passwordHash: string } | null>;
  insert(a: NewAccount): Promise<void>;
  updatePasswordHash(id: AccountId, phc: string): Promise<void>;
  markEmailVerified(id: AccountId, atIso: string): Promise<void>;
}

export interface NewSession {
  id: SessionId;
  accountId: AccountId;
  userAgent: string | null;
  ipHash: string | null;
}
export interface SessionInfo {
  id: SessionId;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
}
export interface SessionRepo {
  insert(s: NewSession): Promise<void>;
  findActive(id: SessionId): Promise<{ id: SessionId; accountId: AccountId } | null>;
  touch(id: SessionId, atIso: string): Promise<void>;
  revoke(id: SessionId, atIso: string): Promise<void>;
  listByAccount(accountId: AccountId): Promise<SessionInfo[]>;
  revokeAllForAccount(accountId: AccountId, atIso: string): Promise<void>;
}

export interface NewRefreshToken {
  id: string;
  sessionId: SessionId;
  accountId: AccountId;
  tokenHash: string;
  familyId: string;
  prevId: string | null;
  expiresAtIso: string;
}
export interface StoredRefreshToken {
  id: string;
  sessionId: SessionId;
  accountId: AccountId;
  familyId: string;
  expiresAtIso: string;
  consumedAt: string | null;
  revokedAt: string | null;
}
export interface RefreshTokenRepo {
  insert(t: NewRefreshToken): Promise<void>;
  findByHash(tokenHash: string): Promise<StoredRefreshToken | null>;
  /** One-shot rotation: atomically mark consumed. Returns true iff THIS call
   *  claimed the row (consumed_at was NULL) — false means a concurrent request
   *  already rotated it, i.e. a reuse race the caller must treat as compromise. */
  consume(id: string, atIso: string): Promise<boolean>;
  /** Reuse detected → revoke the entire rotation family. */
  revokeFamily(familyId: string, atIso: string): Promise<void>;
  /** Logout: revoke every refresh token of a session. */
  revokeBySession(sessionId: SessionId, atIso: string): Promise<void>;
  /** Logout-all: revoke every refresh token of an account. */
  revokeByAccount(accountId: AccountId, atIso: string): Promise<void>;
}
