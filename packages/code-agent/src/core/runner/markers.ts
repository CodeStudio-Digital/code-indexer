/** Deterministic markers retained by active Behavior Tree guards. */

/**
 * Polling-stuck refusal. Unlike tuple dedup, this is result-aware: it only
 * intervenes after a pollable tool returned byte-identical state repeatedly.
 */
export function buildPollingStuckRefusal(args: {
  toolName: string;
  count: number;
  firstTurn: number;
}): string {
  return (
    `Refused: \`${args.toolName}\` returned the IDENTICAL result ${args.count} ` +
    `consecutive times (first seen turn ${args.firstTurn}). The state you're ` +
    `polling is not changing — further calls produce no new info. Change strategy: ` +
    `(a) escalate to the user describing what you observed, ` +
    `(b) abort the operation that's not making progress, or ` +
    `(c) work on a different task and return later. ` +
    `Pass distinctly DIFFERENT arguments if you genuinely need to poll something else.`
  );
}
