/**
 * Typed errors for the documentation pipeline. Mirrors the `ProjectError`
 * shape used by `IndexProjectUseCase` so HTTP routes can map kinds → status
 * codes uniformly.
 */
export type DocErrorKind =
  | 'not_found'
  | 'already_running'
  | 'bad_request'
  | 'too_large'
  | 'crawl_blocked'
  | 'provider_missing'
  | 'internal';

export class DocError extends Error {
  constructor(public readonly kind: DocErrorKind, message: string) {
    super(message);
    this.name = 'DocError';
  }
}

const STATUS: Record<DocErrorKind, number> = {
  not_found: 404,
  already_running: 409,
  bad_request: 400,
  too_large: 413,
  crawl_blocked: 422,
  provider_missing: 503,
  internal: 500,
};

export function docErrorStatus(kind: DocErrorKind): number {
  return STATUS[kind] ?? 500;
}
