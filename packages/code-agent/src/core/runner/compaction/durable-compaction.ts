/**
 * Durable side of automatic compaction. The in-memory CompactingNode shrinks
 * `ctx.messages` for the CURRENT run only; a fresh runner re-reads the full
 * bundle
 * transcript and the saving evaporates. This module persists the reduction as a
 * boundary + summary on the session (migration 128) so the NEXT run starts from
 * the summary + a recent tail — durable, cross-run cost reduction.
 *
 * It operates over durable message sequences (not the runner's in-memory array), so the summary
 * and the boundary are always aligned (no gap) and there's no in-memory-to-disk
 * index mapping. Cumulative: any prior summary is folded into the new one. Runs
 * off the hot path (fire-and-forget from `index.ts`); any failure is a no-op
 * for the run — we simply don't move the boundary.
 */
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/index.js';
import type { SessionId } from '@mcp/session-storage';
import {
  computeCutoffIndexByTokens,
  snapCutoffPreservingPairs,
  recedeToPreserveLastNTurns,
  recedeToPreserveLastNRenderableTurns,
} from '@mcp/code-agent/core/compaction/cutoff.js';
import { summarizeSpanV2, renderSummaryV2 } from '@mcp/code-agent/core/summarizer.js';
import { computeProtectTokens, resolveRecedeTailRatio, computeMinTailTurns } from './threshold.js';
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
  /** The structured summary that was persisted — handed to the memory
   *  harvest so distillation reuses the LLM call already paid for here. */
  summary?: import('@mcp/code-agent/core/summarizer.js').CompactionSummaryV2;
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
  store: FsSessionStore;
  sessionId: SessionId;
  provider: ChatProvider;
  /**
   * Test-only override for the summary step. Production passes undefined so we
   * use the real `summarizeSpanV2` (driven by `provider`). Mirrors the same
   * injection point on `compactWithLLM`.
   */
  summarize?: (
    head: AgentMessage[],
    provider: ChatProvider,
  ) => Promise<import('@mcp/code-agent/core/summarizer.js').CompactionSummaryV2 | null>;
}): Promise<DurableCompactionResult> {
  const { store, sessionId, provider } = args;
  const data = await store.loadSessionWithMessages(sessionId);
  if (!data) return { ok: false, reason: 'nothing-to-compact' };

  const rows = data.message_rows;
  const msgs = data.messages;
  if (rows.length < MIN_ROWS) return { ok: false, reason: 'too-short' };

  const protectTokens = computeProtectTokens({ model: provider.model });
  const maxTailTokens = computeProtectTokens({ model: provider.model, protectRatio: resolveRecedeTailRatio() });
  let cutoff = computeCutoffIndexByTokens(msgs, protectTokens);
  cutoff = recedeToPreserveLastNTurns(msgs, cutoff, preserveLastNTurns(), maxTailTokens);
  // Message-count floor: keep at least the last N renderable turns verbatim so a
  // token-dense tail can't collapse the recent working state (same as the
  // in-memory compactor). Bounded by the recede ceiling so it can't overflow.
  const renderableTurns = msgs.reduce((acc, m) => acc + (m.role !== 'tool' ? 1 : 0), 0);
  cutoff = recedeToPreserveLastNRenderableTurns(msgs, cutoff, computeMinTailTurns(renderableTurns), maxTailTokens);
  cutoff = snapCutoffPreservingPairs(msgs, cutoff);
  if (cutoff <= 0 || cutoff >= msgs.length) return { ok: false, reason: 'nothing-to-compact' };

  const prior = data.session.compaction_summary;
  const head: AgentMessage[] = prior
    ? [summaryMessage(prior), ...msgs.slice(0, cutoff)]
    : msgs.slice(0, cutoff);

  const summarize = args.summarize ?? summarizeSpanV2;
  const summary = await summarize(head, provider);
  if (!summary) return { ok: false, reason: 'summary-failed' };

  const boundarySeq = rows[cutoff - 1].seq;
  const res = await store.setCompactionBoundary(
    sessionId,
    renderSummaryV2(summary),
    boundarySeq,
    'auto',
  );
  return {
    ok: true,
    boundaryId: res.boundary_seq,
    prunedCount: res.pruned_count,
    summary,
  };
}
