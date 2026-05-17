import type { AuthContext } from '../domain/auth-context.js';
import { err, ok, type Result } from './result.js';

/**
 * EnforceScope — pure policy check. Stateless, no I/O.
 * Kept as a use-case (not a static helper) to preserve the composition
 * pattern: callers receive it by interface, not concrete.
 */
export class EnforceScope {
  execute(ctx: AuthContext, required: string): Result<void> {
    if (ctx.scopes.grants(required)) return ok(undefined);
    return err({ kind: 'scope_denied', required, granted: ctx.scopes.values() });
  }
}
