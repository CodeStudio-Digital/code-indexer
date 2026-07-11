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

/**
 * Planning-node reflection reminder for an actual active loop guard. It names
 * the guard and asks for a materially different next step.
 */
export function buildLoopGuardReflectionMarker(args: {
  guard: 'tuple-hash' | 'doom-loop' | 'dominance' | 'failure-streak';
  toolName?: string;
  count?: number;
}): string {
  const name = args.toolName ? `\`${args.toolName}\`` : 'a tool';
  const times = args.count != null ? `${args.count} times` : 'repeatedly';
  let label: string;
  let detail: string;
  switch (args.guard) {
    case 'tuple-hash':
      label = 'duplicate-call';
      detail =
        `${name} repeated the same dangerous mutation ${times} within one invocation scope; ` +
        `the latest local attempt was refused.`;
      break;
    case 'doom-loop':
      label = 'doom-loop';
      detail = `the same tool signature (${name}) recurred across ${args.count ?? 'several'} turns.`;
      break;
    case 'dominance':
      label = 'single-tool-dominance';
      detail = `${name} dominated ${args.count ?? 'many'} recent turns with zero assistant text between calls.`;
      break;
    case 'failure-streak':
      label = 'failure-streak';
      detail =
        `${name} failed ${args.count != null ? `${args.count} consecutive times` : 'repeatedly'} — ` +
        `the approach, not the call, is wrong.`;
      break;
  }
  return (
    `<system-reminder>\n` +
    `[loop-guard: ${label}] The runner interrupted your tool loop: ${detail}\n` +
    `Before your next tool batch, reflect briefly: (1) state what the repeated call was ` +
    `supposed to achieve, (2) why repeating it cannot achieve it, (3) then act with a ` +
    `DIFFERENT tool or materially different arguments. If you are blocked, ask the user ` +
    `(ask_user / ask_master) instead of retrying.\n` +
    `</system-reminder>`
  );
}
