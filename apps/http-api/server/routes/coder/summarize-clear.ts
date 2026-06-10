/**
 * Manual "summarize & clear" — POST /api/coder/sessions/:id/summarize-and-clear.
 *
 * Persistent counterpart to the in-memory auto-compaction. It summarizes the
 * currently-visible transcript with the SAME summarizer the runner uses
 * (`summarizeSpanV2` → `renderSummaryV2`), driven by the session's own
 * provider/model, then commits a durable boundary (`setCompactionBoundary`):
 * the summary is stored on the session and prepended on load, while the old
 * rows drop out of the default view (still in the DB, reopenable via "view
 * earlier history"). Same mechanism the automatic durable compaction uses.
 *
 * Notes / investigations / project memory live in separate tables and are
 * re-injected automatically on turn 1 of the fresh transcript — they survive
 * the clear without any work here.
 */
import type { Hono } from 'hono';
import { createCoderProvider } from '@mcp/services/providers/factory.js';
import { summarizeSpanV2, renderSummaryV2 } from '@mcp/code-agent/core/summarizer.js';
import type { ServerDeps } from '../../deps.js';
import type { CoderRuntime } from './state.js';
import { parseIdParam, notFound } from '../_helpers.js';
import { withSessionLock } from './sessionLock.js';

/**
 * Below this many visible messages there is nothing worth compacting — refuse
 * so the user doesn't replace a 2-message chat with a summary that's longer
 * than the chat itself.
 */
const MIN_MESSAGES_TO_SUMMARIZE = 4;

export function mountCoderSummarizeClearRoute(
  app: Hono,
  deps: ServerDeps,
  runtime: CoderRuntime,
): void {
  const { sessionStore } = deps;
  const { activeRuns } = runtime;

  app.post('/api/coder/sessions/:id/summarize-and-clear', async (c) => {
    const id = parseIdParam(c);
    const session = sessionStore.getSession(id);
    if (!session) return notFound(c);

    // Serialize against the run setup path (which also takes this lock) so a
    // new turn cannot start between our active-run check and the commit.
    return withSessionLock(id, async () => {
      const bus = activeRuns.get(id);
      if (bus && !bus.ended) {
        return c.json(
          { error: 'a run is active — stop it before summarizing', code: 'run_active' },
          409,
        );
      }

      // Boundary-aware load: only the currently-visible transcript.
      const data = sessionStore.loadSessionWithMessages(id);
      if (!data) return notFound(c);
      if (data.messages.length < MIN_MESSAGES_TO_SUMMARIZE) {
        return c.json(
          { error: 'not enough messages to summarize', code: 'too_short' },
          400,
        );
      }

      let provider;
      try {
        provider = await createCoderProvider(session.provider, session.model);
      } catch (e) {
        return c.json(
          {
            error: `session provider unavailable: ${e instanceof Error ? e.message : String(e)}`,
            code: 'provider_unavailable',
          },
          412,
        );
      }

      let summary;
      try {
        summary = await summarizeSpanV2(data.messages, provider);
      } catch (e) {
        return c.json(
          { error: `summarization failed: ${e instanceof Error ? e.message : String(e)}` },
          502,
        );
      }
      // Never clear without a summary — a failed/empty summarization is a no-op.
      if (!summary) {
        return c.json(
          { error: 'summarizer returned no result', code: 'summary_failed' },
          502,
        );
      }

      // Anchor the summary to the live plan when the LLM didn't surface a goal.
      try {
        const plan = sessionStore.getDriveInjectionPayload(id)?.activePlan;
        if (plan?.text && !summary.active_goal) summary.active_goal = plan.text;
      } catch {
        /* best-effort */
      }

      // Full clear: hide the whole visible transcript, store the summary as the
      // prepended head. boundary = current MAX(id) → no verbatim tail remains.
      const boundaryId = sessionStore.maxMessageId(id);
      const result = sessionStore.setCompactionBoundary(id, renderSummaryV2(summary), boundaryId, 'manual');

      // Drop any lingering (ended) bus so the next /messages POST builds a
      // fresh, boundary-aware runner that loads only the summary onward.
      activeRuns.delete(id);

      return c.json({ ok: true, ...result });
    });
  });
}
