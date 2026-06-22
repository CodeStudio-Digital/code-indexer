/** Pure role policy for organizations. owner > admin > member > viewer. */
import type { OrgRole } from './types.js';

export const ROLE_RANK: Record<OrgRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
export const ROLES: readonly OrgRole[] = ['owner', 'admin', 'member', 'viewer'];

export function isAtLeast(role: OrgRole, min: OrgRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Can `actor` invite members? (admin and up) */
export function canInvite(actor: OrgRole): boolean {
  return isAtLeast(actor, 'admin');
}

/**
 * Can `actor` change `target`'s role from `current` to `next`?
 * - admins+ may manage roles, but never touch an owner and never grant owner
 *   (ownership transfer is a separate, deliberate action — not modeled in v1);
 * - an owner may set any non-owner role on any non-owner.
 */
export function canChangeRole(actor: OrgRole, current: OrgRole, next: OrgRole): boolean {
  if (!isAtLeast(actor, 'admin')) return false;
  if (current === 'owner' || next === 'owner') return false;
  // An admin can't manage a peer admin; only an owner can.
  if (current === 'admin' && actor !== 'owner') return false;
  return true;
}

/**
 * Can `actor` remove `target` (role `targetRole`)? Self-leave is allowed for
 * anyone; otherwise admins+ may remove non-owners, and only an owner may remove
 * an admin. (The "last owner" guard is enforced separately, in the service.)
 */
export function canRemove(actor: OrgRole, targetRole: OrgRole, isSelf: boolean): boolean {
  if (isSelf) return true;
  if (!isAtLeast(actor, 'admin')) return false;
  if (targetRole === 'owner') return false;
  if (targetRole === 'admin' && actor !== 'owner') return false;
  return true;
}

/**
 * Seat / billing policy — the SINGLE SOURCE OF TRUTH for "what counts as a seat".
 * A WRITER (owner / admin / member) occupies one billable seat; VIEWERS ARE ALWAYS
 * FREE — they never consume a seat and are never blocked by seat limits. Seats are
 * PER-ORG: a person who is a writer in N orgs occupies one seat in EACH org's
 * subscription (independent billing — there is intentionally NO cross-org
 * deduplication; each org pays for its own writers).
 */
export function isWriter(role: OrgRole): boolean {
  return role !== 'viewer';
}

/** Count the billable (writer) members; viewers are excluded (free). */
export function countWriters(members: readonly { role: OrgRole }[]): number {
  return members.reduce((n, m) => n + (isWriter(m.role) ? 1 : 0), 0);
}
