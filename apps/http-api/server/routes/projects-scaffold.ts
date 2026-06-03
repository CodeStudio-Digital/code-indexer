import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { runScaffoldStream } from '@mcp/api-handlers';
import type { ScaffoldProjectInput, ScaffoldStreamEvent } from '@mcp/api-bus';
import type { ServerDeps } from '../deps.js';
import { parseJsonBody } from './_helpers.js';

/**
 * SSE route for the New Project wizard. Scaffolds a project on the host
 * (`~/.mcp-code-indexer/projects/<slug>`) from a stack template / git clone / empty,
 * then registers it — streaming `start`/`phase`/`log`/`done`/`error`
 * frames. `c.req.raw.signal` is threaded into the scaffold so closing the
 * wizard (client disconnect) aborts the underlying npm/git process.
 *
 * Mirrors the SSE shape of the index-stream route in projects.ts; the
 * Electron transport pumps the same `runScaffoldStream` over a MessagePort
 * via `projects.scaffold`.
 */
export function mountProjectScaffoldRoute(app: Hono, deps: ServerDeps): void {
  app.post('/api/projects/scaffold/stream', async (c) => {
    // Shape is re-validated inside runScaffoldStream (validateScaffoldInput),
    // so a partial/raw body is fine here.
    const body = (await parseJsonBody<ScaffoldProjectInput>(c)) as ScaffoldProjectInput;
    const signal = c.req.raw.signal;

    return streamSSE(c, async (stream) => {
      let seq = 0;
      const emit = (ev: ScaffoldStreamEvent) =>
        stream.writeSSE({ id: String(seq++), event: ev.event, data: JSON.stringify(ev.data) });
      try {
        await runScaffoldStream(deps, body, (ev) => void emit(ev), signal);
      } catch (err) {
        await emit({
          event: 'error',
          data: { message: err instanceof Error ? err.message : String(err) },
        });
      } finally {
        await stream.close();
      }
    });
  });
}
