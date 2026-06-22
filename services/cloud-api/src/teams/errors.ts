/** TeamError — the teams context error union + exhaustive status mapper. */
import type { DomainError, HttpStatusMapper } from '@cloudstudio/cloud-kernel';

export type TeamError =
  | (DomainError & { code: 'org_not_found' })
  | (DomainError & { code: 'org_forbidden' })
  | (DomainError & { code: 'invite_not_found' })
  | (DomainError & { code: 'invite_expired' })
  | (DomainError & { code: 'invite_used' })
  | (DomainError & { code: 'member_not_found' })
  | (DomainError & { code: 'already_member' })
  | (DomainError & { code: 'last_owner' })
  | (DomainError & { code: 'seats_exhausted'; details?: { seats: number } })
  | (DomainError & { code: 'team_validation'; details?: { reason: string } });

type Code = TeamError['code'];

const STATUS: Record<Code, number> = {
  org_not_found: 404,
  org_forbidden: 403,
  invite_not_found: 404,
  invite_expired: 410,
  invite_used: 409,
  member_not_found: 404,
  already_member: 409,
  last_owner: 409,
  seats_exhausted: 402,
  team_validation: 422,
};

export const teamHttpStatus: HttpStatusMapper<TeamError> = (e) => STATUS[e.code];

export const TeamErrors = {
  orgNotFound: (): TeamError => ({ code: 'org_not_found', message: 'Organization not found.' }),
  forbidden: (): TeamError => ({ code: 'org_forbidden', message: 'You do not have permission for this action.' }),
  inviteNotFound: (): TeamError => ({ code: 'invite_not_found', message: 'Invite not found.' }),
  inviteExpired: (): TeamError => ({ code: 'invite_expired', message: 'This invite has expired.' }),
  inviteUsed: (): TeamError => ({ code: 'invite_used', message: 'This invite was already used or revoked.' }),
  memberNotFound: (): TeamError => ({ code: 'member_not_found', message: 'Member not found.' }),
  alreadyMember: (): TeamError => ({ code: 'already_member', message: 'Already a member of this organization.' }),
  lastOwner: (): TeamError => ({ code: 'last_owner', message: 'An organization must keep at least one owner.' }),
  seatsExhausted: (seats: number): TeamError => ({ code: 'seats_exhausted', message: 'All writer seats are in use — add seats to invite more members.', details: { seats } }),
  validation: (reason: string): TeamError => ({ code: 'team_validation', message: `Invalid: ${reason}.`, details: { reason } }),
};
