/**
 * Manual "summarize & clear" — POST /api/coder/sessions/:id/summarize-and-clear.
 *
 * Persistent counterpart to the in-memory auto-compaction. It summarizes the
 * currently-visible transcript with the SAME summarizer the runner uses
 * (`summarizeSpanV3`), driven by the optional code-agent/compaction binding
 * (or the session provider), then atomically appends a chapter + boundary:
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
import {
  renderChapterV3,
  renderResumeV3,
  summarizeSpanV3,
  summaryV3ToV2,
} from '@mcp/code-agent/core/summarizer.js';
import { harvestCompactionMemory } from '@mcp/code-agent/core/runner/compaction/memory-harvest.js';
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
        const binding = await deps.pipelineProviderResolver.resolveOrNull(
          'code-agent',
          'compaction',
          { sessionId: id },
        );
        provider = binding
          ? await createCoderProvider(binding.provider.id, binding.modelId)
          : await createCoderProvider(session.provider, session.model);
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
        let liveState = null;
        try {
          const state = sessionStore.getSessionStateData(id);
          liveState = state ? {
            goal: state.goal,
            activePlan: state.activePlan,
            todos: state.todos.map((todo) => ({
              content: todo.label,
              activeForm: todo.label,
              status: todo.status,
            })),
          } : null;
        } catch {
          liveState = null;
        }
        summary = await summarizeSpanV3({
          previousResume: data.session.compaction_summary,
          messages: data.messages,
          liveState,
        }, provider);
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

      // Full clear: hide the whole visible transcript, store the summary as the
      // prepended head. boundary = current MAX(id) → no verbatim tail remains.
      const firstRow = data.message_rows[0]!;
      const lastRow = data.message_rows[data.message_rows.length - 1]!;
      const boundaryId = lastRow.id;
      const result = process.env.CODER_CONVERSATION_CHAPTERS === '0'
        ? sessionStore.setCompactionBoundary(id, renderResumeV3(summary), boundaryId, 'manual')
        : sessionStore.commitConversationChapter({
            sessionId: id,
            expectedBoundaryId: data.session.summary_boundary_id ?? 0,
            startMessageId: firstRow.id,
            endMessageId: boundaryId,
            source: 'manual',
            trigger: 'manual_clear',
            title: summary.chapter.title || 'Manual conversation summary',
            chapterJson: JSON.stringify(summary.chapter),
            chapterText: renderChapterV3(summary),
            resumeJson: JSON.stringify(summary.resume),
            resumeText: renderResumeV3(summary),
            version: summary.version,
            metricsJson: summary.metrics ? JSON.stringify(summary.metrics) : null,
          });
      if ('status' in result && result.status === 'noop') {
        const reason = 'reason' in result ? String(result.reason) : 'boundary_changed';
        return c.json(
          { error: `conversation boundary changed (${reason})`, code: 'boundary_changed' },
          409,
        );
      }

      // Memory harvest — distill durable project memory from the summary we
      // JUST paid for (same pipeline as the automatic compaction harvest).
      // Fire-and-forget: a failed harvest never affects the clear.
      if (session.project_id != null) {
        void harvestCompactionMemory({
          runEndMemory: deps.runEndMemory,
          store: sessionStore,
          // Gate on the WRITE target: a global session redirects the write to the
          // primary real project (deps.runEndMemory), so a disabled primary must
          // not be written to. Identity for ordinary projects.
          getMemoryEnabled: () => deps.db.getProjectMemoryEnabled(deps.db.resolveMemoryWriteProject(session.project_id).id),
          projectId: session.project_id,
          projectName: deps.db.getProject(session.project_id)?.name ?? '',
          sessionId: id,
          summary: summaryV3ToV2(summary),
          boundaryId,
          trigger: 'manual_clear',
        });
      }

      // Drop any lingering (ended) bus so the next /messages POST builds a
      // fresh, boundary-aware runner that loads only the summary onward.
      activeRuns.delete(id);

      return c.json({
        ok: true,
        boundary_id: result.boundary_id,
        pruned_count: result.pruned_count,
        ...('chapter' in result ? { chapter: result.chapter } : {}),
      });
    });
  });
}
