/**
 * Marker/reminder builders for the dup-call & polling guards. Every
 * function here is a deterministic pure-string builder — no Date, no
 * UUIDs, no randomness — because the output becomes part of the
 * assistant transcript and any non-determinism would invalidate the
 * provider's prompt-prefix cache on every turn.
 */

/**
 * Build the informational header that prefixes a duplicate tool result.
 *
 * Deterministic by design: every input is a primitive (no Date, no
 * UUIDs, no `Math.random()`) so the same args always yield the same
 * bytes. That matters because the prefix becomes part of the assistant
 * transcript and any non-determinism would invalidate the provider's
 * prompt-prefix cache on every turn.
 *
 * The two variants:
 *   - `priorIsCompacted=false`: "identical to your `X` at turn N
 *     (use_id Y, args Z); content below unchanged" — gives the agent
 *     enough breadcrumbs to find the earlier read in its scrollback if
 *     it needs to.
 *   - `priorIsCompacted=true`: omits the use_id (which would be stale
 *     since the block was elided by post-compact cleanup) and instead
 *     reassures the agent that the content delivered below is fresh —
 *     "matches a `X` call earlier, content below is current". This is
 *     the common case after long sessions.
 *
 * Either way, the marker ends with the same guidance: continue working,
 * or pass `force_reread: true` if the source likely changed.
 */
export function buildDupLightMarker(args: {
  toolName: string;
  originalTurn: number;
  originalUseIdShort: string;
  window: number;
  priorIsCompacted: boolean;
  argsPreview: string;
}): string {
  if (args.priorIsCompacted) {
    return (
      `[dup-result: matches a \`${args.toolName}\` call earlier in this ` +
      `conversation (now compacted out of your context); content below is ` +
      `current. Continue without re-reading.]`
    );
  }
  return (
    `[dup-result: identical to \`${args.toolName}\` at turn ${args.originalTurn} ` +
    `(use_id ${args.originalUseIdShort}, args ${args.argsPreview}); content below ` +
    `unchanged in last ${args.window} turns. Repeating this call will escalate to ` +
    `a hard refuse on the next hit. Act on what you have, or pass ` +
    `\`force_reread: true\` if you genuinely need a fresh fetch.]`
  );
}

/**
 * Warn-mode marker — fires on the 3rd identical hit in the window
 * (configurable via `CODER_RESULT_DUP_ESCALATION_WARN`). One step
 * before the hard refuse; the language is sharper than the light
 * marker but content is STILL delivered so the agent isn't blocked
 * yet. Mentions `hitCount` explicitly so the agent has a concrete
 * sense of how close it is to the cliff edge.
 *
 * Stays deterministic (no timestamps, no UUIDs) — same prefix-cache
 * stability constraint as the light marker.
 */
export function buildDupWarnMarker(args: {
  toolName: string;
  originalTurn: number;
  hitCount: number;
  window: number;
  priorIsCompacted: boolean;
  argsPreview: string;
}): string {
  const ord = ordinal(args.hitCount);
  if (args.priorIsCompacted) {
    return (
      `[dup-result: WARNING — ${ord} identical fetch of \`${args.toolName}\` ` +
      `(prior call now compacted out of context). The system will REFUSE the ` +
      `next call. Content below is current; act on it or pass ` +
      `\`force_reread: true\` if data genuinely changed.]`
    );
  }
  return (
    `[dup-result: WARNING — ${ord} identical fetch of \`${args.toolName}\` ` +
    `in last ${args.window} turns (first seen turn ${args.originalTurn}, args ${args.argsPreview}). ` +
    `The system will REFUSE the next call. Your context already has this content. ` +
    `Stop re-fetching: act on what you have, or pass \`force_reread: true\` if ` +
    `data genuinely changed.]`
  );
}

/** "2nd" / "3rd" / "4th" — small helper so the warn marker reads naturally. */
export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/**
 * Phase C — dup-call reminder marker. Appended to the tool result content
 * at calls `DUP_CALL_REMINDER_THRESHOLD`..`DUP_CALL_THRESHOLD - 1`. The
 * result is delivered normally; the reminder is a softer nudge before
 * the next call would refuse. Kimi-cli pattern.
 */
export function buildDupCallReminderMarker(args: {
  toolName: string;
  count: number;
  window: number;
  hardCap: number;
}): string {
  return (
    `\n\n<system-reminder>\n` +
    `You have called \`${args.toolName}\` with these exact arguments ` +
    `${args.count} times in the last ${args.window} turns. The next ` +
    `${args.hardCap - args.count} identical call(s) will be REFUSED. ` +
    `Reconsider: act on the result you already have, try a different tool, ` +
    `or change the arguments. Repeating this call will not produce new info.\n` +
    `</system-reminder>`
  );
}

/**
 * Phase C — polling-tool soft-cap reminder. Appended to a polling-tool
 * result when the per-session call count crosses `REPEATABLE_SOFT_CAP`.
 * Polling tools are exempt from the 4 main guards (turnAllRepeatable)
 * so this is their dedicated brake. Hard cap follows.
 */
export function buildPollingSoftCapMarker(args: {
  toolName: string;
  count: number;
  window: number;
  softCap: number;
  hardCap: number;
}): string {
  return (
    `\n\n<system-reminder>\n` +
    `You have called the polling tool \`${args.toolName}\` ${args.count} times ` +
    `in the last ${args.window} turns (soft cap ${args.softCap}). Polling tools ` +
    `are normally exempt from loop guards, but unbounded polling burns tokens. ` +
    `The hard cap is ${args.hardCap} — beyond that the runner will REFUSE further ` +
    `calls. If the state you're waiting for isn't changing, change strategy: ` +
    `escalate to the user, abort the operation, or progress on a different task.\n` +
    `</system-reminder>`
  );
}

/**
 * Phase C — polling-tool stuck-result refusal. Emitted when a polling
 * tool returns the byte-identical content `POLLING_STUCK_CAP` times in
 * a row. The observed state isn't changing; further polls produce no
 * new info. Catches the session 763 pattern (`list_subordinates`
 * returned the same 8eaed653 content 131 consecutive times).
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
 * Medium-mode marker — content was too big to inline twice, so we send
 * a head excerpt + the `output_id` of the cached full body. Agent calls
 * `get_tool_output(<id>)` only if it actually needs the tail. The
 * pointer pattern is the same one `buildToolResultBlock` uses for
 * "truncated" results, just dressed in dup-result framing.
 */
export function buildDupMediumMarker(args: {
  toolName: string;
  originalTurn: number;
  totalChars: number;
  outputId: string;
}): string {
  return (
    `[dup-result: identical to \`${args.toolName}\` at turn ${args.originalTurn}; ` +
    `full content (${args.totalChars} chars) cached as output_id=${args.outputId}. ` +
    `Head excerpt below — call get_tool_output("${args.outputId}") only if you ` +
    `need the elided body. To force-fetch: \`force_reread: true\`.]`
  );
}
