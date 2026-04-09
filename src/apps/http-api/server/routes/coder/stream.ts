import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { runCoder } from '../../../../../core/coder/index.js';
import type { CoderAttachment } from '../../../../../core/coder/index.js';
import {
  createBus,
  publish,
  markEnded,
  subscribe,
  waitEnded,
} from '../../../coder-bus.js';
import type { ServerDeps } from '../../deps.js';
import type { CoderRuntime } from './state.js';

interface SendMessageBody {
  content: string;
  max_turns?: number;
  plan_mode?: boolean;
  attachments?: CoderAttachment[];
  /** Agent preset: explore | plan | build | admin. Takes precedence over profile/plan_mode when unset. */
  agent?: 'explore' | 'plan' | 'build' | 'admin';
  /** Tool tier profile: bootstrap | navigate | full | auto. */
  profile?: 'bootstrap' | 'navigate' | 'full' | 'auto';
  /**
   * When set on the FIRST message of a fresh session, creates an isolated
   * git worktree and scopes the session into it. Ignored on resume runs.
   */
  worktree?: { name?: string; branch?: string };
}

interface ContinueBody {
  plan_mode?: boolean;
  max_turns?: number;
  agent?: 'explore' | 'plan' | 'build' | 'admin';
  profile?: 'bootstrap' | 'navigate' | 'full' | 'auto';
}

export function mountCoderStreamRoutes(
  app: Hono,
  deps: ServerDeps,
  runtime: CoderRuntime,
): void {
  const { sessionStore } = deps;
  const { activeRuns, BUS_LINGER_MS, wireRunnerToBus } = runtime;

  /**
   * Reattach to an in-flight run via SSE. Replays buffered events from
   * (Last-Event-ID + 1) and then forwards live events until the run ends
   * or the client disconnects.
   */
  app.get('/api/coder/sessions/:id/attach', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const bus = activeRuns.get(id);
    if (!bus) return c.json({ error: 'no active run' }, 404);

    const sinceHeader = c.req.header('Last-Event-ID');
    const since = sinceHeader ? parseInt(sinceHeader, 10) : -1;

    return streamSSE(c, async (stream) => {
      const unsubscribe = subscribe(
        bus,
        (ev) => {
          void stream.writeSSE({
            id: String(ev.seq),
            event: ev.event,
            data: JSON.stringify(ev.data),
          });
        },
        Number.isFinite(since) ? since : -1,
      );
      try {
        await waitEnded(bus);
      } finally {
        unsubscribe();
        await stream.close();
      }
    });
  });

  app.post('/api/coder/sessions/:id/messages', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const body = await c.req.json<SendMessageBody>();
    if (!body.content?.trim()) return c.json({ error: 'content required' }, 400);

    const ctrl = new AbortController();
    const bus = createBus(ctrl);
    activeRuns.set(id, bus);

    // Fire-and-forget the run in the background. The HTTP response below
    // only subscribes to the bus — if the client disconnects, the run keeps
    // producing events into the buffer until it finishes.
    void (async () => {
      try {
        const handle = await runCoder({
          session: { id },
          userMessage: body.content,
          attachments: body.attachments,
          maxTurns: body.max_turns,
          planMode: body.plan_mode,
          agent: body.agent,
          profile: body.profile,
          worktree: body.worktree,
          signal: ctrl.signal,
        });
        bus.runner = handle.runner;
        publish(bus, 'session', handle.session);
        wireRunnerToBus(handle.runner, bus);
        await handle.done;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        publish(bus, 'error', { message });
        markEnded(bus, 'error', { message });
      } finally {
        // Linger in the map so a late reattach (tab closed near done) still
        // sees the full buffer. After BUS_LINGER_MS the entry is evicted.
        setTimeout(() => {
          if (activeRuns.get(id) === bus) activeRuns.delete(id);
        }, BUS_LINGER_MS);
      }
    })();

    return streamSSE(c, async (stream) => {
      const unsubscribe = subscribe(bus, (ev) => {
        void stream.writeSSE({
          id: String(ev.seq),
          event: ev.event,
          data: JSON.stringify(ev.data),
        });
      });
      try {
        await waitEnded(bus);
      } finally {
        unsubscribe();
        await stream.close();
      }
    });
  });

  /**
   * Continue a session that was paused on a pending plan/question after the
   * dashboard answered it via /plan-response or /answer with `{resumed:true}`.
   * Mirrors POST /messages but calls runCoder with `resume: true` so no new
   * user message is pushed — the runner picks up from history (which now ends
   * with the just-appended tool_result) and runs the next turn.
   */
  app.post('/api/coder/sessions/:id/continue', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    let body: ContinueBody = {};
    try {
      body = await c.req.json();
    } catch {
      /* empty body is fine */
    }

    const data = sessionStore.loadSessionWithMessages(id);
    if (!data) return c.json({ error: 'Not found' }, 404);
    const last = data.messages[data.messages.length - 1];
    if (!last || last.role !== 'tool') {
      return c.json({ error: 'session not in resumable state' }, 409);
    }

    const ctrl = new AbortController();
    const bus = createBus(ctrl);
    activeRuns.set(id, bus);

    void (async () => {
      try {
        const handle = await runCoder({
          session: { id },
          userMessage: '',
          maxTurns: body.max_turns,
          planMode: body.plan_mode,
          agent: body.agent,
          profile: body.profile,
          resume: true,
          signal: ctrl.signal,
        });
        bus.runner = handle.runner;
        publish(bus, 'session', handle.session);
        wireRunnerToBus(handle.runner, bus);
        await handle.done;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        publish(bus, 'error', { message });
        markEnded(bus, 'error', { message });
      } finally {
        setTimeout(() => {
          if (activeRuns.get(id) === bus) activeRuns.delete(id);
        }, BUS_LINGER_MS);
      }
    })();

    return streamSSE(c, async (stream) => {
      const unsubscribe = subscribe(bus, (ev) => {
        void stream.writeSSE({
          id: String(ev.seq),
          event: ev.event,
          data: JSON.stringify(ev.data),
        });
      });
      try {
        await waitEnded(bus);
      } finally {
        unsubscribe();
        await stream.close();
      }
    });
  });
}
