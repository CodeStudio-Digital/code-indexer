/**
 * ResolveOAuthIdentityUseCase — map a provider profile (Google/GitHub/Microsoft)
 * to an account WITHOUT enabling account-takeover. This is the security-critical
 * core of browser OAuth (P7-B); it is PURE (ports only) so the rules are unit-
 * tested in isolation. Resolution order is strict:
 *
 *   (a) An existing link on the IMMUTABLE (provider, providerUserId) subject wins
 *       — a later email change at the provider never re-routes the link.
 *   (b) Else, IF the provider asserts the email is VERIFIED and it matches an
 *       existing account's canonical email → link to it. Linking on an UNVERIFIED
 *       email would let anyone who can read a victim's address seize their account,
 *       so (b) is gated on emailVerified === true (the caller/adapter decides that;
 *       e.g. the GitHub adapter must use only the `primary && verified` address).
 *   (c) Else create a fresh password-less account (verified iff the provider said so).
 *
 * The use-case never trusts `email` for linking unless `emailVerified` is true.
 */
import { type Result, ok, err, type IdGen, type Clock, asAccountId } from '@cloudstudio/cloud-kernel';
import { Email } from '../domain/email.js';
import { Account } from '../domain/account.js';
import { IdentityErrors, type IdentityError } from '../domain/errors.js';
import type { AccountRepo, OAuthIdentityRepo } from '../domain/ports.js';

/** A normalized identity resolved from a provider's userinfo/token response. */
export interface OAuthProfile {
  provider: string;
  /** Stable, immutable subject id from the provider (NEVER the email). */
  providerUserId: string;
  email: string | null;
  /** True ONLY when the provider asserts the email is verified (adapter-decided). */
  emailVerified: boolean;
  name: string | null;
}

export type OAuthOutcome = 'linked_existing' | 'matched_email' | 'created';
export interface ResolveOAuthResult {
  account: Account;
  outcome: OAuthOutcome;
}

export class ResolveOAuthIdentityUseCase {
  constructor(
    private readonly accounts: AccountRepo,
    private readonly identities: OAuthIdentityRepo,
    private readonly ids: IdGen,
    private readonly clock: Clock,
  ) {}

  async execute(profile: OAuthProfile): Promise<Result<ResolveOAuthResult, IdentityError>> {
    // (a) Established link on the immutable subject.
    const link = await this.identities.findByProviderUser(profile.provider, profile.providerUserId);
    if (link) {
      const acct = await this.accounts.findById(link.accountId);
      if (!acct) return err(IdentityErrors.accountDeleted()); // dangling link → treat as gone
      const guard = this.activeOrError(acct);
      return guard ?? ok({ account: acct, outcome: 'linked_existing' });
    }

    // Canonicalize once; reused by (b) and (c).
    const emailRes = profile.email ? Email.create(profile.email) : null;

    // (b) Verified-email auto-link to an existing account.
    if (profile.emailVerified && emailRes?.ok) {
      const existing = await this.accounts.findByCanonical(emailRes.value.canonical);
      if (existing) {
        const guard = this.activeOrError(existing);
        if (guard) return guard;
        await this.linkTo(profile, existing.id, emailRes.value.value);
        return ok({ account: existing, outcome: 'matched_email' });
      }
    }

    // (c) Create a fresh account. Needs a usable email (verified or not — an
    //     unverified one just starts the account unverified, like password signup).
    if (!emailRes) return err(IdentityErrors.oauthNoEmail());
    if (!emailRes.ok) return emailRes;
    const email = emailRes.value;
    // If the email already belongs to an account yet we reached (c), the provider
    // did NOT verify it (rule (b) only fires on verified). Refuse: linking would be
    // a takeover and a new account would collide. Send them to password login.
    if (await this.accounts.findByCanonical(email.canonical)) return err(IdentityErrors.emailTaken());
    const id = asAccountId(this.ids.uuid());
    const now = this.clock.isoNow();
    const verifiedAt = profile.emailVerified ? now : null;
    try {
      await this.accounts.insertOAuth({ id, email: email.value, emailCanonical: email.canonical, emailVerifiedAt: verifiedAt });
    } catch {
      // email_canonical UNIQUE race: another request created the account between
      // the check above and this insert. Re-resolve; link only on the verified
      // trust gate, else refuse (never link an unverified collision).
      const raced = await this.accounts.findByCanonical(email.canonical);
      if (raced && profile.emailVerified) {
        const guard = this.activeOrError(raced);
        if (guard) return guard;
        await this.linkTo(profile, raced.id, email.value);
        return ok({ account: raced, outcome: 'matched_email' });
      }
      return err(IdentityErrors.emailTaken());
    }
    await this.linkTo(profile, id, email.value);
    const account = new Account(id, email.value, email.canonical, 'active', verifiedAt, now, now);
    return ok({ account, outcome: 'created' });
  }

  private activeOrError(acct: Account): Result<ResolveOAuthResult, IdentityError> | null {
    if (acct.status === 'deleted') return err(IdentityErrors.accountDeleted());
    if (acct.status === 'locked') return err(IdentityErrors.accountLocked(0));
    return null;
  }

  private linkTo(profile: OAuthProfile, accountId: ReturnType<typeof asAccountId>, emailAtLink: string | null): Promise<void> {
    return this.identities.link({
      id: this.ids.uuid(),
      provider: profile.provider,
      providerUserId: profile.providerUserId,
      accountId,
      emailAtLink,
    });
  }
}
