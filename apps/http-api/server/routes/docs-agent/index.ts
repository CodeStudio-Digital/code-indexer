/**
 * /api/docs-agent/* — HTTP surface for the DocsAgent (multi-step research).
 *
 *   POST /api/docs-agent/research                One-shot research (synchronous JSON).
 *                                                Returns the full DocsResearchResult.
 *   POST /api/docs-agent/research/stream         Same payload, but streams turn
 *                                                events via SSE so the dashboard
 *                                                can render progress in real-time.
 *   GET  /api/docs-agent/sessions                List recent research sessions.
 *   GET  /api/docs-agent/sessions/:id            Detail for one session.
 *   DELETE /api/docs-agent/sessions/:id          Drop a session.
 *
 * Auth: inherits the shared bearer middleware mounted in server.ts.
 *
 * NOTE: the SSE variant is intentionally minimal in this MVP — it sends
 * `progress` events on each runner turn and a `done`/`error` terminal
 * frame. A future revision can stream per-tool-call events by attaching
 * to the runner's EventEmitter.
 */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, parseIntQuery, notFound } from '../_helpers.js';
import { attachHeartbeat } from '../../../sse/SSEHeartbeat.js';
import { DocsResearchSessionsStore } from '@mcp/docs-agent/session-store/docs-research-sessions-store.js';
import type { DocsResearchBridge } from '@mcp/docs-agent/bridges/docs-bridge.js';

interface ResearchBody {
  query: string;
  collections?: string[];
  parent_coder_session_id?: number | null;
  max_turns?: number;
}

export function mountDocsAgentRoutes(
  app: Hono,
  deps: ServerDeps,
  bridge: DocsResearchBridge,
): void {
  const sessionsStore = new DocsResearchSessionsStore(deps.db.raw());

  // ─── Research: one-shot JSON ──────────────────────────────────────

  app.post('/api/docs-agent/research', async (c) => {
    const body = await parseJsonBody<ResearchBody>(c);
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!query) return c.json({ error: 'query is required' }, 400);
    const collections = Array.isArray(body.collections)
      ? body.collections.filter((s): s is string => typeof s === 'string')
      : undefined;
    const parentCoderSessionId = typeof body.parent_coder_session_id === 'number'
      ? body.parent_coder_session_id
      : null;
    const maxTurns = typeof body.max_turns === 'number' && body.max_turns > 0
      ? Math.min(8, Math.floor(body.max_turns))
      : undefined;

    try {
      const result = await bridge.runResearch({
        query,
        collections,
        parentCoderSessionId,
        maxTurns,
      });
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `research failed: ${message}` }, 500);
    }
  });

  // ─── Research: SSE stream ─────────────────────────────────────────
  //
  // For the MVP the SSE channel surfaces three events:
  //   - `open`    immediately on connect (proves the stream is live).
  //   - `done`    once with the full DocsResearchResult.
  //   - `error`   on failure.
  // Future iterations can attach to the runner's EventEmitter to stream
  // per-turn events (turn_start, tool_call_started, tool_call_finished).

  app.post('/api/docs-agent/research/stream', async (c) => {
    const body = await parseJsonBody<ResearchBody>(c);
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!query) return c.json({ error: 'query is required' }, 400);
    const collections = Array.isArray(body.collections)
      ? body.collections.filter((s): s is string => typeof s === 'string')
      : undefined;
    const parentCoderSessionId = typeof body.parent_coder_session_id === 'number'
      ? body.parent_coder_session_id
      : null;
    const maxTurns = typeof body.max_turns === 'number' && body.max_turns > 0
      ? Math.min(8, Math.floor(body.max_turns))
      : undefined;

    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      const stopHeartbeat = attachHeartbeat(stream);
      let seq = 0;
      const send = (event: string, data: unknown) =>
        stream.writeSSE({ id: String(seq++), event, data: JSON.stringify(data) });
      await send('open', { ok: true, ts: Date.now() });
      try {
        const result = await bridge.runResearch({
          query,
          collections,
          parentCoderSessionId,
          maxTurns,
        });
        await send('done', result);
      } catch (err) {
        await send('error', {
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        stopHeartbeat();
        await stream.close();
      }
    });
  });

  // ─── Sessions: list + detail + delete ─────────────────────────────

  app.get('/api/docs-agent/sessions', (c) => {
    const parentRaw = c.req.query('parent_coder_session_id');
    const parentCoderSessionId = parentRaw != null ? parseInt(parentRaw, 10) : undefined;
    const limit = parseIntQuery(c, 'limit', 50);
    const status = c.req.query('status') as 'running' | 'completed' | 'failed' | 'aborted' | undefined;
    const sessions = sessionsStore.list({
      parentCoderSessionId: Number.isFinite(parentCoderSessionId) ? parentCoderSessionId : undefined,
      status,
      limit,
    });
    return c.json({ sessions });
  });

  app.get('/api/docs-agent/sessions/:id', (c) => {
    const id = parseIdParam(c);
    const session = sessionsStore.get(id);
    if (!session) return notFound(c);
    // Hydrate cited chunks (chunk_id → heading_path + source_uri) so the
    // dashboard can render footnote anchors without a second roundtrip.
    let citedChunks: Array<{ id: number; heading_path: string | null; source_uri: string | null; summary: string | null }> = [];
    if (session.final_chunk_ids_json) {
      try {
        const ids = JSON.parse(session.final_chunk_ids_json);
        if (Array.isArray(ids)) {
          const chunks = deps.docStore.getChunksByIds(ids.filter((n) => typeof n === 'number'));
          citedChunks = chunks.map((c) => ({
            id: c.id,
            heading_path: c.heading_path,
            source_uri: c.source_uri,
            summary: c.summary,
          }));
        }
      } catch {
        // Malformed JSON in the row — surface as empty.
      }
    }
    return c.json({ session, cited_chunks: citedChunks });
  });

  app.delete('/api/docs-agent/sessions/:id', (c) => {
    const id = parseIdParam(c);
    const ok = sessionsStore.delete(id);
    if (!ok) return notFound(c);
    return c.json({ ok: true });
  });
}
