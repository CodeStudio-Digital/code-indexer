/** ShareError — the sharing context's discriminated-union error + exhaustive
 *  status mapper, mirroring the identity/billing pattern. */
import type { DomainError, HttpStatusMapper } from '@cloudstudio/cloud-kernel';

export type ShareError =
  | (DomainError & { code: 'share_not_found' })
  | (DomainError & { code: 'share_revoked' })
  | (DomainError & { code: 'share_expired' })
  | (DomainError & { code: 'share_forbidden' })
  | (DomainError & { code: 'sharing_not_entitled' })
  | (DomainError & { code: 'share_quota_exceeded'; details?: { limit: number } })
  | (DomainError & { code: 'snapshot_too_large'; details?: { maxBytes: number } })
  | (DomainError & { code: 'snapshot_invalid' });

type Code = ShareError['code'];

const STATUS: Record<Code, number> = {
  share_not_found: 404,
  share_revoked: 410, // Gone — the link existed but is dead
  share_expired: 410,
  share_forbidden: 403,
  sharing_not_entitled: 402, // Payment Required — drives the upsell
  share_quota_exceeded: 402,
  snapshot_too_large: 413,
  snapshot_invalid: 422,
};

export const shareHttpStatus: HttpStatusMapper<ShareError> = (e) => STATUS[e.code];

export const ShareErrors = {
  notFound: (): ShareError => ({ code: 'share_not_found', message: 'Share not found.' }),
  revoked: (): ShareError => ({ code: 'share_revoked', message: 'This share was revoked.' }),
  expired: (): ShareError => ({ code: 'share_expired', message: 'This share has expired.' }),
  forbidden: (): ShareError => ({ code: 'share_forbidden', message: 'Not your share.' }),
  notEntitled: (): ShareError => ({
    code: 'sharing_not_entitled',
    message: 'Sharing requires an active subscription or trial.',
  }),
  quotaExceeded: (limit: number): ShareError => ({
    code: 'share_quota_exceeded',
    message: 'You have reached your active-share limit.',
    details: { limit },
  }),
  tooLarge: (maxBytes: number): ShareError => ({
    code: 'snapshot_too_large',
    message: 'This conversation is too large to share.',
    details: { maxBytes },
  }),
  invalid: (reason: string): ShareError => ({ code: 'snapshot_invalid', message: `Invalid snapshot: ${reason}.` }),
};
