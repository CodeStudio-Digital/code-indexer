/**
 * Durable side of automatic compaction. The in-memory CompactingNode shrinks
 * `ctx.messages` for the CURRENT run only; a fresh runner re-reads the full DB
 * transcript and the saving evaporates. This module persists the reduction as a
 * boundary + summary on the session (migration 128) so the NEXT run starts from
 * the summary + a recent tail — durable, cross-run cost reduction.
 *
 * It operates over DB ROWS (not the runner's in-memory array), so the summary
 * and the boundary are always aligned (no gap) and there's no in-memory↔DB
 * index mapping. Cumulative: any prior summary is folded into the new one. Runs
 * off the hot path (fire-and-forget from `index.ts`); any failure is a no-op
 * for the run — we simply don't move the boundary.
 */
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type { SessionStore } from '@mcp/code-agent/sessions/store.js';
import {
  computeCutoffIndexByTokens,
  snapCutoffPreservingPairs,
  recedeToPreserveLastNTurns,
} from '@mcp/code-agent/core/compaction/cutoff.js';
import { summarizeSpanV2, renderSummaryV2 } from '@mcp/code-agent/core/summarizer.js';
import { computeProtectTokens, resolveRecedeTailRatio } from './threshold.js';
import { preserveLastNTurns } from '../recovery-config.js';

/** Below this many visible rows there's nothing worth compacting durably. */
const MIN_ROWS = 4;

function summaryMessage(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

export interface DurableCompactionResult {
  ok: boolean;
  boundaryId?: number;
  prunedCount?: number;
  reason?: 'nothing-to-compact' | 'summary-failed' | 'too-short';
}

/**
 * Compute a cutoff over the session's VISIBLE rows (keep the recent
 * `protectRatio` tail, preserving tool_use/tool_result pairs), summarize the
 * head (folding in any prior summary so the result stays cumulative), and
 * persist the new boundary + summary. No-op (never throws) when there's nothing
 * worth compacting or the summary call fails.
 */
export async function runDurableCompaction(args: {
  store: SessionStore;
  sessionId: number;
  provider: ChatProvider;
}): Promise<DurableCompactionResult> {
  const { store, sessionId, provider } = args;
  const data = store.loadSessionWithMessages(sessionId);
  if (!data) return { ok: false, reason: 'nothing-to-compact' };

  const rows = data.message_rows;
  const msgs = data.messages;
  if (rows.length < MIN_ROWS) return { ok: false, reason: 'too-short' };

  const protectTokens = computeProtectTokens({ model: provider.model });
  const maxTailTokens = computeProtectTokens({ model: provider.model, protectRatio: resolveRecedeTailRatio() });
  let cutoff = computeCutoffIndexByTokens(msgs, protectTokens);
  cutoff = recedeToPreserveLastNTurns(msgs, cutoff, preserveLastNTurns(), maxTailTokens);
  cutoff = snapCutoffPreservingPairs(msgs, cutoff);
  if (cutoff <= 0 || cutoff >= msgs.length) return { ok: false, reason: 'nothing-to-compact' };

  const prior = data.session.compaction_summary;
  const head: AgentMessage[] = prior
    ? [summaryMessage(prior), ...msgs.slice(0, cutoff)]
    : msgs.slice(0, cutoff);

  const summary = await summarizeSpanV2(head, provider);
  if (!summary) return { ok: false, reason: 'summary-failed' };

  const boundaryId = rows[cutoff - 1].id;
  const res = store.setCompactionBoundary(sessionId, renderSummaryV2(summary), boundaryId, 'auto');
  return { ok: true, boundaryId: res.boundary_id, prunedCount: res.pruned_count };
}
