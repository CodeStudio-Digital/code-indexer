import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ServerDeps } from '../../deps.js';
import type { CompanyOrchestrator } from '@mcp/company/orchestrator.js';
import type { MasterPrompt } from '@mcp/company-contracts';
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
import { RecentMessageKeys, normalizeDedupeKey, syntheticDoneSSE } from '../recent-message-keys.js';
import {
  getRuntimeEventLog,
  runtimeEventsToJsonl,
  summarizeRuntimeEvents,
} from '../../../sse/runtime-event-log.js';
import { resolveAndRunMaster } from './master-resolve.js';
import { ensureCompanyMasterLive } from './ensure-master-live.js';
import {
  appOwnedControlPlaneConflict,
  isAppOwnedCompanySession,
  routeAllowsCompanySurface,
} from './runtime-capabilities.js';
import { resolveEffectiveMasterRuntime } from '@mcp/company/services/subordinate/role-runtime.js';
import { abortCompanyRuntime } from './runtime-lifecycle.js';
import {
  binaryDocumentsHandledNatively,
  normalizeAttachmentsForModel,
  pdfHandledNatively,
} from '@mcp/services/services/docs/attachment-extract.js';
import { validateAttachments } from '@mcp/services/services/docs/attachment-validation.js';
import { modelSupportsVision } from '@mcp/code-agent/providers/capabilities.js';
import { DEFAULT_ATTACHMENT_PROMPT, MAX_ATTACHMENT_REQUEST_BYTES } from '@mcp/shared';
import { getDefinition } from '@mcp/services/providers/registry.js';

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
  /**
   * Client-generated idempotency key. Stable across `ReconnectingSSEClient`
   * retries, so a retry re-POST is deduped into a metaBus replay instead of
   * hitting the "Already running" 409 (or re-sending to the master on /resume).
   */
  client_msg_id?: string;
}

const attachmentBodyLimit = bodyLimit({
  maxSize: MAX_ATTACHMENT_REQUEST_BYTES,
  onError: (c) => c.json(
    { error: 'request body is too large', code: 'ATTACHMENT_REQUEST_TOO_LARGE' },
    413,
  ),
});

interface PlanResponseBody {
  approved: boolean;
  feedback?: string;
  /** Optional id of the master_prompt being resolved (idempotent across replay). */
  prompt_id?: number;
}

export function mountCompanyStreamRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore, db, providerStore } = deps;
  // Idempotency store for the streaming POSTs (/start, /resume). Per-mount so
  // route tests get a fresh, isolated instance. See recent-message-keys.ts.
  const recentMessageKeys = new RecentMessageKeys<CompanyOrchestrator['metaBus']>();

  // Attachment-extraction options derived from the MASTER's model (the company
  // UI has no per-message toggles): extract embedded images only when the
  // master can see images, and extract PDF text (dropping base64) unless the
  // master's adapter reads PDF natively. Defaults to the vision-capable,
  // PDF-native Anthropic master when the config is missing/unparseable.
  // General file transports also keep Office/OpenDocument bytes native. The
  // model is resolved through the same authoritative contract as launch, so
  // an incomplete App Master cannot gain a legacy attachment-time fallback.
  function masterAttachmentOpts(id: number): {
    extractImages: boolean;
    extractPdfText: boolean;
    keepBinaryDocuments: boolean;
  } {
    const cur = companyStore.getCompanySession(id);
    const runtime = resolveEffectiveMasterRuntime({
      configJson: cur?.config_json,
      runtimeKind: cur?.runtime_kind === 'app_studio' ? 'app_studio' : 'company',
    });
    const providerName = runtime.provider;
    const modelId = runtime.model;
    const providerKind = providerStore.getProvider(providerName)?.kind ?? providerName;
    const modelRow = providerStore.getProvider(providerName)
      ? providerStore.listModels(providerName).find((m) => m.model_id === modelId)
      : undefined;
    const fileHandling = {
      mode: getDefinition(providerKind)?.capabilities?.fileInput,
      modelId,
      supportsAttachments: modelRow?.supports_attachments,
    };
    return {
      extractImages: modelSupportsVision({ providerKind, modelId }) === true,
      extractPdfText: !pdfHandledNatively(fileHandling),
      keepBinaryDocuments: binaryDocumentsHandledNatively(fileHandling),
    };
  }

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
  app.post('/api/company/sessions/:id/start', attachmentBodyLimit, async (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);

    const body = await parseJsonBody<StartBody>(c);
    const attachmentsCheck = validateAttachments(body.attachments);
    if (!attachmentsCheck.ok) {
      return c.json({ error: attachmentsCheck.error, code: attachmentsCheck.code }, attachmentsCheck.status);
    }
    // Capture into a local const so TS narrowing survives the async closure below.
    const userMessage = body.user_message?.trim()
      ? body.user_message
      : (attachmentsCheck.value?.length ? DEFAULT_ATTACHMENT_PROMPT : '');
    if (!userMessage) return c.json({ error: 'user_message required' }, 400);
    const maxTurnsRequested = body.max_turns;
    const dedupeKey = normalizeDedupeKey(body.client_msg_id);
    let attachmentOpts: ReturnType<typeof masterAttachmentOpts>;
    try {
      attachmentOpts = masterAttachmentOpts(id);
    } catch (error) {
      return c.json({
        error: error instanceof Error ? error.message : String(error),
        code: 'MASTER_RUNTIME_INVALID',
      }, 409);
    }
    const attachments = await normalizeAttachmentsForModel(
      attachmentsCheck.value,
      attachmentOpts,
    );

    // Serialize the "is there already a master for this id?" decision so two
    // concurrent POSTs cannot both pass the status check.
    const decision = await withSessionLock(id, async (): Promise<
      | {
          kind: 'success';
          orchestrator: CompanyOrchestrator;
          bus: CompanyOrchestrator['metaBus'];
        }
      | { kind: 'reject'; status: 404 | 409 | 500; body: { error: string } }
      | { kind: 'replay'; bus: CompanyOrchestrator['metaBus']; since: number }
      | { kind: 'gone' }
    > => {
      // Idempotency: a `ReconnectingSSEClient` retry re-POSTs /start. Replay
      // the master's metaBus instead of returning the "Already running" 409
      // that the guard below would otherwise produce.
      if (dedupeKey) {
        const hit = recentMessageKeys.lookup(id, dedupeKey);
        if (hit) {
          return hit.bus && (hit.bus.ended || hit.bus === getCompanyOrchestrator(id)?.metaBus)
            ? { kind: 'replay', bus: hit.bus, since: Math.max(parseLastEventId(c), hit.sinceHint) }
            : { kind: 'gone' };
        }
      }
      const cur = companyStore.getCompanySession(id);
      if (!cur) return { kind: 'reject', status: 404, body: { error: 'Not found' } };
      if (cur.status === 'running' || hasCompanyOrchestrator(id)) {
        return { kind: 'reject', status: 409, body: { error: 'Already running' } };
      }

      // Parse config from DB — this is the source of truth for roles
      let config: {
        role_assignments?: Array<{ role: string; provider: string; model: string; tier: string; skills?: string[]; projectIds?: number[]; projectHints?: string[]; systemPromptOverride?: string }>;
      } = {};
      try { config = JSON.parse(cur.config_json); } catch { /* use defaults */ }

      let masterRuntime;
      try {
        masterRuntime = resolveEffectiveMasterRuntime({
          configJson: cur.config_json,
          runtimeKind: cur.runtime_kind === 'app_studio' ? 'app_studio' : 'company',
        });
      } catch (error) {
        return {
          kind: 'reject',
          status: 409,
          body: { error: error instanceof Error ? error.message : String(error) },
        };
      }

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
      if (routeAllowsCompanySurface(companyStore, id, 'pipelines')) {
        void orchestrator.pipelineRecoverRunning().catch((err) => {
          console.warn(`[company s=${id}] pipeline recovery failed:`, err);
        });
      }

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
          provider: masterRuntime.provider,
          model: masterRuntime.model,
          maxTurns: maxTurnsRequested ?? 100,
          roleConfigs,
          attachments,
          thinking: body.thinking ?? masterRuntime.thinking,
          thinkingBudgetTokens: masterRuntime.thinkingBudgetTokens,
          temperature: masterRuntime.temperature,
          reasoningEffort: masterRuntime.reasoningEffort,
          fallbackModels: masterRuntime.fallbackModels,
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
      if (dedupeKey) recentMessageKeys.record(id, dedupeKey, busForPump, -1);
      return { kind: 'success', orchestrator, bus: busForPump };
    });

    if (decision.kind === 'reject') {
      return c.json(decision.body, decision.status);
    }
    if (decision.kind === 'replay') {
      return pumpBusToSSE(c, decision.bus, { since: decision.since });
    }
    if (decision.kind === 'gone') {
      return syntheticDoneSSE(c, { reason: 'completed', duplicate: true });
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
  app.post('/api/company/sessions/:id/resume', attachmentBodyLimit, async (c) => {
    const id = parseIdParam(c);
    const body = await parseJsonBody<{ message: string; attachments?: AttachmentBody[]; thinking?: boolean; client_msg_id?: string }>(c);
    const attachmentsCheck = validateAttachments(body.attachments);
    if (!attachmentsCheck.ok) {
      return c.json({ error: attachmentsCheck.error, code: attachmentsCheck.code }, attachmentsCheck.status);
    }
    const dedupeKey = normalizeDedupeKey(body.client_msg_id);
    let attachmentOpts: ReturnType<typeof masterAttachmentOpts>;
    try {
      attachmentOpts = masterAttachmentOpts(id);
    } catch (error) {
      return c.json({
        error: error instanceof Error ? error.message : String(error),
        code: 'MASTER_RUNTIME_INVALID',
      }, 409);
    }
    const attachments = await normalizeAttachmentsForModel(
      attachmentsCheck.value,
      attachmentOpts,
    );
    const message = body.message?.trim()
      ? body.message
      : (attachments?.length ? DEFAULT_ATTACHMENT_PROMPT : '');

    // Serialize the "is there an existing orchestrator?" decision so two
    // concurrent /resume calls can't both observe registry-empty and each
    // create a fresh CompanyOrchestrator + start its own runCoder loop.
    const decision = await withSessionLock(id, async (): Promise<
      | { kind: 'attach'; orchestrator: CompanyOrchestrator; since: number; bus: CompanyOrchestrator['metaBus'] }
      | { kind: 'fresh'; orchestrator: CompanyOrchestrator; bus: CompanyOrchestrator['metaBus'] }
      | { kind: 'reject'; status: 400 | 404 | 409 | 500; body: { error: string } }
      | { kind: 'replay'; bus: CompanyOrchestrator['metaBus']; since: number }
      | { kind: 'gone' }
    > => {
      // Idempotency: a retry re-POSTs /resume. Replay the metaBus instead of
      // calling `sendMessageToMaster` again (duplicate message to the master)
      // or cold-starting a second orchestrator. MUST run before the attach
      // branch's send below.
      if (dedupeKey) {
        const hit = recentMessageKeys.lookup(id, dedupeKey);
        if (hit) {
          return hit.bus && (hit.bus.ended || hit.bus === getCompanyOrchestrator(id)?.metaBus)
            ? { kind: 'replay', bus: hit.bus, since: Math.max(parseLastEventId(c), hit.sinceHint) }
            : { kind: 'gone' };
        }
      }
      const existing = getCompanyOrchestrator(id);
      if (existing) {
        if (message) existing.sendMessageToMaster(message, { attachments, thinking: body.thinking });
        if (dedupeKey) recentMessageKeys.record(id, dedupeKey, existing.metaBus, parseLastEventId(c));
        return { kind: 'attach', orchestrator: existing, since: parseLastEventId(c), bus: existing.metaBus };
      }

      const session = companyStore.getCompanySession(id);
      if (!session) return { kind: 'reject', status: 404, body: { error: 'Not found' } };
      if (!message) return { kind: 'reject', status: 400, body: { error: 'message required' } };
      const userMessage = message;

      // Sub-sessions (migration 067): a brand-new tab has no master_run
      // yet, so we cold-start instead of trying to resume.
      const agentRuns = companyStore.listAgentRuns(id);
      const masterRun = agentRuns.filter((r) => r.role === 'master').pop();

      // Parse role configs from session config
      let config: {
        role_assignments?: Array<{ role: string; provider: string; model: string; tier: string; skills?: string[]; projectIds?: number[]; projectHints?: string[]; systemPromptOverride?: string }>;
      } = {};
      try { config = JSON.parse(session.config_json); } catch { /* defaults */ }
      const roleConfigs = config.role_assignments ?? [];
      let masterRuntime;
      try {
        masterRuntime = resolveEffectiveMasterRuntime({
          configJson: session.config_json,
          runtimeKind: session.runtime_kind === 'app_studio' ? 'app_studio' : 'company',
        });
      } catch (error) {
        return {
          kind: 'reject',
          status: 409,
          body: { error: error instanceof Error ? error.message : String(error) },
        };
      }

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
        if (routeAllowsCompanySurface(companyStore, id, 'pipelines')) {
          void orchestrator.pipelineRecoverRunning().catch((err) => {
            console.warn(`[company s=${id}] pipeline recovery failed:`, err);
          });
        }
        // Resume-or-start (shared with /start). `masterRun` present → resume
        // and reuse its coder-session; absent (brand-new sub-session) → cold
        // start. Never spawns a duplicate master for a session that has one.
        await resolveAndRunMaster(orchestrator, !!masterRun, {
          userMessage,
          provider: masterRuntime.provider,
          model: masterRuntime.model,
          maxTurns: 100,
          roleConfigs,
          attachments,
          thinking: body.thinking ?? masterRuntime.thinking,
          thinkingBudgetTokens: masterRuntime.thinkingBudgetTokens,
          temperature: masterRuntime.temperature,
          reasoningEffort: masterRuntime.reasoningEffort,
          fallbackModels: masterRuntime.fallbackModels,
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

      if (dedupeKey) recentMessageKeys.record(id, dedupeKey, result.bus, -1);
      return { kind: 'fresh', orchestrator: result.orchestrator, bus: result.bus };
    });

    if (decision.kind === 'reject') {
      return c.json(decision.body, decision.status);
    }
    if (decision.kind === 'replay') {
      return pumpBusToSSE(c, decision.bus, { since: decision.since });
    }
    if (decision.kind === 'gone') {
      return syntheticDoneSSE(c, { reason: 'completed', duplicate: true });
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
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    if (isAppOwnedCompanySession(companyStore, id)) {
      return appOwnedControlPlaneConflict(c, 'session abort');
    }
    const result = abortCompanyRuntime(id);
    if (!result.ok) return c.json({ error: 'No active orchestrator' }, 404);
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
    if (isAppOwnedCompanySession(companyStore, id)) {
      return appOwnedControlPlaneConflict(c, 'runtime/model configuration');
    }

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
    const body = await parseJsonBody<PlanResponseBody>(c);
    if (body.approved === undefined) {
      return c.json({ error: 'approved field required' }, 400);
    }

    // Live path.
    const orchestrator = getCompanyOrchestrator(id);
    if (orchestrator) {
      const resolved = orchestrator.respondToMasterPlan(body.approved, body.feedback, body.prompt_id);
      if (!resolved) {
        return c.json(
          { error: 'No pending master plan to respond to (already resolved or session ended)' },
          409,
        );
      }
      return c.json({ ok: true, prompt: resolved });
    }

    // Dead orchestrator: resolve the plan prompt + re-spawn + resume, delivering
    // the verdict as a continuation (dangling submit_plan auto-sealed on resume).
    let resolvedPlan: MasterPrompt | null = null;
    try {
      const pid = body.prompt_id ?? companyStore.getPendingMasterPrompt(id, 'plan')?.id;
      if (pid != null) {
        resolvedPlan = companyStore.resolveMasterPrompt(pid, { kind: 'plan', approved: body.approved, feedback: body.feedback });
      }
    } catch { /* best-effort bookkeeping */ }
    // IDEMPOTENCY — see /answer: only the call that actually resolves the pending
    // plan proceeds; a duplicate/racing submit no-ops instead of double-posting.
    if (!resolvedPlan) {
      return c.json({ ok: true, duplicate: true });
    }
    const verdict = body.approved
      ? `[plano APROVADO]${body.feedback ? ` ${body.feedback}` : ''}`
      : `[plano REJEITADO]${body.feedback ? ` ${body.feedback}` : ''}`;
    const res = await ensureCompanyMasterLive(id, deps, { message: verdict });
    if ('error' in res) return c.json({ error: res.error }, res.status);
    try { await res.orchestrator.postToBoard('human', null, 'decision', `Plan ${body.approved ? 'APPROVED' : 'REJECTED'}${body.feedback ? `: ${body.feedback}` : ''}`); }
    catch { /* best-effort */ }
    return c.json({ ok: true, resumed: true, prompt: resolvedPlan });
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
  app.post('/api/company/sessions/:id/message', attachmentBodyLimit, async (c) => {
    const id = parseIdParam(c);
    const body = await parseJsonBody<{ message: string; interject?: boolean; attachments?: AttachmentBody[]; thinking?: boolean }>(c);
    const attachmentsCheck = validateAttachments(body.attachments);
    if (!attachmentsCheck.ok) {
      return c.json({ error: attachmentsCheck.error, code: attachmentsCheck.code }, attachmentsCheck.status);
    }
    const attachments = await normalizeAttachmentsForModel(attachmentsCheck.value, masterAttachmentOpts(id));
    const message = body.message?.trim()
      ? body.message
      : (attachments?.length ? DEFAULT_ATTACHMENT_PROMPT : '');
    if (!message) return c.json({ error: 'message required' }, 400);

    // Live path.
    const orchestrator = getCompanyOrchestrator(id);
    if (orchestrator) {
      if (orchestrator.metaBus.ended) {
        return c.json({ error: 'Session has ended. Please start a new session.' }, 410);
      }
      const result = orchestrator.sendMessageToMaster(message, {
        interject: body.interject,
        attachments,
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
    }

    // Dead orchestrator: re-spawn + resume the master with this message instead
    // of 404ing (idle eviction / process restart should be invisible).
    const res = await ensureCompanyMasterLive(id, deps, {
      message,
      attachments,
      thinking: body.thinking,
    });
    if ('error' in res) return c.json({ error: res.error }, res.status);
    return c.json({ ok: true, resumed: true });
  });

  /**
   * Human answers a Master agent's ask_user question.
   * This unblocks the Master's waitForUserInput() call.
   */
  app.post('/api/company/sessions/:id/answer', async (c) => {
    const id = parseIdParam(c);
    const body = await parseJsonBody<{ answer: string; prompt_id?: number }>(c);
    if (!body.answer) {
      return c.json({ error: 'answer required' }, 400);
    }

    // Live path — master runner is in the pool: deliver to its waitForUserInput.
    const orchestrator = getCompanyOrchestrator(id);
    if (orchestrator) {
      const resolved = orchestrator.respondToMasterQuestion(body.answer, body.prompt_id);
      if (!resolved) {
        return c.json(
          { error: 'No pending question to answer (already resolved or session ended)' },
          409,
        );
      }
      return c.json({ ok: true, prompt: resolved });
    }

    // Dead orchestrator (idle-evicted OR process/dev restart): re-spawn + resume
    // the master and deliver the answer as a continuation. The dangling ask_user
    // tool_use is auto-sealed on resume (runner.ts "Safety net 2"). Resolve the
    // master prompt (so the question card flips to answered) and RETURN it so the
    // dashboard applies it — exactly like the live path does.
    let resolvedPrompt: MasterPrompt | null = null;
    try {
      const pid = body.prompt_id ?? companyStore.getPendingMasterPrompt(id, 'question')?.id;
      if (pid != null) resolvedPrompt = companyStore.resolveMasterPrompt(pid, { kind: 'question', answer: body.answer });
    } catch { /* best-effort bookkeeping */ }
    // IDEMPOTENCY: only the call that ACTUALLY resolves a pending prompt proceeds
    // to spawn the resume + post to the board. A duplicate/racing submit (the
    // triple-click bug) finds the prompt already resolved — `resolveMasterPrompt`
    // returns null — so we no-op instead of spawning a 2nd master and posting a
    // 3rd "Human answered" board entry.
    if (!resolvedPrompt) {
      return c.json({ ok: true, duplicate: true });
    }
    const res = await ensureCompanyMasterLive(id, deps, {
      message: `[resposta à pergunta do Master] ${body.answer}`,
    });
    if ('error' in res) return c.json({ error: res.error }, res.status);
    // Mirror the live path: record the human's answer on the PERSISTENT board so
    // it survives close/open (board_entries in SQLite).
    try { await res.orchestrator.postToBoard('human', null, 'decision', `Human answered: ${body.answer}`); }
    catch { /* best-effort */ }
    return c.json({ ok: true, resumed: true, prompt: resolvedPrompt });
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
