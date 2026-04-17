/**
 * Domain errors for project use-cases. Each carries an HTTP status code hint
 * so route handlers can map them back to responses without importing the
 * use-case internals.
 */
export type ProjectErrorKind =
  | 'invalid_input' // 400
  | 'not_found' //     404
  | 'conflict'; //     409

export class ProjectError extends Error {
  constructor(public readonly kind: ProjectErrorKind, message: string) {
    super(message);
    this.name = 'ProjectError';
  }

  /** Map domain error kind → HTTP status code. */
  get statusCode(): 400 | 404 | 409 {
    switch (this.kind) {
      case 'invalid_input': return 400;
      case 'not_found':     return 404;
      case 'conflict':      return 409;
    }
  }
}
