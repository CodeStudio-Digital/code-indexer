import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import type { CompanyOrchestrator } from '@mcp/company/orchestrator.js';
import { isPortClosedError } from '@mcp/orchestrator-host';
import {
  getCompanyOrchestrator,
  hasCompanyOrchestrator,
  deleteCompanyOrchestrator,
  getOrSpawnCompanyOrchestrator,
} from '../../../sse/companyOrchestrator.js';
import { pumpBusToSSE, parseLastEventId } from '../../../sse/pumpBusToSSE.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { withSessionLock } from '../coder/sessionLock.js';
import {
  getRuntimeEventLog,
  runtimeEventsToJsonl,
  summarizeRuntimeEvents,
} from '../../../sse/runtime-event-log.js';
import { resolveAndRunMaster } from './master-resolve.js';

/**
 * Backoff before retrying a resume that hit `port_closed`. The default
 * WorkerHost restart cadence is `500ms * 2^attempt` (capped 8s); 600ms
 * here covers the first restart attempt without making the user wait
 * forever if the worker is truly dead.
 */
const PORT_CLOSED_RETRY_DELAY_MS = 600;

/**
 * Backwards-compatible accessor used by sibling routes (kanban.ts).
 * Reads delegate to the worker pool via `companyOrchestrator`; writes
 * are not supported — all orchestrators are spawned via `getOrSpawn`.
 */
export const activeOrchestrators = {
  get: (id: number) => getCompanyOrchestrator(id),
  has: (id: number) => hasCompanyOrchestrator(id),
  delete: (id: number) => deleteCompanyOrchestrator(id),
};

interface AttachmentBody {
  name: string;
  mediaType: string;
  base64?: string;
  text?: string;
}

interface StartBody {
  user_message: string;
  max_turns?: number;
  attachments?: AttachmentBody[];
  /** Enable extended thinking (deep reasoning) for the master's first turn. */
  thinking?: boolean;
}

const MAX_ATTACHMENTS = 4;
// 14 MB base64 ≈ 10 MB raw — generous for UI screenshots, hard cap for safety.
const MAX_ATTACHMENT_BASE64_BYTES = 14 * 1024 * 1024;

function validateAttachments(input: unknown): { ok: true; value: AttachmentBody[] | undefined } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, value: undefined };
  if (!Array.isArray(input)) return { ok: false, error: 'attachments must be an array' };
  if (input.length === 0) return { ok: true, value: undefined };
  if (input.length > MAX_ATTACHMENTS) {
    return { ok: false, error: `attachments: at most ${MAX_ATTACHMENTS} items` };
  }
  const out: AttachmentBody[] = [];
  for (let i = 0; i < input.length; i++) {
    const att = input[i];
    if (!att || typeof att !== 'object') {
      return { ok: false, error: `attachments[${i}] must be an object` };
    }
    const a = att as Record<string, unknown>;
    if (typeof a.mediaType !== 'string' || !a.mediaType.startsWith('image/')) {
      return { ok: false, error: `attachments[${i}].mediaType must be "image/*"` };
    }
    if (typeof a.base64 !== 'string' || a.base64.length === 0) {
      return { ok: false, error: `attachments[${i}].base64 is required` };
    }
    if (a.base64.length > MAX_ATTACHMENT_BASE64_BYTES) {
      return { ok: false, error: `attachments[${i}] is too large (max ~10 MB)` };
    }
    out.push({
      name: typeof a.name === 'string' && a.name ? a.name : `attachment-${i + 1}`,
      mediaType: a.mediaType,
      base64: a.base64,
    });
  }
  return { ok: true, value: out };
}

interface PlanResponseBody {
  approved: boolean;
  feedback?: string;
  /** Optional id of the master_prompt being resolved (idempotent across replay). */
  prompt_id?: number;
}

export function mountCompanyStreamRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore, db } = deps;

  app.get('/api/company/sessions/:id/events.jsonl', (c) => {
    const id = parseIdParam(c);
    const events = getRuntimeEventLog('company', id);
    return new Response(runtimeEventsToJsonl(events), {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'content-disposition': `attachment; filename="company-session-${id}-events.jsonl"`,
      },
    });
  });

  app.get('/api/company/sessions/:id/events-summary', (c) => {
    const id = parseIdParam(c);
    return c.json(summarizeRuntimeEvents(getRuntimeEventLog('company', id)));
  });

  /**
   * Start the company session — spawns the Master agent and returns
   * a multiplexed SSE stream with all agent events enveloped.
   *
   * IMPORTANT: We AWAIT startMaster() before opening SSE. This ensures
   * the runner is wired to the metaBus before any events are emitted.
   * The subscribe with sinceSeq=-1 replays ALL buffered events, so
   * events emitted during startMaster() are never lost.
   */
  app.post('/api/company/sessions/:id/start', async (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);

    const body = await parseJsonBody<StartBody>(c);
    if (!body.user_message) {
      return c.json({ error: 'user_message required' }, 400);
    }
    const attachmentsCheck = validateAttachments(body.attachments);
    if (!attachmentsCheck.ok) {
      return c.json({ error: attachmentsCheck.error }, 400);
    }
    // Capture into a local const so TS narrowing survives the async closure below.
    const userMessage = body.user_message;
    const maxTurnsRequested = body.max_turns;
    const attachments = attachmentsCheck.value;

    // Serialize the "is there already a master for this id?" decision so two
    // concurrent POSTs cannot both pass the status check.
    const decision = await withSessionLock(id, async (): Promise<
      | {
          kind: 'success';
          orchestrator: CompanyOrchestrator;
          bus: CompanyOrchestrator['metaBus'];
        }
      | { kind: 'reject'; status: 404 | 409 | 500; body: { error: string } }
    > => {
      const cur = companyStore.getCompanySession(id);
      if (!cur) return { kind: 'reject', status: 404, body: { error: 'Not found' } };
      if (cur.status === 'running' || hasCompanyOrchestrator(id)) {
        return { kind: 'reject', status: 409, body: { error: 'Already running' } };
      }

      // Parse config from DB — this is the source of truth for roles
      let config: {
        master_provider?: string;
        master_model?: string;
        role_assignments?: Array<{ role: string; provider: string; model: string; tier: string; skills?: string[]; projectIds?: number[]; projectHints?: string[]; systemPromptOverride?: string }>;
      } = {};
      try { config = JSON.parse(cur.config_json); } catch { /* use defaults */ }

      const roleConfigs = (config.role_assignments ?? []) as Array<{
        role: string; provider: string; model: string; tier: string; skills?: string[]; projectIds?: number[]; projectHints?: string[]; systemPromptOverride?: string;
      }>;

      // Workers-only architecture: orchestrator lives in a dedicated
      // worker_thread via WorkerOrchestratorPool. Main-side proxy
      // mimics the CompanyOrchestrator surface (`startMaster`,
      // `metaBus`, etc.) via MessageBridge.
      const spawned = await getOrSpawnCompanyOrchestrator(id);
      const orchestrator = spawned.orchestrator;
      const busForPump = spawned.bus;

      // Pause any pipeline executions that were 'running' before the
      // server restart. The dashboard will surface a Resume button.
      // Fire-and-forget: never block startMaster on this.
      void orchestrator.pipelineRecoverRunning().catch((err) => {
        console.warn(`[company s=${id}] pipeline recovery failed:`, err);
      });

      // Await master spin-up — if it fails, return JSON error (not a broken SSE
      // stream). Resume-or-start: if this session ALREADY has a master run,
      // RESUME it (reuse coder-session + context) instead of spawning a
      // duplicate master. The 409 guard above already handled "currently
      // running"; here the session is stopped (error/idle/paused/completed).
      try {
        const masterExists = companyStore
          .listAgentRuns(id)
          .some((r) => r.role === 'master');
        await resolveAndRunMaster(orchestrator, masterExists, {
          userMessage,
          provider: config.master_provider ?? 'anthropic',
          model: config.master_model ?? 'claude-sonnet-4-6',
          maxTurns: maxTurnsRequested ?? 100,
          roleConfigs,
          attachments,
          thinking: body.thinking,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[company s=${id}] Master start failed:`, msg);
        // Evict the worker so the next /start gets a fresh one rather
        // than a half-initialized instance.
        deleteCompanyOrchestrator(id);
        companyStore.updateCompanySessionStatus(id, 'error');
        return { kind: 'reject', status: 500, body: { error: `Master start failed: ${msg}` } };
      }

      // Persist the user message so it survives page reload
      companyStore.setLastUserMessage(id, userMessage);
      return { kind: 'success', orchestrator, bus: busForPump };
    });

    if (decision.kind === 'reject') {
      return c.json(decision.body, decision.status);
    }

    return pumpBusToSSE(c, decision.bus, {
      since: -1,
      // Worker pool handles eviction via its own TTL sweep — no
      // explicit scheduling needed here.
      onDone: () => undefined,
    });
  });

  /**
   * Reattach to an in-flight company session's SSE stream.
   * Uses Last-Event-ID header for replay from the client's last seen seq.
   */
  app.get('/api/company/sessions/:id/attach', (c) => {
    const id = parseIdParam(c);
    const orchestrator = getCompanyOrchestrator(id);
    if (!orchestrator) return c.json({ error: 'No active orchestrator' }, 404);

    return pumpBusToSSE(c, orchestrator.metaBus, {
      since: parseLastEventId(c),
    });
  });

  /**
   * Resume a company session that has already run (completed/paused/error).
   * Creates a new orchestrator but resumes the master from the EXISTING coder
   * session, preserving full conversation history and board context.
   */
  app.post('/api/company/sessions/:id/resume', async (c) => {
    const id = parseIdParam(c);
    const body = await parseJsonBody<{ message: string; attachments?: AttachmentBody[]; thinking?: boolean }>(c);
    const attachmentsCheck = validateAttachments(body.attachments);
    if (!attachmentsCheck.ok) {
      return c.json({ error: attachmentsCheck.error }, 400);
    }
    const attachments = attachmentsCheck.value;

    // Serialize the "is there an existing orchestrator?" decision so two
    // concurrent /resume calls can't both observe registry-empty and each
    // create a fresh CompanyOrchestrator + start its own runCoder loop.
    const decision = await withSessionLock(id, async (): Promise<
      | { kind: 'attach'; orchestrator: CompanyOrchestrator; since: number; bus: CompanyOrchestrator['metaBus'] }
      | { kind: 'fresh'; orchestrator: CompanyOrchestrator; bus: CompanyOrchestrator['metaBus'] }
      | { kind: 'reject'; status: 400 | 404 | 500; body: { error: string } }
    > => {
      const existing = getCompanyOrchestrator(id);
      if (existing) {
        if (body.message) existing.sendMessageToMaster(body.message, { attachments, thinking: body.thinking });
        return { kind: 'attach', orchestrator: existing, since: parseLastEventId(c), bus: existing.metaBus };
      }

      const session = companyStore.getCompanySession(id);
      if (!session) return { kind: 'reject', status: 404, body: { error: 'Not found' } };
      if (!body.message) return { kind: 'reject', status: 400, body: { error: 'message required' } };
      const userMessage = body.message;

      // Sub-sessions (migration 067): a brand-new tab has no master_run
      // yet, so we cold-start instead of trying to resume.
      const agentRuns = companyStore.listAgentRuns(id);
      const masterRun = agentRuns.filter((r) => r.role === 'master').pop();

      // Parse role configs from session config
      let config: {
        master_provider?: string;
        master_model?: string;
        role_assignments?: Array<{ role: string; provider: string; model: string; tier: string; skills?: string[]; projectIds?: number[]; projectHints?: string[]; systemPromptOverride?: string }>;
      } = {};
      try { config = JSON.parse(session.config_json); } catch { /* defaults */ }
      const roleConfigs = config.role_assignments ?? [];

      // Spawn-or-attach helper. Wraps one full attempt at:
      //   1. getOrSpawn the orchestrator (creates worker if needed)
      //   2. fire pipeline recovery
      //   3. resume OR cold-start the master
      // Returns the spawn handle on success, throws on any failure.
      //
      // Extracted so the catch block can call it a SECOND time after a
      // `port_closed` (the WorkerHost auto-restarts on worker exit, so
      // the next `getOrSpawn` returns a fresh, healthy bridge).
      const attemptSpawnAndResume = async (): Promise<{
        orchestrator: CompanyOrchestrator;
        bus: CompanyOrchestrator['metaBus'];
      }> => {
        const spawned = await getOrSpawnCompanyOrchestrator(id);
        const orchestrator = spawned.orchestrator;
        void orchestrator.pipelineRecoverRunning().catch((err) => {
          console.warn(`[company s=${id}] pipeline recovery failed:`, err);
        });
        // Resume-or-start (shared with /start). `masterRun` present → resume
        // and reuse its coder-session; absent (brand-new sub-session) → cold
        // start. Never spawns a duplicate master for a session that has one.
        await resolveAndRunMaster(orchestrator, !!masterRun, {
          userMessage,
          provider: config.master_provider ?? 'anthropic',
          model: config.master_model ?? 'claude-sonnet-4-6',
          maxTurns: 100,
          roleConfigs,
          attachments,
          thinking: body.thinking,
        });
        return { orchestrator, bus: spawned.bus };
      };

      let result: { orchestrator: CompanyOrchestrator; bus: CompanyOrchestrator['metaBus'] };
      try {
        result = await attemptSpawnAndResume();
      } catch (err) {
        // `port_closed`: the worker exited mid-RPC and the auto-restart
        // pipeline (WorkerHost backoff ≈500ms→8s) was racing. Evict the
        // dead handle and try ONE more time with a fresh spawn. Any
        // subsequent failure propagates to the original 500 path so the
        // user isn't stuck in a silent loop.
        if (isPortClosedError(err)) {
          console.warn(
            `[company s=${id}] Resume hit port_closed; worker likely crashed mid-RPC. ` +
              `Evicting + retrying once after ${PORT_CLOSED_RETRY_DELAY_MS}ms.`,
          );
          deleteCompanyOrchestrator(id);
          await new Promise((r) => setTimeout(r, PORT_CLOSED_RETRY_DELAY_MS));
          try {
            result = await attemptSpawnAndResume();
            console.log(`[company s=${id}] Resume retry after port_closed: success.`);
          } catch (err2) {
            const msg2 = err2 instanceof Error ? err2.message : String(err2);
            console.error(`[company s=${id}] Resume retry after port_closed failed:`, msg2);
            deleteCompanyOrchestrator(id);
            return {
              kind: 'reject',
              status: 500,
              body: {
                error:
                  `Resume failed after retry: ${msg2}. The worker thread crashed twice — ` +
                  'check the previous logs for the original cause (OOM, uncaught exception, etc.) ' +
                  'before retrying.',
              },
            };
          }
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[company s=${id}] Resume failed:`, msg);
          // Do NOT evict the worker here. Post-decoupling the slow sandbox
          // provision + runCoder boot run in the background (off this RPC),
          // so a synchronous throw here is a fast-path/spawn error — killing
          // a worker that may be mid-provision (its build streams over SSE)
          // would just force a wasteful cold rebuild on retry. `port_closed`
          // (handled above) is the only case where the worker is already
          // dead and an evict + retry is warranted.
          return { kind: 'reject', status: 500, body: { error: `Resume failed: ${msg}` } };
        }
      }

      return { kind: 'fresh', orchestrator: result.orchestrator, bus: result.bus };
    });

    if (decision.kind === 'reject') {
      return c.json(decision.body, decision.status);
    }
    if (decision.kind === 'attach') {
      return pumpBusToSSE(c, decision.bus, {
        since: decision.since,
      });
    }
    return pumpBusToSSE(c, decision.bus, {
      since: -1,
      // Worker pool handles eviction via TTL sweep.
      onDone: () => undefined,
    });
  });

  /**
   * Abort the entire company session — stops all runners.
   */
  app.post('/api/company/sessions/:id/abort', (c) => {
    const id = parseIdParam(c);
    const orchestrator = getCompanyOrchestrator(id);
    if (!orchestrator) return c.json({ error: 'No active orchestrator' }, 404);
    orchestrator.abortAll();
    deleteCompanyOrchestrator(id);
    return c.json({ ok: true });
  });

  /**
   * Switch the master agent's provider/model and optionally update
   * subordinate role defaults. Works both while running (live swap)
   * and while idle (changes take effect on next start/resume).
   */
  app.post('/api/company/sessions/:id/switch', async (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);

    const body = await parseJsonBody<{
      provider: string;
      model?: string;
      role_assignments?: Array<{ role: string; provider: string; model: string; tier: string; skills?: string[] }>;
    }>(c);

    if (!body.provider) return c.json({ error: 'provider required' }, 400);

    // Update config_json in DB
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(session.config_json); } catch { /* defaults */ }
    config.master_provider = body.provider;
    if (body.model) config.master_model = body.model;
    if (body.role_assignments) config.role_assignments = body.role_assignments;
    companyStore.updateCompanySessionConfig(id, JSON.stringify(config));

    let resolvedProvider = body.provider;
    let resolvedModel = body.model ?? '';

    // Live swap if orchestrator is active
    const orchestrator = getCompanyOrchestrator(id);
    if (orchestrator) {
      try {
        const result = await orchestrator.swapMasterProvider(body.provider, body.model);
        resolvedProvider = result.provider;
        resolvedModel = result.model;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: `Provider swap failed: ${msg}` }, 500);
      }
      if (body.role_assignments) {
        orchestrator.updateRoleConfigs(body.role_assignments);
      }
    }

    // Update the master's agent_run record
    const agentRuns = companyStore.listAgentRuns(id);
    const masterRun = agentRuns.filter((r) => r.role === 'master').pop();
    if (masterRun) {
      companyStore.updateAgentRunProvider(masterRun.id, resolvedProvider, resolvedModel);
    }

    return c.json({ ok: true, provider: resolvedProvider, model: resolvedModel });
  });

  /**
   * Human responds to the Master's submit_plan.
   * This unblocks the Master's waitForUserInput() call.
   */
  app.post('/api/company/sessions/:id/plan-response', async (c) => {
    const id = parseIdParam(c);
    const orchestrator = getCompanyOrchestrator(id);
    if (!orchestrator) return c.json({ error: 'No active orchestrator' }, 404);

    const body = await parseJsonBody<PlanResponseBody>(c);
    if (body.approved === undefined) {
      return c.json({ error: 'approved field required' }, 400);
    }

    const resolved = orchestrator.respondToMasterPlan(body.approved, body.feedback, body.prompt_id);
    if (!resolved) {
      return c.json(
        { error: 'No pending master plan to respond to (already resolved or session ended)' },
        409,
      );
    }

    return c.json({ ok: true, prompt: resolved });
  });

  /**
   * Send a follow-up message to the Master agent.
   * If master is alive → pushUserMessage. If dead → resumeMasterWithMessage.
   * Message is also posted to the board as "human" for visibility.
   *
   * When the master is blocked inside an interactive tool (waiting for a
   * plan/question/tasks response or for subordinates), the default reply
   * is 409 INTERACTION_PENDING so the human is steered to the canonical
   * `/plan-response` / `/answer` route. Pass `{ "interject": true }` to
   * break the wait and inject the message anyway — useful when the human
   * wants to redirect the conversation mid-loop.
   */
  app.post('/api/company/sessions/:id/message', async (c) => {
    const id = parseIdParam(c);
    const orchestrator = getCompanyOrchestrator(id);
    if (!orchestrator) return c.json({ error: 'No active orchestrator' }, 404);

    if (orchestrator.metaBus.ended) {
      return c.json({ error: 'Session has ended. Please start a new session.' }, 410);
    }

    const body = await parseJsonBody<{ message: string; interject?: boolean; attachments?: AttachmentBody[]; thinking?: boolean }>(c);
    if (!body.message) {
      return c.json({ error: 'message required' }, 400);
    }
    const attachmentsCheck = validateAttachments(body.attachments);
    if (!attachmentsCheck.ok) {
      return c.json({ error: attachmentsCheck.error }, 400);
    }

    const result = orchestrator.sendMessageToMaster(body.message, {
      interject: body.interject,
      attachments: attachmentsCheck.value,
      thinking: body.thinking,
    });
    if (!result.ok && result.pending === 'interactive_wait') {
      return c.json(
        {
          error: 'master is waiting for an interactive answer — use /plan-response or /answer, or pass {"interject": true} to override',
          code: 'INTERACTION_PENDING',
        },
        409,
      );
    }
    return c.json({ ok: true });
  });

  /**
   * Human answers a Master agent's ask_user question.
   * This unblocks the Master's waitForUserInput() call.
   */
  app.post('/api/company/sessions/:id/answer', async (c) => {
    const id = parseIdParam(c);
    const orchestrator = getCompanyOrchestrator(id);
    if (!orchestrator) return c.json({ error: 'No active orchestrator' }, 404);

    const body = await parseJsonBody<{ answer: string; prompt_id?: number }>(c);
    if (!body.answer) {
      return c.json({ error: 'answer required' }, 400);
    }

    const resolved = orchestrator.respondToMasterQuestion(body.answer, body.prompt_id);
    if (!resolved) {
      return c.json(
        { error: 'No pending question to answer (already resolved or session ended)' },
        409,
      );
    }

    return c.json({ ok: true, prompt: resolved });
  });

  /**
   * Check if there's an active orchestrator for a company session.
   */
  app.get('/api/company/sessions/:id/status', (c) => {
    const id = parseIdParam(c);
    return c.json({
      active: hasCompanyOrchestrator(id),
      company_session_id: id,
    });
  });
}
