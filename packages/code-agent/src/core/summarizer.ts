import type { CompactionSummaryV2 } from '@mcp/session-storage/compaction/summary-types.js';
export type { CompactionSummary, CompactionSummaryV2 } from '@mcp/session-storage/compaction/summary-types.js';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import {
  summarizeSpanV3,
  summaryV3ToV2,
  type SummarizeSpanV3Options,
} from './summarizer-v3.js';

export {
  COMPACTION_SUMMARY_MAX_CHARS,
  COMPACTION_SUMMARY_MAX_TOKENS,
  COMPACTION_SUMMARY_TIMEOUT_MS,
  COMPACTION_SUMMARY_V3_VERSION,
  capCompactionSummaryV3,
  formatSpanForPromptV3,
  isCompactionSummaryV3,
  overlayLiveStateV3,
  parseCompactionSummaryV3,
  renderChapterV3,
  renderResumeV3,
  separatePreviousResumeV3,
  summarizeSpanV3,
  summaryV2ToV3,
  summaryV3ToLegacy,
  summaryV3ToV2,
  type CompactionChapterV3,
  type CompactionLiveStateV3,
  type CompactionResumeV3,
  type CompactionSummaryMetricsV3,
  type CompactionSummaryV3,
  type SummarizeSpanV3Input,
  type SummarizeSpanV3Options,
} from './summarizer-v3.js';

/**
 * Summarize a span through the V3 summarizer and project the result onto the
 * V2 shape (memory sweeper and diagnostics consume V2). Returns null on any
 * failure.
 */
export async function summarizeSpanV2(
  messages: AgentMessage[],
  provider: ChatProvider,
  options: SummarizeSpanV3Options = {},
): Promise<CompactionSummaryV2 | null> {
  if (messages.length === 0) return null;
  try {
    const v3 = await summarizeSpanV3({ messages }, provider, options);
    return v3 ? summaryV3ToV2(v3) : null;
  } catch (e) {
    console.warn(`[coder] summarizerV2 failed: ${e instanceof Error ? e.message : String(e)}`);
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
 * Field → tag mapping (preserved across the existing v2 schema):
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
 * source of truth for the renderer below.
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
