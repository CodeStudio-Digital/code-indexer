/**
 * Correction-nudge detector — the cheapest possible "the user just corrected
 * you / stated a durable preference → offer to remember it" trigger.
 *
 * Pure + deterministic (regex over the latest user message, EN + PT-BR), no
 * LLM call. The Executing node runs it per user message and throttles the
 * resulting hint (hash-gated, capped per session); the hint itself rides the
 * dynamic-injection system-reminder in the USER message tail — never the
 * system prompt — so the provider prefix cache is untouched.
 *
 * False-positive posture: a preference phrase inside a long spec should not
 * fire (length guard); an explicit "ignore memory" instruction wins; and the
 * hint only *suggests* remember() — the model is told to skip one-off steering.
 */

export type CorrectionSignal = 'preference' | 'correction';

/** Messages longer than this are specs/briefs, not corrections. */
const MAX_SIGNAL_LENGTH = 500;

/** Durable-preference phrasings — "always/never/prefer/from now on…". */
const PREFERENCE_RE = new RegExp(
  [
    // pt-BR
    String.raw`\b(sempre|nunca|jamais)\b`,
    String.raw`\bprefiro\b|\bprefira\b|\bprefer[eê]ncia\b`,
    String.raw`\bn[aã]o (?:use|usar|fa[çc]a|fazer|crie|criar|adicione|adicionar)\b`,
    String.raw`\ba partir de agora\b|\bdaqui (?:pra|para) frente\b|\bde agora em diante\b`,
    // EN
    String.raw`\bfrom now on\b|\bgoing forward\b`,
    String.raw`\balways\b|\bnever\b`,
    String.raw`\bprefer(?:ably|red)?\b`,
    String.raw`\bdon'?t (?:ever )?(?:use|do|add|create)\b`,
    String.raw`\bstop (?:doing|using|adding)\b`,
  ].join('|'),
  'i',
);

/** Correction/frustration phrasings — "again? / I already told you / undo…". */
const CORRECTION_RE = new RegExp(
  [
    // pt-BR
    String.raw`\bde novo(?: isso)?\b|\bmais uma vez\b`,
    String.raw`\bj[aá] (?:te )?(?:disse|falei|pedi|expliquei)\b`,
    String.raw`\bn[aã]o era isso\b|\bn[aã]o foi isso que\b`,
    String.raw`\bisso (?:est[aá]|t[aá]) errado\b`,
    String.raw`\bdesfa[çc]a\b|\breverta\b|\bvolta como estava\b`,
    // EN
    String.raw`\bagain\?`,
    String.raw`\bi (?:already )?told you\b|\bi asked you (?:before|already)\b`,
    String.raw`\bthat'?s (?:not what|wrong)\b|\bnot what i (?:asked|meant|wanted)\b`,
    String.raw`\bundo (?:that|this)\b|\brevert (?:that|your)\b`,
  ].join('|'),
  'i',
);

/**
 * Classify the latest user message. Returns null when it doesn't look like a
 * durable correction/preference (including when it's too long to be one).
 */
export function detectCorrectionSignal(text: string | null | undefined): CorrectionSignal | null {
  const t = (text ?? '').trim();
  if (!t || t.length > MAX_SIGNAL_LENGTH) return null;
  if (PREFERENCE_RE.test(t)) return 'preference';
  if (CORRECTION_RE.test(t)) return 'correction';
  return null;
}

/** The one-line hint injected when a signal fires (~80 tokens, ≤3×/session). */
export function renderCorrectionHint(signal: CorrectionSignal): string {
  const lead = signal === 'preference'
    ? "the user's last message states what sounds like a durable preference."
    : "the user's last message looks like a correction of something you did.";
  return (
    `${lead} If it should outlive this task, save it NOW: ` +
    "remember({scope:'user', type:'preference', ...}) for how they want you to work across projects, " +
    "or remember({type:'gotcha'|'convention'}) if it is about this codebase. " +
    'Skip if it was one-off steering for this task only.'
  );
}
