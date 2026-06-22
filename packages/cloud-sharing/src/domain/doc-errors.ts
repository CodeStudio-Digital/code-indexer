/** DocError — the hosted-docs error union + exhaustive status mapper, mirroring
 *  the ShareError pattern. 402s drive the upsell; 410 marks a revoked link. */
import type { DomainError, HttpStatusMapper } from '@cloudstudio/cloud-kernel';

export type DocError =
  | (DomainError & { code: 'doc_not_found' })
  | (DomainError & { code: 'doc_revoked' })
  | (DomainError & { code: 'docs_not_entitled' })
  | (DomainError & { code: 'docs_quota_exceeded'; details?: { limit: number } })
  | (DomainError & { code: 'spec_too_large'; details?: { maxBytes: number } })
  | (DomainError & { code: 'spec_invalid' });

type Code = DocError['code'];

const STATUS: Record<Code, number> = {
  doc_not_found: 404,
  doc_revoked: 410, // Gone — the link existed but is dead
  docs_not_entitled: 402, // Payment Required — drives the upsell
  docs_quota_exceeded: 402,
  spec_too_large: 413,
  spec_invalid: 422,
};

export const docHttpStatus: HttpStatusMapper<DocError> = (e) => STATUS[e.code];

export const DocErrors = {
  notFound: (): DocError => ({ code: 'doc_not_found', message: 'Docs not found.' }),
  revoked: (): DocError => ({ code: 'doc_revoked', message: 'These docs were revoked.' }),
  notEntitled: (): DocError => ({
    code: 'docs_not_entitled',
    message: 'Hosting API docs requires an active subscription or trial.',
  }),
  quotaExceeded: (limit: number): DocError => ({
    code: 'docs_quota_exceeded',
    message: 'You have reached your hosted-docs limit.',
    details: { limit },
  }),
  tooLarge: (maxBytes: number): DocError => ({
    code: 'spec_too_large',
    message: 'This API spec is too large to host.',
    details: { maxBytes },
  }),
  invalid: (reason: string): DocError => ({ code: 'spec_invalid', message: `Invalid API spec: ${reason}.` }),
};
