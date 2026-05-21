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
import { AutoDiscoveryService } from '@mcp/services/services/docs/index.js';

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

  // ─── Auto-discovery suggestions ───────────────────────────────────

  const autoDiscovery = new AutoDiscoveryService({ db: deps.db.raw() });

  app.get('/api/docs-agent/suggestions', (c) => {
    const projectIdRaw = c.req.query('project_id');
    const projectId = projectIdRaw != null ? parseInt(projectIdRaw, 10) : NaN;
    if (!Number.isFinite(projectId)) {
      return c.json({ error: 'project_id query parameter is required' }, 400);
    }
    const status = c.req.query('status') as
      | 'pending'
      | 'approved'
      | 'dismissed'
      | 'indexed'
      | undefined;
    const suggestions = deps.docStore.listSuggestions({ projectId, status });
    return c.json({ suggestions });
  });

  app.post('/api/docs-agent/suggestions/scan', async (c) => {
    const body = await parseJsonBody<{ project_id: number; project_root?: string }>(c);
    const projectId =
      typeof body.project_id === 'number' ? body.project_id : Number(body.project_id);
    if (!Number.isFinite(projectId)) {
      return c.json({ error: 'project_id is required' }, 400);
    }
    // Resolve project root — prefer the explicit one in the body (handy for
    // batch runs), otherwise fall back to the project's stored root_path.
    let projectRoot = typeof body.project_root === 'string' ? body.project_root : '';
    if (!projectRoot) {
      const project = deps.db.getProject(projectId);
      if (!project) return c.json({ error: 'project not found' }, 404);
      projectRoot = project.root_path;
    }
    try {
      const result = await autoDiscovery.scan({ projectId, projectRoot });
      return c.json({ ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `scan failed: ${message}` }, 500);
    }
  });

  app.post('/api/docs-agent/suggestions/:id/approve', async (c) => {
    const id = parseIdParam(c);
    const suggestion = deps.docStore.getSuggestion(id);
    if (!suggestion) return notFound(c);
    if (suggestion.status !== 'pending') {
      return c.json({ error: `suggestion is ${suggestion.status}, not pending` }, 409);
    }
    const body = await parseJsonBody<{ collection_id?: number; collection_name?: string }>(c);

    // Resolve the destination collection. If neither id nor name was
    // provided, the caller must create the collection first via /api/docs.
    let collectionId: number | undefined;
    if (typeof body.collection_id === 'number') {
      collectionId = body.collection_id;
      if (!deps.docStore.getCollection(collectionId)) {
        return c.json({ error: 'collection not found' }, 404);
      }
    } else if (typeof body.collection_name === 'string' && body.collection_name.trim()) {
      const existing = deps.docStore.getCollectionByName(body.collection_name.trim());
      if (existing) {
        collectionId = existing.id;
      } else {
        const created = deps.docStore.createCollection({
          name: body.collection_name.trim(),
          description: suggestion.suggested_title ?? null,
        });
        collectionId = created.id;
      }
    } else {
      return c.json({ error: 'collection_id or collection_name is required' }, 400);
    }

    // Persist the new source row (defer_indexing=true equivalent — the
    // caller will trigger ingestion via the existing /api/docs flow if
    // they want immediate fetch).
    try {
      const source = deps.docStore.createSource({
        collection_id: collectionId,
        type: 'url',
        uri: suggestion.suggested_url,
        title: suggestion.suggested_title,
        crawl: { enabled: false },
      });
      deps.docStore.setSuggestionStatus(id, 'approved', source.id);
      return c.json({ ok: true, source });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `approve failed: ${message}` }, 500);
    }
  });

  app.post('/api/docs-agent/suggestions/:id/dismiss', (c) => {
    const id = parseIdParam(c);
    const suggestion = deps.docStore.getSuggestion(id);
    if (!suggestion) return notFound(c);
    deps.docStore.setSuggestionStatus(id, 'dismissed');
    return c.json({ ok: true });
  });

  app.delete('/api/docs-agent/suggestions/:id', (c) => {
    const id = parseIdParam(c);
    const ok = deps.docStore.deleteSuggestion(id);
    if (!ok) return notFound(c);
    return c.json({ ok: true });
  });
}
