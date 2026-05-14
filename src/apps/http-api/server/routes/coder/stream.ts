import type { Hono } from 'hono';
import { runCoder } from '../../../../../core/coder/index.js';
import type { CoderAttachment } from '../../../../../core/coder/index.js';
import type { AgentMessage } from '../../../../../core/coder/core/messages.js';
import {
  createBus,
  publish,
  markEnded,
  setBusRunner,
} from '../../../coder-bus.js';
import type { ServerDeps } from '../../deps.js';
import type { CoderRuntime } from './state.js';
import { pumpBusToSSE, parseLastEventId } from '../../../sse/pumpBusToSSE.js';
import { parseIdParam, notFound } from '../_helpers.js';
import { withSessionLock } from './sessionLock.js';
import { enrichContentWithActiveSkills } from './active-skills.js';

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
  /** Enable thinking/reasoning mode for providers that support it. */
  thinking?: boolean;
  /**
   * Opt-in: when there is already a live run for this session AND it is
   * blocked inside an interactive tool (ask_user / submit_plan / submit_tasks),
   * interrupt that wait and inject this message instead of returning 409.
   * Default false — the canonical answer path is /answer or /plan-response.
   */
  interject?: boolean;
  /**
   * Skill IDs the user manually pre-selected in the sidebar's SkillsSection.
   * Each id is expanded into an `<active_skills>` block prepended to
   * `content` so the model gets the skill body inline without needing to
   * call `get_skill_content` first.
   */
  selected_skill_ids?: string[];
}

/**
 * Window during which we'll wait for `bus.runner` to become available when
 * a second POST /messages arrives during a fresh run's setup phase. Five
 * seconds is comfortably more than `runCoder` ever takes locally; if it
 * exceeds this we'd rather fail fast than block the request handler.
 */
const RUNNER_READY_TIMEOUT_MS = 5_000;

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
    const id = parseIdParam(c);
    const bus = activeRuns.get(id);
    if (!bus) return c.json({ error: 'no active run' }, 404);

    return pumpBusToSSE(c, bus, { since: parseLastEventId(c), heartbeat: false });
  });

  app.post('/api/coder/sessions/:id/messages', async (c) => {
    const id = parseIdParam(c);
    const body = await c.req.json<SendMessageBody>();
    if (!body.content?.trim()) return c.json({ error: 'content required' }, 400);

    // Expand manually-picked skills into an `<active_skills>` block. Mutates
    // body.content so the enriched text flows through both the attach-mode
    // (pushUserMessage / appendMessage) and fresh-run (runCoder) paths below.
    if (body.selected_skill_ids && body.selected_skill_ids.length > 0) {
      const enrich = await enrichContentWithActiveSkills(
        body.content,
        body.selected_skill_ids,
        id,
        deps,
      );
      body.content = enrich.content;
      if (enrich.missing.length > 0) {
        console.warn(
          `[active-skills] session ${id}: skipped unknown skill ids: ${enrich.missing.join(', ')}`,
        );
      }
    }

    // Serialize the "do we have an active run?" decision per session so two
    // concurrent POSTs cannot both observe `activeRuns.get(id) === undefined`
    // and each spin up a fresh `runCoder`. Inside the lock we either:
    //   (a) attach to the live run by enqueueing the message + tailing the
    //       existing bus, or
    //   (b) create a brand new bus + runCoder and tail that.
    // The lock is released as soon as the synchronous setup completes — the
    // SSE stream itself is not held under the lock.
    const decision = await withSessionLock(id, async (): Promise<
      | { kind: 'attach'; bus: ReturnType<typeof createBus>; tailFrom: number }
      | { kind: 'fresh'; bus: ReturnType<typeof createBus> }
      | { kind: 'reject'; status: 409; body: { error: string; code: string } }
    > => {
      const existing = activeRuns.get(id);
      if (existing && !existing.ended) {
        // Attachments are intentionally not supported on enqueue-and-attach:
        // the runner's pendingUserMessages buffer is text-only and the live
        // turn already committed to whatever attachments were sent at start.
        // Reject explicitly so the caller knows to either start a new session
        // or wait for the current run to finish.
        if (body.attachments && body.attachments.length > 0) {
          return {
            kind: 'reject',
            status: 409,
            body: {
              error: 'attachments are only supported on the first message of a session — drop them or wait for the current run to finish',
              code: 'ATTACHMENTS_MIDRUN_UNSUPPORTED',
            },
          };
        }

        let runner;
        try {
          runner = await Promise.race([
            existing.runnerReady,
            new Promise<never>((_, rej) =>
              setTimeout(() => rej(new Error('runner not ready')), RUNNER_READY_TIMEOUT_MS),
            ),
          ]);
        } catch {
          // The first run failed before wiring its runner, or setup is
          // taking abnormally long. Fall through to creating a fresh run —
          // the failed bus will linger-evict on its own timer.
          return { kind: 'fresh', bus: startFreshRun() };
        }

        // Live run waiting on an interactive tool? `interject:true` means
        // "abandon the wait and process my message instead" (mirrors how
        // company subordinates wake the master from `wait_for_subordinates`).
        // Without `interject` we steer callers to the canonical /answer route.
        if (runner.isWaitingForInput()) {
          if (!body.interject) {
            return {
              kind: 'reject',
              status: 409,
              body: {
                error: 'runner is waiting for an interactive answer — use /answer or /plan-response, or pass {"interject": true} to override',
                code: 'INTERACTION_PENDING',
              },
            };
          }
          runner.interruptWait();
        }

        // Persist the user message BEFORE pushing it onto the runner's
        // pendingUserMessages buffer. If the runner crashes/aborts before
        // flushing, the message is still in the DB so a future resume can
        // pick it up. The runner only consumes its in-memory history during
        // a run, so there is no DB-to-runner race here.
        const userMsg: AgentMessage = {
          role: 'user',
          content: [{ type: 'text', text: body.content }],
        };
        sessionStore.appendMessage(id, userMsg);
        runner.pushUserMessage(body.content);

        // Tail mode: subscribe to events from now on, no replay. The runner
        // will emit a fresh `turn_start` (and downstream tool calls) when
        // it picks up the enqueued message at the next turn boundary.
        return { kind: 'attach', bus: existing, tailFrom: existing.nextSeq - 1 };
      }

      // No live run, or the previous bus is in its 30s linger window with
      // `ended === true`. Either way, create a new run.
      return { kind: 'fresh', bus: startFreshRun() };

      // Synchronous setup of a fresh run + register in activeRuns. The
      // actual `runCoder()` call is fired into the background below so the
      // lock returns quickly.
      function startFreshRun() {
        const ctrl = new AbortController();
        const newBus = createBus(ctrl);
        activeRuns.set(id, newBus);
        return newBus;
      }
    });

    if (decision.kind === 'reject') {
      return c.json(decision.body, decision.status);
    }
    if (decision.kind === 'attach') {
      return pumpBusToSSE(c, decision.bus, {
        since: decision.tailFrom,
        heartbeat: false,
      });
    }

    // Fresh run: fire runCoder fire-and-forget. The HTTP response only
    // subscribes to the bus — if the client disconnects, the run keeps
    // producing events into the buffer until it finishes.
    const bus = decision.bus;
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
          thinking: body.thinking,
          signal: bus.ctrl.signal,
          mcpBearerResolver: deps.mcpBearerResolver,
          onSnapshotRecorded: (info) => publish(bus, 'session_snapshot_changed', info),
        });
        setBusRunner(bus, handle.runner);
        publish(bus, 'session', handle.session);
        publish(bus, 'index_status', handle.indexStatus);
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

    return pumpBusToSSE(c, bus, { heartbeat: false });
  });

  /**
   * Continue a session that was paused on a pending plan/question after the
   * dashboard answered it via /plan-response or /answer with `{resumed:true}`.
   * Mirrors POST /messages but calls runCoder with `resume: true` so no new
   * user message is pushed — the runner picks up from history (which now ends
   * with the just-appended tool_result) and runs the next turn.
   */
  app.post('/api/coder/sessions/:id/continue', async (c) => {
    const id = parseIdParam(c);
    let body: ContinueBody = {};
    try {
      body = await c.req.json();
    } catch {
      /* empty body is fine */
    }

    const data = sessionStore.loadSessionWithMessages(id);
    if (!data) return notFound(c);
    const last = data.messages[data.messages.length - 1];
    if (!last || last.role !== 'tool') {
      return c.json({ error: 'session not in resumable state' }, 409);
    }

    // Take the lock so a /continue racing with a /messages can't both spin
    // up runCoder for the same session. We hold it only across the
    // synchronous setup; the SSE pump runs outside the lock.
    const bus = await withSessionLock(id, async () => {
      const ctrl = new AbortController();
      const newBus = createBus(ctrl);
      activeRuns.set(id, newBus);
      return newBus;
    });

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
          signal: bus.ctrl.signal,
          mcpBearerResolver: deps.mcpBearerResolver,
          onSnapshotRecorded: (info) => publish(bus, 'session_snapshot_changed', info),
        });
        setBusRunner(bus, handle.runner);
        publish(bus, 'session', handle.session);
        publish(bus, 'index_status', handle.indexStatus);
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

    return pumpBusToSSE(c, bus, { heartbeat: false });
  });
}
