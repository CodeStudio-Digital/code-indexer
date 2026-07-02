/**
 * Correction-nudge detector — the cheapest possible "the user just corrected
 * you / stated a durable preference → offer to remember it" trigger.
 *
 * Pure + deterministic (regex over the latest user message, EN + PT-BR), no
 * LLM call. The Executing node runs it per user message and throttles the
 * resulting hint (hash-gated per message, capped per RUN — injectionState
 * lives on the RunContext, which is rebuilt per run/user message, so the cap
 * bounds nudges within one run; across a session it fires at most once per
 * correction-looking message). The hint rides the dynamic-injection
 * system-reminder in the USER message tail — never the system prompt — so
 * the provider prefix cache is untouched.
 *
 * False-positive posture: a preference phrase inside a long spec should not
 * fire (length guard); an explicit "ignore memory" instruction wins; and the
 * hint only *suggests* remember() — the model is told to skip one-off steering.
 */

export type CorrectionSignal = 'preference' | 'correction';

/** Messages longer than this are specs/briefs, not corrections. */
const MAX_SIGNAL_LENGTH = 500;

/**
 * Durable-preference phrasings. Bare "always/never/sempre/nunca" would fire
 * on ordinary bug reports ("the modal never closes", "o teste sempre falha"),
 * so the frequency words require a DIRECTIVE verb right after — the shape of
 * an instruction, not of a description.
 */
const DIRECTIVE_VERBS_EN = String.raw`(?:use|run|do|add|create|keep|write|include|put|make|respond|answer|format|commit|name|call)`;
const DIRECTIVE_VERBS_PT = String.raw`(?:use|usar|rode|rodar|fa[çc]a|fazer|crie|criar|adicione|adicionar|mantenha|manter|escreva|escrever|inclua|incluir|coloque|colocar|responda|responder|formate|formatar|nomeie|chame)`;
const PREFERENCE_RE = new RegExp(
  [
    // pt-BR
    String.raw`\b(?:sempre|nunca|jamais)\s+${DIRECTIVE_VERBS_PT}\b`,
    String.raw`\bprefiro\b|\bprefira\b|\bminha prefer[eê]ncia\b`,
    String.raw`\bn[aã]o (?:use|usar|fa[çc]a|fazer|crie|criar|adicione|adicionar)\b`,
    String.raw`\ba partir de agora\b|\bdaqui (?:pra|para) frente\b|\bde agora em diante\b`,
    // EN
    String.raw`\bfrom now on\b|\bgoing forward\b`,
    String.raw`\b(?:always|never)\s+${DIRECTIVE_VERBS_EN}\b`,
    String.raw`\b(?:i(?:'?d)?|we) prefer\b`,
    String.raw`\bdon'?t (?:ever )?(?:use|do|add|create)\b`,
    String.raw`\bstop (?:doing|using|adding)\b`,
  ].join('|'),
  'i',
);

/**
 * Correction/frustration phrasings — "again? / I already told you / undo…".
 * "de novo" needs the interrogative/frustrated shape ("de novo?", "de novo
 * isso") — a plain "roda os testes de novo" is an ordinary request.
 */
const CORRECTION_RE = new RegExp(
  [
    // pt-BR
    String.raw`\bde novo\?|\bde novo isso\b|\bisso de novo\b`,
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

/** The one-line hint injected when a signal fires (~80 tokens, ≤3×/run). */
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
