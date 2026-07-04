/**
 * Deriving a GOOD memory-recall query from the conversation.
 *
 * The proactive Mem C recall (`executing.ts`) used to pass the latest user
 * message VERBATIM as the search query. That breaks on META messages —
 * "continue", "faz de novo", "Reanalise tudo que fez, se não deixou passar
 * nada!" — which carry no task semantics, so the hybrid (FTS+vector) search
 * returns nothing (`zero_hits`) and, worse, the throttle re-fires retrieval
 * with junk every time such a message arrives.
 *
 * Two pure primitives here (no LLM, no I/O):
 *   - `isMetaTaskText`   — is this message a continuation/re-check with no
 *                          substantive object? (PT-BR + EN)
 *   - `walkBackTaskText` — the last SUBSTANTIVE user message (skipping metas),
 *                          the zero-cost fallback query.
 * Plus `buildConversationTail`, the structural-clonable context an optional
 * LLM synthesizer (services-side) uses to write a sharper query.
 *
 * Design bias: FALSE-NEGATIVE (a meta not detected) = status quo, harmless.
 * FALSE-POSITIVE (a real task mistaken for meta) only walks back one message,
 * a mild degradation — so the substantive-object guard is deliberately strict.
 */
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';

export interface TailMessage {
  role: 'user' | 'assistant';
  text: string;
}
export type ConversationTail = TailMessage[];

/** Extract plain text from an AgentMessage content (string or block array). */
export function extractMessageText(msg: { content?: unknown }): string {
  const c = msg.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) {
    return c
      .map((b) =>
        typeof b === 'string'
          ? b
          : b && typeof b === 'object' && 'text' in b
            ? String((b as { text?: unknown }).text ?? '')
            : '',
      )
      .join(' ')
      .trim();
  }
  return '';
}

/** Latest user-message text — the raw "current task" signal (unchanged semantics). */
export function latestUserTaskText(messages: ReadonlyArray<AgentMessage>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m.role !== 'user') continue;
    return extractMessageText(m);
  }
  return '';
}

// Meta / continuation phrases (PT-BR + EN). Matching one is NECESSARY but not
// SUFFICIENT: a message with a real object (see `hasSubstantiveContent`) is a
// task even when it opens with one of these verbs ("reanalise o parser").
const META_PATTERN =
  "continu\\w*|prossig\\w*|prossegue|segue|siga|refa[çc]\\w*|reanalis\\w*|reavali\\w*|revis\\w*|confer\\w*|confir\\w*|verific\\w*|chec\\w*|analis\\w*|novamente|de novo|tem certeza|certeza|est[aá] certo|falt\\w+|esqueceu|mais alguma|algo mais|e agora|continue|proceed|go on|go ahead|keep going|carry on|re-?do|redo|re-?analyz\\w*|re-?check|re-?run|re-?review|double-?check|check again|review again|are you sure|you sure|anything else|anything missing|what'?s next|whats next|that'?s all|is that all|go for it|keep at it";
const META_PHRASE_RE = new RegExp(`\\b(${META_PATTERN})\\b`, 'i');
const META_PHRASE_RE_G = new RegExp(`\\b(${META_PATTERN})\\b`, 'gi');

// Generic filler + the meta verbs themselves: tokens that do NOT count as a
// substantive object. Anything left after removing these (and short tokens)
// is treated as real task content.
const FILLER = new Set<string>([
  // PT-BR generic
  'tudo', 'isso', 'aquilo', 'que', 'fez', 'feito', 'novo', 'nova', 'novamente',
  'nada', 'algo', 'mais', 'alguma', 'coisa', 'agora', 'favor', 'obrigado', 'obrigada',
  'nao', 'não', 'deixou', 'passar', 'esqueceu', 'certeza', 'tem', 'voce', 'você',
  'entao', 'então', 'sim', 'valeu', 'mesmo', 'direito', 'certo', 'bem', 'ok', 'blz',
  'beleza', 'pfv', 'por', 'esta', 'está', 'estao', 'estão', 'ainda', 'ver', 'tudo',
  'seu', 'sua', 'dele', 'delas', 'como', 'assim', 'aqui', 'ali', 'faz', 'faça',
  // EN generic
  'everything', 'anything', 'all', 'the', 'that', 'this', 'else', 'missing', 'sure',
  'again', 'next', 'more', 'please', 'thanks', 'now', 'yes', 'done', 'did', 'made',
  'left', 'out', 'nothing', 'something', 'you', 'your', 'and', 'for', 'has', 'have',
  'been', 'was', 'were', 'are', 'its', "it's", 'keep', 'going', 'go', 'them', 'they',
]);

/**
 * True when the text contains at least one SUBSTANTIVE token — a file path,
 * a backticked span, a dotted/underscored/camelCase identifier, or a plain
 * word (≥3 chars) that isn't generic filler / a meta verb.
 */
function hasSubstantiveContent(text: string): boolean {
  if (/`[^`]+`/.test(text)) return true; // backticked code span
  // Strip meta/continuation phrases FIRST so multi-word ones ("go ahead") don't
  // leave a stray content-looking token behind. Tokenize the ORIGINAL casing so
  // the camelCase shape survives.
  const stripped = text.replace(META_PHRASE_RE_G, ' ');
  const tokens = stripped.match(/[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu) ?? [];
  for (const raw of tokens) {
    // Path / identifier shapes are always substantive (deps.ts, foo/bar, snake_case, camelCase).
    if (/[./_]/.test(raw) || /[a-z][A-Z]/.test(raw)) return true;
    const lower = raw.toLowerCase();
    if (lower.length >= 3 && !FILLER.has(lower)) return true;
  }
  return false;
}

/**
 * Is this a META message (continuation / re-check with no real task object)?
 * Meta ⇔ it has NO substantive content AND (it matched a meta phrase OR it's a
 * very short throwaway like "e agora?" / "ok"). Empty text is not meta — the
 * caller handles empty separately.
 */
export function isMetaTaskText(text: string): boolean {
  const norm = text.trim();
  if (!norm) return false;
  if (hasSubstantiveContent(norm)) return false;
  return META_PHRASE_RE.test(norm) || norm.length <= 25;
}

/**
 * The last SUBSTANTIVE user message (skipping metas + empties). Zero-cost
 * fallback query when no LLM synthesizer is configured. Null when the whole
 * history is meta (brand-new session whose first message is meta).
 */
export function walkBackTaskText(messages: ReadonlyArray<AgentMessage>): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string };
    if (m.role !== 'user') continue;
    const text = extractMessageText(m as { content?: unknown });
    if (!text || isMetaTaskText(text)) continue;
    return text;
  }
  return null;
}

export interface MemoryRecallPlan {
  /** Stable pre-synthesis query: the raw text, or the walk-back for a meta
   *  message. Also the throttle key. '' when there is nothing to recall for. */
  candidate: string;
  /** The latest message is a meta/continuation → eligible for LLM synthesis. */
  meta: boolean;
  /** Throttle verdict: fire recall this turn (task changed, or turn 1). */
  shouldRetrieve: boolean;
}

/**
 * Pure throttle/derivation for proactive memory recall (the decision half of
 * the Executing node's Mem C block). Keeps the query derivation and — crucially
 * — the throttle keyed on the STABLE `candidate`, never on a synthesized string
 * (which is non-deterministic and would make every meta-tailed turn re-fire the
 * paid synthesizer + retrieval).
 */
export function planMemoryRecall(
  rawTaskText: string,
  messages: ReadonlyArray<AgentMessage>,
  lastMemoryQuery: string | undefined,
  turn: number,
): MemoryRecallPlan {
  const meta = !!rawTaskText && isMetaTaskText(rawTaskText);
  const candidate = meta ? (walkBackTaskText(messages) ?? rawTaskText) : rawTaskText;
  const shouldRetrieve = !!candidate && (turn === 1 || candidate !== lastMemoryQuery);
  return { candidate, meta, shouldRetrieve };
}

/**
 * Build the recent-conversation tail for the LLM query synthesizer: the last
 * `maxMessages` user/assistant turns, each text-extracted and truncated, in
 * chronological order. Structural-clonable so it rides the worker bridge.
 */
export function buildConversationTail(
  messages: ReadonlyArray<AgentMessage>,
  opts: { maxMessages?: number; maxCharsPerMessage?: number } = {},
): ConversationTail {
  const maxMessages = opts.maxMessages ?? 8;
  const maxChars = opts.maxCharsPerMessage ?? 500;
  const out: ConversationTail = [];
  for (let i = messages.length - 1; i >= 0 && out.length < maxMessages; i--) {
    const m = messages[i] as { role?: string };
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = extractMessageText(m as { content?: unknown });
    if (!text) continue;
    out.push({ role: m.role as 'user' | 'assistant', text: text.slice(0, maxChars) });
  }
  return out.reverse();
}
