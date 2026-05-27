import { createHash } from 'node:crypto';

/**
 * Per-runner short-lived ledger of specs the user already rejected. Mirrors
 * the `REJECTED_PLAN_HASHES` pattern in `tools/plan.ts`. Stops the model from
 * re-submitting the same prose with cosmetic tweaks after a rejection.
 * Cleared automatically when a spec is approved (the agent has moved on; a
 * future re-submission would be a legitimately new spec).
 */
export const REJECTED_SPEC_HASHES = new WeakMap<object, Set<string>>();

export function hashSpec(text: string): string {
  return createHash('sha1').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);
}

/** Get-or-create the rejected-hash set for a runner. */
export function getRejectedSet(runner: unknown): Set<string> {
  const key = runner as object;
  let set = REJECTED_SPEC_HASHES.get(key);
  if (!set) {
    set = new Set();
    REJECTED_SPEC_HASHES.set(key, set);
  }
  return set;
}
