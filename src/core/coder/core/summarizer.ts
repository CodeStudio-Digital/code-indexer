import type { AgentMessage } from './messages.js';
import type { ChatProvider } from '../providers/adapter.js';
import { loadPrompt } from '../prompts/loader.js';

/**
 * LLM-driven compaction summarizer.
 *
 * Complements the deterministic `compactMessages` in core/compaction.ts: when
 * the accumulated history is large enough to trigger compaction, instead of
 * (only) replacing old tool_result contents with deterministic markers, we
 * can ask a cheap model to produce a structured summary that preserves the
 * salient facts (files touched, decisions, next steps, user preferences).
 *
 * The summary replaces a span of old messages with a single synthetic
 * assistant message of ~500 tokens. The continuing agent sees the summary
 * in place of the pruned turns — much better than just `[compacted: N]`
 * markers when the user asks "what did we do earlier?".
 *
 * This path is OPT-IN via `CODER_SUMMARIZER_ENABLE=1`. When disabled (the
 * default), the caller uses the existing deterministic compaction path.
 * The fallback is critical: any failure here — LLM timeout, invalid JSON,
 * provider error — must NOT break the turn. Return null and let the caller
 * fall back to the deterministic marker.
 */

export interface CompactionSummary {
  what_done: string;
  current_work: string;
  files_touched: string[];
  decisions: string[];
  next_steps: string[];
  user_preferences: string[];
}

export function isSummarizerEnabled(): boolean {
  return process.env.CODER_SUMMARIZER_ENABLE === '1';
}

// ---------------------------------------------------------------------------
// Budget-capped three-section formatting
// ---------------------------------------------------------------------------

/**
 * Maximum chars sent to the summarizer LLM.  Must fit comfortably inside the
 * cheapest model's context window (~100K tokens ≈ ~400K chars for Haiku).
 * Default 120K chars ≈ 30K tokens — safe for any provider.
 */
const SUMMARIZER_BUDGET = Number(process.env.CODER_SUMMARIZER_BUDGET ?? 120_000);

/** How many messages from the start to always include (context/setup). */
const HEAD_COUNT = 10;
/** How many messages from the end of the span to always include (recent work). */
const TAIL_COUNT = 30;

// Per-block caps — tighter than the main agent since we only need gist.
const TEXT_CAP = 600;
const TOOL_USE_CAP = 200;
const TOOL_RESULT_CAP = 300;

/** Format a single message with tight truncation caps. */
function formatMessage(m: AgentMessage, skipToolResults = false): string {
  const lines: string[] = [`### ${m.role}`];
  for (const b of m.content) {
    if (b.type === 'text') {
      lines.push(b.text.slice(0, TEXT_CAP));
    } else if (b.type === 'tool_use') {
      lines.push(`[tool_use ${b.name}] ${JSON.stringify(b.input).slice(0, TOOL_USE_CAP)}`);
    } else if (b.type === 'tool_result') {
      if (skipToolResults) continue;
      const content = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
      // Skip already-compacted blocks — they carry no information.
      if (content.startsWith('[compacted:')) continue;
      lines.push(`[tool_result] ${content.slice(0, TOOL_RESULT_CAP)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Format a span of messages for the summarizer prompt using budget-capped
 * three-section sampling.
 *
 * Strategy (inspired by OpenCode / Claude Code):
 *  1. **Head** — first HEAD_COUNT messages (capture initial context/setup).
 *  2. **Tail** — last TAIL_COUNT messages (most recent work before cutoff).
 *  3. **Middle** — uniformly sampled *key* messages (user turns + assistant
 *     tool_use blocks only — tool_result bodies are skipped). Fills whatever
 *     budget remains after head + tail.
 *
 * Total output is hard-capped at SUMMARIZER_BUDGET chars so it always fits
 * inside the cheapest model's context window.
 */
function formatSpanForPrompt(messages: AgentMessage[]): string {
  const n = messages.length;

  // Small spans — format everything (no sampling needed).
  if (n <= HEAD_COUNT + TAIL_COUNT) {
    const parts: string[] = [];
    let total = 0;
    for (const m of messages) {
      const f = formatMessage(m);
      if (total + f.length > SUMMARIZER_BUDGET) break;
      parts.push(f);
      total += f.length;
    }
    return parts.join('\n\n');
  }

  // ----- Head -----
  const headParts: string[] = [];
  let headLen = 0;
  for (let i = 0; i < HEAD_COUNT && i < n; i++) {
    const f = formatMessage(messages[i]);
    headParts.push(f);
    headLen += f.length;
  }

  // ----- Tail -----
  const tailStart = Math.max(HEAD_COUNT, n - TAIL_COUNT);
  const tailParts: string[] = [];
  let tailLen = 0;
  for (let i = tailStart; i < n; i++) {
    const f = formatMessage(messages[i]);
    tailParts.push(f);
    tailLen += f.length;
  }

  // ----- Middle (budget-capped, key messages only) -----
  const middleBudget = Math.max(0, SUMMARIZER_BUDGET - headLen - tailLen);
  const middleStart = HEAD_COUNT;
  const middleEnd = tailStart;
  const middleCount = middleEnd - middleStart;
  const middleParts: string[] = [];
  let middleLen = 0;

  if (middleBudget > 0 && middleCount > 0) {
    // Collect indices of key messages (user turns + assistant turns that
    // contain tool_use blocks — i.e. action decisions).
    const keyIndices: number[] = [];
    for (let i = middleStart; i < middleEnd; i++) {
      const m = messages[i];
      if (m.role === 'user' || m.content.some(b => b.type === 'tool_use')) {
        keyIndices.push(i);
      }
    }

    // Uniformly sample to avoid clustering.  If we have too many key
    // messages, pick every Nth one.
    const maxMiddleMsgs = Math.max(1, Math.floor(middleBudget / 300)); // rough estimate
    const step = keyIndices.length > maxMiddleMsgs
      ? keyIndices.length / maxMiddleMsgs
      : 1;

    for (let j = 0; j < keyIndices.length && middleLen < middleBudget; j += step) {
      const idx = keyIndices[Math.floor(j)];
      const f = formatMessage(messages[idx], /* skipToolResults */ true);
      if (middleLen + f.length > middleBudget) break;
      middleParts.push(f);
      middleLen += f.length;
    }
  }

  // ----- Assemble -----
  const sections: string[] = [];
  sections.push(...headParts);
  if (middleParts.length > 0) {
    const skipped = middleCount - middleParts.length;
    sections.push(`\n--- [${middleCount} middle messages; showing ${middleParts.length} key events, ${skipped} omitted] ---`);
    sections.push(...middleParts);
  } else if (middleCount > 0) {
    sections.push(`\n--- [${middleCount} middle messages omitted] ---`);
  }
  sections.push(`\n--- [${tailParts.length} most recent messages before cutoff] ---`);
  sections.push(...tailParts);

  // Final safety cap.
  let result = sections.join('\n\n');
  if (result.length > SUMMARIZER_BUDGET) {
    result = result.slice(0, SUMMARIZER_BUDGET) + '\n[...truncated to fit summarizer budget]';
  }
  return result;
}

/**
 * Run the summarizer over a span of messages. Returns null on any failure —
 * caller should fall back to the deterministic marker path. The provider
 * passed in should be a cheap model (Haiku, GLM-flash, Gemini-flash) since
 * this runs mid-turn and adds latency.
 */
export async function summarizeSpan(
  messages: AgentMessage[],
  provider: ChatProvider,
): Promise<CompactionSummary | null> {
  if (messages.length === 0) return null;
  try {
    const systemPrompt = loadPrompt('summarize');
    const userContent = formatSpanForPrompt(messages);
    console.log(`[coder] summarizer input: ${userContent.length} chars from ${messages.length} messages`);
    let fullText = '';
    const stream = provider.chat({
      system: systemPrompt,
      messages: [{ role: 'user', content: [{ type: 'text', text: userContent }] }],
      tools: [],
    });
    for await (const delta of stream) {
      if (delta.type === 'text_delta') fullText += delta.text;
    }
    // Find the JSON object in the response — some models wrap it in prose
    // despite the instructions. Match the first top-level {..} block by
    // counting brace depth (skipping braces inside JSON strings).
    const start = fullText.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let i = start; i < fullText.length; i++) {
      const ch = fullText[i];
      if (inString) {
        if (ch === '\\') { i++; continue; }   // skip escaped char
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) return null;
    const parsed = JSON.parse(fullText.slice(start, end + 1)) as Partial<CompactionSummary>;
    return {
      what_done: String(parsed.what_done ?? ''),
      current_work: String(parsed.current_work ?? ''),
      files_touched: Array.isArray(parsed.files_touched) ? parsed.files_touched.map(String) : [],
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions.map(String) : [],
      next_steps: Array.isArray(parsed.next_steps) ? parsed.next_steps.map(String) : [],
      user_preferences: Array.isArray(parsed.user_preferences) ? parsed.user_preferences.map(String) : [],
    };
  } catch (e) {
    console.warn(`[coder] summarizer failed, falling back to deterministic compaction: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Render a summary as a single human-readable markdown block for injection into history. */
export function renderSummary(s: CompactionSummary): string {
  const lines: string[] = ['[auto-compacted summary of older turns]', ''];
  if (s.what_done) lines.push(`**Done:** ${s.what_done}`);
  if (s.current_work) lines.push(`**In progress:** ${s.current_work}`);
  if (s.files_touched.length) lines.push(`**Files:** ${s.files_touched.join(', ')}`);
  if (s.decisions.length) lines.push(`**Decisions:** ${s.decisions.map((d) => `- ${d}`).join('\n')}`);
  if (s.next_steps.length) lines.push(`**Next steps:** ${s.next_steps.map((d) => `- ${d}`).join('\n')}`);
  if (s.user_preferences.length) lines.push(`**User wants:** ${s.user_preferences.join('; ')}`);
  return lines.join('\n');
}
