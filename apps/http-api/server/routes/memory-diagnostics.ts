import type { Hono } from 'hono';
import { createCoderProvider } from '@mcp/services/providers/factory.js';
import { summarizeSpanV2 } from '@mcp/code-agent/core/summarizer.js';
import { DistillLlmError } from '@mcp/services/memory/distill-call.js';
import { runDistillOnce } from '@mcp/services/memory/distiller.js';
import { generalDefaultAsFallback } from '@mcp/services/pipelines/general-fallback.js';
import type { ServerDeps } from '../deps.js';
import { parseIdParam, parseSessionIdValue } from './_helpers.js';

/**
 * Memory pipeline diagnostics — the one-click answer to "why is my agent
 * memory empty?". `distill-dry-run` replays the exact distill pass the
 * sweeper/harvest would run over a real session span — same binding
 * resolution, same prompt, same parser — but WITHOUT persisting anything or
 * touching the distill boundary/log, and returns the raw LLM response (or
 * the typed transport failure) so a broken binding is visible in one call.
 * LLM cost is on-demand only (operator-triggered).
 */
const SPAN_MESSAGE_CAP = 200;

export function mountMemoryDiagnosticsRoutes(app: Hono, deps: ServerDeps): void {
  app.post('/api/projects/:id/memory/distill-dry-run', async (c) => {
    const projectId = parseIdParam(c);
    const body = await c.req
      .json<{ sessionId?: string }>()
      .catch(() => ({} as { sessionId?: string }));
    const startedAt = Date.now();

    let session = body.sessionId
      ? await deps.sessionStore.getSession(
          parseSessionIdValue(body.sessionId, 'sessionId'),
        )
      : null;
    if (!body.sessionId) {
      for (const candidate of await deps.sessionStore.listSessions(projectId)) {
        if ((await deps.sessionStore.listMessagesAfter(candidate.id, 0)).messages.length > 0) {
          session = candidate;
          break;
        }
      }
    }
    if (!session) return c.json({ error: 'no session with messages found for this project' }, 404);

    // Same span the sweeper would take (past the distill mark); fall back to
    // the whole transcript when the mark already covers everything.
    const mark = await deps.sessionStore.getMemoryDistilledBoundary(session.id);
    let span = await deps.sessionStore.listMessagesAfter(session.id, mark);
    if (span.messages.length === 0) {
      span = await deps.sessionStore.listMessagesAfter(session.id, 0);
    }
    if (span.messages.length === 0) return c.json({ error: `session ${session.id} has no messages` }, 404);
    const messages = span.messages.slice(-SPAN_MESSAGE_CAP);

    const bindingInfo = await deps.pipelineProviderResolver
      .resolveOrNull('memory_extraction', 'distiller', {}, generalDefaultAsFallback(deps.providerStore) ?? undefined)
      .then((b) => b && {
        provider: b.provider.id, kind: b.provider.kind, model: b.modelId,
        resolvedFrom: b.resolvedFrom, config: b.config,
      })
      .catch(() => null);

    let summaryText: string | undefined;
    try {
      const provider = await createCoderProvider(session.provider, session.model);
      const summary = await summarizeSpanV2(messages, provider);
      if (summary) {
        const { renderSummaryV2 } = await import('@mcp/code-agent/core/summarizer.js');
        summaryText = renderSummaryV2(summary);
      }
    } catch (e) {
      return c.json({
        ok: false, step: 'summarize', sessionId: session.id, binding: bindingInfo,
        error: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - startedAt,
      });
    }
    if (!summaryText) {
      return c.json({
        ok: false, step: 'summarize', sessionId: session.id, binding: bindingInfo,
        error: 'summarizer returned no result (session provider unreachable?)',
        durationMs: Date.now() - startedAt,
      });
    }

    try {
      const { content, diag, candidates } = await runDistillOnce(
        {
          resolver: deps.pipelineProviderResolver,
          getFallbackDefault: () => generalDefaultAsFallback(deps.providerStore),
        },
        { summary: summaryText },
      );
      return c.json({
        ok: true, sessionId: session.id, spanMessages: messages.length, binding: bindingInfo,
        summary: summaryText.slice(0, 2000), diag, rawResponse: content.slice(0, 4000),
        candidates, durationMs: Date.now() - startedAt,
      });
    } catch (e) {
      const diag = e instanceof DistillLlmError ? e.diag : undefined;
      return c.json({
        ok: false, step: 'distill', sessionId: session.id, spanMessages: messages.length,
        binding: bindingInfo, summary: summaryText.slice(0, 2000), diag,
        error: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - startedAt,
      });
    }
  });
}
