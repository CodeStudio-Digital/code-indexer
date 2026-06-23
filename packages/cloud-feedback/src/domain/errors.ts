/** FeedbackError — discriminated union + exhaustive status mapper. */
import type { DomainError, HttpStatusMapper } from '@cloudstudio/cloud-kernel';

export type FeedbackError =
  | (DomainError & { code: 'feedback_validation' })
  | (DomainError & { code: 'human_verification_required' })
  | (DomainError & { code: 'human_verification_failed' })
  | (DomainError & { code: 'feedback_rate_limited'; details?: { retryAfterMs: number } })
  | (DomainError & { code: 'feedback_not_found' })
  | (DomainError & { code: 'attachment_not_owned' })
  | (DomainError & { code: 'attachment_too_large'; details?: { maxBytes: number } })
  | (DomainError & { code: 'attachment_type_rejected'; details?: { detected: string } })
  | (DomainError & { code: 'storage_unavailable' });

type Code = FeedbackError['code'];

const STATUS: Record<Code, number> = {
  feedback_validation: 400,
  human_verification_required: 403,
  human_verification_failed: 403,
  feedback_rate_limited: 429,
  feedback_not_found: 404,
  attachment_not_owned: 403,
  attachment_too_large: 413,
  attachment_type_rejected: 415,
  storage_unavailable: 503,
};

export const feedbackHttpStatus: HttpStatusMapper<FeedbackError> = (e) => STATUS[e.code];

export const FeedbackErrors = {
  validation: (): FeedbackError => ({ code: 'feedback_validation', message: 'Invalid feedback.' }),
  humanRequired: (): FeedbackError => ({ code: 'human_verification_required', message: 'Verification required.' }),
  humanFailed: (): FeedbackError => ({ code: 'human_verification_failed', message: 'Verification failed.' }),
  rateLimited: (retryAfterMs: number): FeedbackError => ({ code: 'feedback_rate_limited', message: 'Too many submissions. Try again later.', details: { retryAfterMs } }),
  notFound: (): FeedbackError => ({ code: 'feedback_not_found', message: 'Feedback not found.' }),
  attachmentNotOwned: (): FeedbackError => ({ code: 'attachment_not_owned', message: 'Unknown attachment.' }),
  tooLarge: (maxBytes: number): FeedbackError => ({ code: 'attachment_too_large', message: 'Attachment too large.', details: { maxBytes } }),
  typeRejected: (detected: string): FeedbackError => ({ code: 'attachment_type_rejected', message: 'Unsupported attachment type.', details: { detected } }),
  storage: (): FeedbackError => ({ code: 'storage_unavailable', message: 'Could not store the attachment.' }),
};
