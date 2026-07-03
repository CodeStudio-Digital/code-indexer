import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import { loadPrompt } from '@mcp/code-agent/prompts/loader.js';

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

/**
 * 9-section summary used when CODER_NEW_COMPACTION is enabled. Mirrors
 * Claude Code's compact prompt structure (Primary Request, Key Concepts,
 * Files, Errors, Problem Solving, User Messages, Pending Tasks, Current
 * Work, Next Step) — empirically the right level of detail to let the
 * continuing agent resume cleanly without re-reading the pruned span.
 *
 * Backwards compatible: `toLegacy()` projects this onto the older 6-field
 * shape so the existing `renderSummary` keeps working during the rollout.
 */
export interface CompactionSummaryV2 {
  primary_request: string;
  key_concepts: string[];
  files_and_code: Array<{ path: string; state: string }>;
  errors_and_fixes: string[];
  problem_solving: string;
  all_user_messages: string[];
  pending_tasks: string[];
  current_work: string;
  next_step: string;
  /**
   * Live-state overlay populated by the runner AFTER the LLM summarization
   * step (Agent Loop v2). Keeps the rendered summary anchored to ground truth
   * even when the LLM-extracted pending_tasks/next_step drift from reality.
   * Either field may be omitted when there is nothing to record.
   */
  active_goal?: string;
}

/**
 * Replace the LLM-extracted `pending_tasks` with the live todo list and
 * stamp the live goal into `active_goal`. Run this AFTER summarizeSpanV2
 * so rendered summaries reflect ground truth, not what the LLM happened
 * to extract from the message span.
 */
export function overlayLiveState(
  summary: CompactionSummaryV2,
  liveTodos: Array<{ content: string; activeForm: string; status: string }>,
  liveGoal: { text: string; status: string } | null,
): CompactionSummaryV2 {
  const unfinished = liveTodos
    .filter((t) => t.status === 'pending' || t.status === 'in_progress')
    .map((t) => `[${t.status}] ${t.content}`);
  return {
    ...summary,
    pending_tasks: unfinished.length > 0 ? unfinished : summary.pending_tasks,
    active_goal: liveGoal ? `${liveGoal.text} (status=${liveGoal.status})` : summary.active_goal,
  };
}

export function summaryV2ToLegacy(s: CompactionSummaryV2): CompactionSummary {
  return {
    what_done: s.problem_solving,
    current_work: s.current_work,
    files_touched: s.files_and_code.map((f) => f.path),
    decisions: s.errors_and_fixes,
    next_steps: s.pending_tasks.length > 0 ? s.pending_tasks : (s.next_step ? [s.next_step] : []),
    user_preferences: s.all_user_messages.slice(0, 8),
  };
}

export function isStructuredSummaryEnabled(): boolean {
  // Coupled to the master compaction flag — if the new path is on, use the
  // 9-section prompt. CODER_STRUCTURED_SUMMARY=0 forces back to the legacy
  // 6-field shape for diagnostics.
  if (process.env.CODER_STRUCTURED_SUMMARY === '0') return false;
  return process.env.CODER_NEW_COMPACTION !== '0';
}

export function isSummarizerEnabled(): boolean {
  // Default ON (opt-out via CODER_SUMMARIZER_ENABLE=0). The summarizer uses
  // a cheap model and preserves semantic context far better than the
  // deterministic `[compacted: N]` markers.
  return process.env.CODER_SUMMARIZER_ENABLE !== '0';
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
    const useV2 = isStructuredSummaryEnabled();
    const systemPrompt = loadPrompt(useV2 ? 'summarize-v2' : 'summarize');
    const userContent = formatSpanForPrompt(messages);
    console.log(
      `[coder] summarizer input: ${userContent.length} chars from ${messages.length} messages (${useV2 ? 'v2/9-section' : 'v1/6-field'})`
    );
    let fullText = '';
    const stream = provider.chat({
      system: systemPrompt,
      messages: [{ role: 'user', content: [{ type: 'text', text: userContent }] }],
      tools: [],
    });
    for await (const delta of stream) {
      if (delta.type === 'text_delta') fullText += delta.text;
    }
    const json = extractFirstJsonObject(fullText);
    if (!json) return null;
    if (useV2) {
      const v2 = parseV2(json);
      if (!v2) return null;
      return summaryV2ToLegacy(v2);
    }
    return parseV1(json);
  } catch (e) {
    console.warn(`[coder] summarizer failed, falling back to deterministic compaction: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Same as `summarizeSpan` but returns the V2 structure when the new path is
 * enabled — used by the runner to render richer summary blocks. Falls back
 * to a V2 wrapping of the V1 output when only the legacy prompt is on.
 */
export async function summarizeSpanV2(
  messages: AgentMessage[],
  provider: ChatProvider,
): Promise<CompactionSummaryV2 | null> {
  if (messages.length === 0) return null;
  try {
    const useV2 = isStructuredSummaryEnabled();
    const systemPrompt = loadPrompt(useV2 ? 'summarize-v2' : 'summarize');
    const userContent = formatSpanForPrompt(messages);
    let fullText = '';
    const stream = provider.chat({
      system: systemPrompt,
      messages: [{ role: 'user', content: [{ type: 'text', text: userContent }] }],
      tools: [],
    });
    for await (const delta of stream) {
      if (delta.type === 'text_delta') fullText += delta.text;
    }
    const json = extractFirstJsonObject(fullText);
    if (!json) return null;
    if (useV2) return parseV2(json);
    const v1 = parseV1(json);
    if (!v1) return null;
    return {
      primary_request: v1.what_done,
      key_concepts: [],
      files_and_code: v1.files_touched.map((p) => ({ path: p, state: '' })),
      errors_and_fixes: v1.decisions,
      problem_solving: v1.what_done,
      all_user_messages: v1.user_preferences,
      pending_tasks: v1.next_steps,
      current_work: v1.current_work,
      next_step: v1.next_steps[0] ?? '',
    };
  } catch (e) {
    console.warn(`[coder] summarizerV2 failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

function parseV1(json: string): CompactionSummary | null {
  try {
    const parsed = JSON.parse(json) as Partial<CompactionSummary>;
    return {
      what_done: String(parsed.what_done ?? ''),
      current_work: String(parsed.current_work ?? ''),
      files_touched: Array.isArray(parsed.files_touched) ? parsed.files_touched.map(String) : [],
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions.map(String) : [],
      next_steps: Array.isArray(parsed.next_steps) ? parsed.next_steps.map(String) : [],
      user_preferences: Array.isArray(parsed.user_preferences) ? parsed.user_preferences.map(String) : [],
    };
  } catch {
    return null;
  }
}

function parseV2(json: string): CompactionSummaryV2 | null {
  try {
    const p = JSON.parse(json) as Partial<CompactionSummaryV2> & {
      files_and_code?: Array<{ path?: unknown; state?: unknown }>;
    };
    return {
      primary_request: String(p.primary_request ?? ''),
      key_concepts: Array.isArray(p.key_concepts) ? p.key_concepts.map(String) : [],
      files_and_code: Array.isArray(p.files_and_code)
        ? p.files_and_code.map((f) => ({ path: String(f?.path ?? ''), state: String(f?.state ?? '') })).filter((f) => f.path)
        : [],
      errors_and_fixes: Array.isArray(p.errors_and_fixes) ? p.errors_and_fixes.map(String) : [],
      problem_solving: String(p.problem_solving ?? ''),
      all_user_messages: Array.isArray(p.all_user_messages) ? p.all_user_messages.map(String) : [],
      pending_tasks: Array.isArray(p.pending_tasks) ? p.pending_tasks.map(String) : [],
      current_work: String(p.current_work ?? ''),
      next_step: String(p.next_step ?? ''),
    };
  } catch {
    return null;
  }
}

/**
 * Render a 9-section summary using kimi-cli-style tagged blocks (PR-3, R3
 * from docs/agent-research/COMPARISON.md). Each section becomes a labeled
 * `<tag>...</tag>` block instead of a `**Header:**` line. Tagged blocks
 * are deterministically parseable: when the next compaction round runs,
 * the LLM can find the prior `<current_focus>` content and carry it
 * forward without hallucinating structure. Empty sections are omitted to
 * keep the rendered text lean.
 *
 * Field → tag mapping (preserved across the existing v2 schema, so
 * `overlayLiveState` and the Codex-fallback path keep working):
 *   active_goal       → <active_goal>
 *   primary_request   → <primary_request>
 *   current_work +
 *   next_step         → <current_focus>
 *   key_concepts +
 *   files_and_code    → <environment>
 *   errors_and_fixes  → <active_issues>
 *   pending_tasks     → <pending_tasks>
 *   problem_solving   → <problem_solving>
 *   all_user_messages → <user_messages>
 */
/**
 * Prefix prepended to every rendered compaction summary so the model reliably
 * recognizes injected summary content (mirrors Codex's `SUMMARY_PREFIX`). Single
 * source of truth reused by both renderers.
 */
export const SUMMARY_PREFIX = '[auto-compacted summary of older turns]';

export function renderSummaryV2(s: CompactionSummaryV2): string {
  const lines: string[] = [SUMMARY_PREFIX, ''];

  const block = (tag: string, body: string): void => {
    if (!body || !body.trim()) return;
    lines.push(`<${tag}>`);
    lines.push(body.trimEnd());
    lines.push(`</${tag}>`);
    lines.push('');
  };

  if (s.active_goal) block('active_goal', s.active_goal);
  if (s.primary_request) block('primary_request', s.primary_request);

  // Current focus = current_work + next_step. Two short fields collapsed
  // into one block so the model sees them together.
  if (s.current_work || s.next_step) {
    const focus: string[] = [];
    if (s.current_work) focus.push(`work: ${s.current_work}`);
    if (s.next_step) focus.push(`next: ${s.next_step}`);
    block('current_focus', focus.join('\n'));
  }

  // Environment = key_concepts + files_and_code. Mirrors kimi-cli's
  // <environment> tag which carries setup/config/dep info.
  if (s.key_concepts.length || s.files_and_code.length) {
    const env: string[] = [];
    if (s.key_concepts.length) env.push(`key concepts: ${s.key_concepts.join(', ')}`);
    if (s.files_and_code.length) {
      env.push('files:');
      for (const f of s.files_and_code) env.push(`- \`${f.path}\` — ${f.state}`);
    }
    block('environment', env.join('\n'));
  }

  if (s.errors_and_fixes.length) {
    block('active_issues', s.errors_and_fixes.map((e) => `- ${e}`).join('\n'));
  }

  if (s.pending_tasks.length) {
    block('pending_tasks', s.pending_tasks.map((t) => `- ${t}`).join('\n'));
  }

  if (s.problem_solving) {
    block('problem_solving', s.problem_solving);
  }

  if (s.all_user_messages.length) {
    block('user_messages', s.all_user_messages.map((m) => `- ${m}`).join('\n'));
  }

  // Drop any trailing blank line we may have appended by the last block().
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  return lines.join('\n');
}

/** Render a summary as a single human-readable markdown block for injection into history. */
export function renderSummary(s: CompactionSummary): string {
  const lines: string[] = [SUMMARY_PREFIX, ''];
  if (s.what_done) lines.push(`**Done:** ${s.what_done}`);
  if (s.current_work) lines.push(`**In progress:** ${s.current_work}`);
  if (s.files_touched.length) lines.push(`**Files:** ${s.files_touched.join(', ')}`);
  if (s.decisions.length) lines.push(`**Decisions:** ${s.decisions.map((d) => `- ${d}`).join('\n')}`);
  if (s.next_steps.length) lines.push(`**Next steps:** ${s.next_steps.map((d) => `- ${d}`).join('\n')}`);
  if (s.user_preferences.length) lines.push(`**User wants:** ${s.user_preferences.join('; ')}`);
  return lines.join('\n');
}
