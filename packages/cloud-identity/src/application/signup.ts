/**
 * SignupUseCase — create an account, then open a session immediately (good UX;
 * the account starts UNVERIFIED). Email verification is enforced downstream by a
 * `requireVerifiedEmail` gate on sensitive routes (Phase 2), not by blocking the
 * session here. Mirrors the on-device auth use-case style (Result<T>, no throws).
 */
import { type Result, ok, err, type IdGen, type Clock, asAccountId } from '@cloudstudio/cloud-kernel';
import { Email } from '../domain/email.js';
import { Password } from '../domain/password.js';
import { Account } from '../domain/account.js';
import { IdentityErrors, type IdentityError } from '../domain/errors.js';
import type { AccountRepo, PasswordHasher } from '../domain/ports.js';
import { SessionIssuer, type IssuedSession } from './session-issuer.js';

export interface SignupInput {
  emailRaw: string;
  passwordRaw: string;
  userAgent: string | null;
  ipHash: string | null;
}
export interface SignupOutput {
  account: ReturnType<Account['toPublic']>;
  session: IssuedSession;
}

export class SignupUseCase {
  constructor(
    private readonly accounts: AccountRepo,
    private readonly hasher: PasswordHasher,
    private readonly issuer: SessionIssuer,
    private readonly ids: IdGen,
    private readonly clock: Clock,
  ) {}

  async execute(input: SignupInput): Promise<Result<SignupOutput, IdentityError>> {
    const emailRes = Email.create(input.emailRaw);
    if (!emailRes.ok) return emailRes;
    const passwordRes = Password.create(input.passwordRaw);
    if (!passwordRes.ok) return passwordRes;
    const email = emailRes.value;

    const existing = await this.accounts.findByCanonical(email.canonical);
    if (existing) return err(IdentityErrors.emailTaken());

    const passwordHash = await this.hasher.hash(passwordRes.value.plain);
    const id = asAccountId(this.ids.uuid());
    await this.accounts.insert({ id, email: email.value, emailCanonical: email.canonical, passwordHash });

    const now = this.clock.isoNow();
    const account = new Account(id, email.value, email.canonical, 'active', null, now, now);
    const session = await this.issuer.issue({
      accountId: id,
      emailVerified: false,
      userAgent: input.userAgent,
      ipHash: input.ipHash,
    });
    return ok({ account: account.toPublic(), session });
  }
}
