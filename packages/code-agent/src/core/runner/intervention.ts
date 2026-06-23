/**
 * Wire #2 — tool-misuse planning intervention.
 *
 * Helpers for the `quality_intervention` block that gets prepended to a
 * turn when the classifier verdict-streak crosses the threshold. The
 * block forces the agent into a planning turn (no tools allowed) so it
 * names the loop it's stuck in and proposes a different approach.
 *
 * Owns:
 *   - `INTERVENTION_COOLDOWN_TURNS` — min gap between consecutive
 *     interventions so we don't re-fire while the original 3-streak is
 *     still in the recent window.
 *   - `buildToolMisuseInterventionBlock` — the rendered prompt block.
 *   - `truncateForBlock` — small helper to keep the embedded classifier
 *     evidence under ~220 chars.
 */

/**
 * Wire #2 — minimum number of turns between consecutive tool-misuse
 * planning interventions. Without a cooldown, the intervention would
 * re-fire on every subsequent turn as long as the 3 flagged verdicts
 * remain in the recent window. 5 turns gives the model space to recover.
 */
export const INTERVENTION_COOLDOWN_TURNS = Number(
  process.env.CODER_TOOL_MISUSE_INTERVENTION_COOLDOWN ?? 5,
);

/**
 * Wire #2 — build the planning intervention block. Strong, directive
 * tone. Tells the model to (a) STOP calling tools, (b) name the loop,
 * (c) propose a different approach. Equivalent to spawning a Plan agent
 * but in-place: the current turn becomes the planning turn.
 */
export function buildToolMisuseInterventionBlock(
  latestReason: string | null,
  latestConfidence: number | null,
): string {
  const conf = latestConfidence != null ? ` (${Math.round(latestConfidence * 100)}% confidence)` : '';
  const evidence = latestReason ? `\nMost recent classifier evidence: "${truncateForBlock(latestReason)}".` : '';
  return [
    '',
    '<!-- quality-intervention (auto-generated; do not echo back to the user) -->',
    '## MANDATORY PLANNING TURN — tool-misuse loop detected',
    '',
    `Your last 3 turns triggered \`tool_misuse=flagged\`${conf}. You are stuck in a loop and burning tokens for no progress.${evidence}`,
    '',
    '**This turn, you MUST NOT call any tools.** Instead, reply with exactly three sections:',
    '',
    '1. **What I have been trying** — one sentence summarizing the repeated approach.',
    '2. **Why it is not working** — one or two sentences naming the specific failure mode you observe in the recent tool results.',
    '3. **Different approach** — three bullets describing a CLEARLY different next attempt (different tool, different scope, different file, asking the user a clarifying question — anything but more of the same).',
    '',
    'Do not call `Read`, `Bash`, `Grep`, `Edit`, or any other tool this turn. Plan first. The next turn you can resume tools, informed by the plan you just wrote.',
    '',
  ].join('\n');
}

export function truncateForBlock(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length <= 220 ? cleaned : `${cleaned.slice(0, 220)}…`;
}
