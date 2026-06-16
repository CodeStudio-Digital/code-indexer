/**
 * Account — the identity aggregate root. It deliberately does NOT carry the
 * password hash (that lives only in the credential read path, never in the
 * entity that flows up to use-cases / the interface layer).
 */
import { type AccountId, asAccountId } from '@cloudstudio/cloud-kernel';

export type AccountStatus = 'active' | 'locked' | 'deleted';

export interface AccountRow {
  id: string;
  email: string;
  email_canonical: string;
  status: string;
  email_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export class Account {
  constructor(
    readonly id: AccountId,
    readonly email: string,
    readonly emailCanonical: string,
    readonly status: AccountStatus,
    readonly emailVerifiedAt: string | null,
    readonly createdAt: string,
    readonly updatedAt: string,
  ) {}

  get isActive(): boolean {
    return this.status === 'active';
  }
  get isEmailVerified(): boolean {
    return this.emailVerifiedAt != null;
  }

  static fromRow(r: AccountRow): Account {
    return new Account(
      asAccountId(r.id),
      r.email,
      r.email_canonical,
      (r.status as AccountStatus) ?? 'active',
      r.email_verified_at,
      r.created_at,
      r.updated_at,
    );
  }

  /** Renderer/wire-safe projection (no internals). */
  toPublic(): { id: string; email: string; emailVerified: boolean; status: AccountStatus } {
    return { id: this.id, email: this.email, emailVerified: this.isEmailVerified, status: this.status };
  }
}
