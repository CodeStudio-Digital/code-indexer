/**
 * Render a V2/V3 compaction summary as the synthetic AgentMessage that replaces
 * the pruned head of the conversation history.
 *
 * The renderer itself (`renderSummaryV2`) lives in `core/summarizer.ts` and
 * is shared with the legacy path so both produce byte-identical text — this
 * module only handles the AgentMessage wrapping so the BT compactor and any
 * future caller agree on the wire shape.
 *
 * Wire shape:
 *   - role: 'user' so the next-turn assembly can append `<active_skills>`
 *     / `<active-context>` blocks onto it without altering the structure.
 *   - content: one text block containing the tagged `<primary_request>`,
 *     `<current_focus>` etc. body produced by `renderSummaryV2`.
 */
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import {
  isCompactionSummaryV3,
  renderResumeV3,
  renderSummaryV2,
  type CompactionSummaryV2,
  type CompactionSummaryV3,
} from '@mcp/code-agent/core/summarizer.js';

export function renderSummaryAsMessage(summary: CompactionSummaryV2 | CompactionSummaryV3): AgentMessage {
  const text = isCompactionSummaryV3(summary)
    ? renderResumeV3(summary)
    : renderSummaryV2(summary);
  return {
    role: 'user',
    content: [{ type: 'text', text }],
  };
}
