import { persistBoardAttachments } from '@mcp/company/services/board-attachments.js';
import { randomUUID } from 'node:crypto';
import type { HttpRouter } from '@mcp/shared/http/router.js';
import { sessionRecoveryFailure } from '../../../control-plane-recovery-error.js';
import { bodyLimit } from '@mcp/shared/http/middleware.js';
import type { ServerDeps } from '../../deps.js';
import type { MasterPrompt } from '@mcp/company-contracts';
import {
  getCompanyOrchestrator,
  hasCompanyOrchestrator,
  deleteCompanyOrchestrator,
  evictCompanyOrchestrator,
  getOrSpawnCompanyOrchestrator,
  type WorkerBackedOrchestrator,
} from '../../../sse/companyOrchestrator.js';
import { pumpBusToSSE, parseLastEventId } from '../../../sse/pumpBusToSSE.js';
import {
  parseCompanySessionIdParam,
  parseSessionRecordIdParam,
  parseJsonBody,
  notFound,
} from '../_helpers.js';
import { withSessionLock } from '../coder/sessionLock.js';
import {
  RecentMessageKeys,
  normalizeDedupeKey,
  syntheticDoneSSE,
  syntheticTerminalSSE,
  type RecentMessageLookup,
} from '../recent-message-keys.js';
import { hashControlPlanePayload } from '@mcp/store/control-plane/index.js';
import { isMutationOutcomeUnknownError } from '@mcp/orchestrator-host';
import {
  getRuntimeEventLog,
  runtimeEventsToJsonl,
  summarizeRuntimeEvents,
} from '../../../sse/runtime-event-log.js';
import { getWorkerOrchestratorPool } from '../../../sse/workerPoolSingleton.js';
import { resolveAndRunMaster } from './master-resolve.js';
import {
  ensureCompanyMasterLive,
  ensureCompanyMasterLiveLocked,
} from './ensure-master-live.js';
import {
  appOwnedControlPlaneConflict,
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
import type { CompanySessionId } from '@mcp/session-storage';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import {
  acceptLocalCompanyCommand,
  bindLocalCommandBus,
  fingerprintLocalCompanyCommand,
  terminalizeLocalCoderCommand,
  type LocalCoderShadowAcceptance,
} from '../../../control-plane-shadow.js';

/**
 * Backwards-compatible accessor used by sibling routes (kanban.ts).
 * Reads delegate to the worker pool via `companyOrchestrator`; writes
 * are not supported — all orchestrators are spawned via `getOrSpawn`.
 */
export const activeOrchestrators = {
  get: (id: CompanySessionId) => getCompanyOrchestrator(id),
  has: (id: CompanySessionId) => hasCompanyOrchestrator(id),
  delete: (id: CompanySessionId) => deleteCompanyOrchestrator(id),
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
  prompt_id?: string;
  /**
   * Explicitly accept a possible duplicate when recovering an acknowledged-
   * unknown delivery. The payload must match the original attempt.
   */
  retry_outcome_unknown?: boolean;
}

type PersistedPromptDeliveryResult =
  | {
      ok: true;
      prompt: MasterPrompt;
      orchestrator: WorkerBackedOrchestrator;
    }
  | {
      ok: false;
      error: string;
      status: 400 | 404 | 409 | 500 | 503;
      code: string;
    };

export function mountCompanyStreamRoutes(app: HttpRouter, deps: ServerDeps): void {
  const { db, providerStore } = deps;
  // Idempotency store for the streaming POSTs (/start, /resume). Per-mount so
  // route tests get a fresh, isolated instance. See recent-message-keys.ts.
  const recentMessageKeys = new RecentMessageKeys<WorkerBackedOrchestrator['metaBus']>();
  const controlPlaneStore = deps.controlPlaneStore ?? null;

  const companyFilesFor = async (
    id: CompanySessionId,
  ): Promise<CompanySessionFiles> => {
    await deps.sessionStore.ensureCatalog();
    return new CompanySessionFiles({
      companySessionId: id,
      sessionStore: deps.sessionStore,
    });
  };

  type CompanyClaim =
    | {
        kind: 'owner';
        acceptance: LocalCoderShadowAcceptance | null;
        guard?: { token: symbol; fingerprintHash: string };
      }
    | { kind: 'pending'; settled: Promise<RecentMessageLookup<WorkerBackedOrchestrator['metaBus']>> }
    | { kind: 'replay'; bus: WorkerBackedOrchestrator['metaBus']; since: number }
    | { kind: 'terminal'; event: 'done' | 'error'; data: Record<string, unknown> }
    | {
        kind: 'reject';
        status: 409 | 503;
        body: { error: string; code: string; retry_after_ms?: number };
        retryAfterMs?: number;
      };

  function companyTerminal(
    acceptance: LocalCoderShadowAcceptance,
  ): { event: 'done' | 'error'; data: Record<string, unknown> } | null {
    if (acceptance.commandStatus === 'succeeded') {
      return { event: 'done', data: { reason: 'completed', duplicate: true, persisted: true } };
    }
    if (
      acceptance.commandStatus === 'failed'
      || acceptance.commandStatus === 'cancelled'
      || acceptance.commandStatus === 'rejected'
    ) {
      const reason = acceptance.commandReasonCode
        ?? `command-${acceptance.commandStatus}`;
      return {
        event: 'error',
        data: {
          reason,
          ...(reason === 'outcome_unknown' ? { code: 'OUTCOME_UNKNOWN' } : {}),
          duplicate: true,
          persisted: true,
        },
      };
    }
    return null;
  }

  async function claimCompanyCommand(input: {
    sessionId: CompanySessionId;
    kind: 'start' | 'resume';
    dedupeKey?: string;
    fingerprint: Record<string, unknown>;
    lastEventId: number;
  }): Promise<CompanyClaim> {
    const fingerprintHash = hashControlPlanePayload(input.fingerprint);
    const memoryClaim = input.dedupeKey
      ? recentMessageKeys.claim(input.sessionId, input.dedupeKey, fingerprintHash)
      : null;
    const guard = memoryClaim?.kind === 'owner'
      ? { token: memoryClaim.token, fingerprintHash }
      : undefined;
    // Refuse admission before durable acceptance when every cache slot is
    // protected by a live owner. Cache pressure must never erase authority.
    if (memoryClaim?.kind === 'capacity_exhausted') {
      return {
        kind: 'reject',
        status: 503,
        body: {
          error: 'idempotency owner capacity exhausted; retry later',
          code: 'IDEMPOTENCY_CAPACITY_EXHAUSTED',
          retry_after_ms: memoryClaim.retryAfterMs,
        },
        retryAfterMs: memoryClaim.retryAfterMs,
      };
    }
    // Same-process duplicate fingerprints are already validated by the owner
    // table. Wait before durable acceptance so only the owner can create the
    // command and later bind its executor bus.
    if (memoryClaim?.kind === 'payload_conflict') {
      return {
        kind: 'reject',
        status: 409,
        body: {
          error: 'client_msg_id is already bound to a different payload',
          code: 'IDEMPOTENCY_PAYLOAD_CONFLICT',
        },
      };
    }
    if (memoryClaim?.kind === 'existing') {
      return { kind: 'pending', settled: memoryClaim.settled };
    }
    const settleTerminal = (
      terminal: { event: 'done' | 'error'; data: Record<string, unknown> },
    ): void => {
      if (!input.dedupeKey) return;
      recentMessageKeys.recordTerminal(
        input.sessionId,
        input.dedupeKey,
        terminal,
        -1,
        guard,
      );
    };
    let storageFailure: ReturnType<typeof sessionRecoveryFailure>;
    const acceptance = await acceptLocalCompanyCommand({
      store: controlPlaneStore,
      companySessionId: input.sessionId,
      kind: input.kind,
      idempotencyKey: input.dedupeKey,
      fingerprint: input.fingerprint,
      onUnavailable: (error) => { storageFailure = sessionRecoveryFailure(error); },
    });

    if (
      acceptance?.outcome === 'payload_conflict'
    ) {
      if (input.dedupeKey && memoryClaim?.kind === 'owner') {
        recentMessageKeys.rejectClaim(
          input.sessionId,
          input.dedupeKey,
          memoryClaim.token,
          fingerprintHash,
          { event: 'error', data: { reason: 'payload_conflict', duplicate: true } },
        );
      }
      return {
        kind: 'reject',
        status: 409,
        body: {
          error: 'client_msg_id is already bound to a different payload',
          code: 'IDEMPOTENCY_PAYLOAD_CONFLICT',
        },
      };
    }
    if (!acceptance) {
      if (input.dedupeKey && guard) {
        recentMessageKeys.rejectClaim(input.sessionId, input.dedupeKey, guard.token, guard.fingerprintHash, {
          event: 'error',
          data: { reason: storageFailure?.code ?? 'idempotency-authority-unavailable', duplicate: false, retryable: true },
        });
      }
      return {
        kind: 'reject',
        status: 503,
        body: storageFailure ?? {
          error: 'idempotency authority unavailable; request was not executed',
          code: 'IDEMPOTENCY_AUTHORITY_UNAVAILABLE',
        },
      };
    }
    if (acceptance.outcome === 'version_conflict') {
      settleTerminal({
        event: 'error',
        data: { reason: 'version_conflict', duplicate: true },
      });
      return {
        kind: 'reject',
        status: 409,
        body: { error: 'session version changed', code: 'COMMAND_VERSION_CONFLICT' },
      };
    }
    if (acceptance.outcome === 'existing') {
      const terminal = companyTerminal(acceptance);
      if (terminal) {
        settleTerminal(terminal);
        return { kind: 'terminal', ...terminal };
      }
      const currentBus = getCompanyOrchestrator(input.sessionId)?.metaBus;
      if (
        currentBus
        && acceptance.executionBusId
        && currentBus.busId === acceptance.executionBusId
      ) {
        if (currentBus.ended) {
          const end = currentBus.endReason ?? {
            event: 'error' as const,
            data: { reason: 'missing-bus-outcome' },
          };
          const data = end.data && typeof end.data === 'object'
            ? end.data as Record<string, unknown>
            : {};
          const reason = typeof data.reason === 'string'
            ? data.reason
            : end.event === 'done' ? 'completed' : 'error';
          await terminalizeLocalCoderCommand(controlPlaneStore, acceptance, {
            status: end.event === 'done' ? 'succeeded' : 'failed',
            reason,
          });
          const replayTerminal = {
            event: end.event,
            data: { reason, duplicate: true, persisted: true },
          };
          settleTerminal(replayTerminal);
          return {
            kind: 'terminal',
            ...replayTerminal,
          };
        }
        const sinceHint = input.lastEventId;
        if (input.dedupeKey) {
          recentMessageKeys.record(input.sessionId, input.dedupeKey, currentBus, sinceHint, guard);
        }
        return {
          kind: 'replay',
          bus: currentBus,
          since: input.lastEventId,
        };
      }
      await terminalizeLocalCoderCommand(controlPlaneStore, acceptance, {
        status: 'failed',
        reason: 'executor-bus-unavailable',
        errorRef: 'error:executor-bus-unavailable',
      });
      const unavailable = {
        event: 'error' as const,
        data: {
          reason: 'executor-bus-unavailable',
          duplicate: true,
          persisted: true,
        },
      };
      settleTerminal(unavailable);
      return {
        kind: 'terminal',
        ...unavailable,
      };
    }
    return { kind: 'owner', acceptance, ...(guard ? { guard } : {}) };
  }

  async function bindCompanyCommandCompletion(
    sessionId: CompanySessionId,
    dedupeKey: string | undefined,
    acceptance: LocalCoderShadowAcceptance | null,
    bus: WorkerBackedOrchestrator['metaBus'],
    guard?: { token: symbol; fingerprintHash: string },
  ): Promise<boolean> {
    if (!acceptance?.commandContext) return true;
    if (!(await bindLocalCommandBus(controlPlaneStore, acceptance, bus.busId))) {
      return false;
    }
    let settled = false;
    const settle = async (): Promise<void> => {
      if (settled || !bus.ended) return;
      if (
        acceptance.commandStatus === 'succeeded'
        || acceptance.commandStatus === 'failed'
        || acceptance.commandStatus === 'cancelled'
        || acceptance.commandStatus === 'rejected'
      ) {
        settled = true;
        return;
      }
      settled = true;
      const end = bus.endReason ?? {
        event: 'error' as const,
        data: { reason: 'missing-bus-outcome' },
      };
      const data = end.data && typeof end.data === 'object'
        ? end.data as Record<string, unknown>
        : {};
      const reason = typeof data.reason === 'string'
        ? data.reason
        : end.event === 'done' ? 'completed' : 'error';
      const cancelled = reason === 'aborted' || reason === 'cancelled';
      await terminalizeLocalCoderCommand(controlPlaneStore, acceptance, {
        status: cancelled ? 'cancelled' : end.event === 'done' ? 'succeeded' : 'failed',
        reason,
      });
      if (dedupeKey) {
        recentMessageKeys.recordTerminal(sessionId, dedupeKey, {
          event: end.event,
          data: { reason, duplicate: true, persisted: true },
        }, -1, guard);
      }
    };
    if (bus.ended) void settle();
    else bus.endListeners.add(() => void settle());
    return true;
  }

  // Attachment-extraction options derived from the MASTER's model (the company
  // UI has no per-message toggles): extract embedded images only when the
  // master can see images, and extract PDF text (dropping base64) unless the
  // master's adapter reads PDF natively. Defaults to the vision-capable,
  // PDF-native Anthropic master when the config is missing/unparseable.
  // General file transports also keep Office/OpenDocument bytes native. The
  // model is resolved through the same authoritative contract as launch, so
  // an incomplete App Master cannot gain a legacy attachment-time fallback.
  async function masterAttachmentOpts(id: CompanySessionId): Promise<{
    extractImages: boolean;
    extractPdfText: boolean;
    keepBinaryDocuments: boolean;
  }> {
    const cur = (await companyFilesFor(id)).getSession();
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

  app.get('/api/company/sessions/:id/master-prompts/:promptId', async (c) => {
    const id = parseCompanySessionIdParam(c);
    const promptId = parseSessionRecordIdParam(c, 'promptId');
    await deps.sessionStore.ensureCatalog();
    const entry = deps.sessionStore.catalog.get(id);
    if (entry?.session.kind !== 'company' && entry?.session.kind !== 'app_studio') return notFound(c);
    const files = new CompanySessionFiles({ companySessionId: id, sessionStore: deps.sessionStore });
    const prompt = await files.getMasterPrompt(promptId);
    c.header('Cache-Control', 'no-store');
    return prompt ? c.json({ prompt }) : notFound(c, 'Question or plan not found in this session');
  });

  app.get('/api/company/sessions/:id/events.jsonl', async (c) => {
    const id = parseCompanySessionIdParam(c);
    const context = await getWorkerOrchestratorPool().resolveRuntimeContext(id);
    const events = await getRuntimeEventLog(
      'company',
      id,
      { bundlePath: context.bundlePath },
    );
    return new Response(runtimeEventsToJsonl(events), {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'content-disposition': `attachment; filename="company-session-${id}-events.jsonl"`,
      },
    });
  });

  app.get('/api/company/sessions/:id/events-summary', async (c) => {
    const id = parseCompanySessionIdParam(c);
    const context = await getWorkerOrchestratorPool().resolveRuntimeContext(id);
    return c.json(summarizeRuntimeEvents(await getRuntimeEventLog(
      'company',
      id,
      { bundlePath: context.bundlePath },
    )));
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
    const id = parseCompanySessionIdParam(c);
    let files: CompanySessionFiles;
    try {
      files = await companyFilesFor(id);
    } catch {
      return notFound(c);
    }
    const session = files.getSession();

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
    const earlyClaim = await withSessionLock(id, async () => claimCompanyCommand({
      sessionId: id,
      kind: 'start',
      dedupeKey,
      fingerprint: fingerprintLocalCompanyCommand({
        message: userMessage,
        attachments: attachmentsCheck.value,
        thinking: body.thinking,
        maxTurns: maxTurnsRequested,
      }),
      lastEventId: parseLastEventId(c),
    }));
    if (earlyClaim.kind === 'pending') {
      const settled = await earlyClaim.settled;
      if (settled.retryLater) {
        c.header(
          'Retry-After',
          String(Math.max(1, Math.ceil(settled.retryLater.retryAfterMs / 1_000))),
        );
        return c.json({
          error: 'the original request is still being admitted; retry later',
          code: 'IDEMPOTENCY_RETRY_LATER',
          retry_after_ms: settled.retryLater.retryAfterMs,
        }, 503);
      }
      if (settled.terminal) {
        return syntheticTerminalSSE(c, settled.terminal.event, settled.terminal.data);
      }
      if (settled.bus) {
        return pumpBusToSSE(c, settled.bus, {
          // Never substitute the first attachment point for the reconnecting
          // client's acknowledged cursor; doing so drops durable replay data.
          since: parseLastEventId(c),
        });
      }
      return syntheticDoneSSE(c, { reason: 'completed', duplicate: true });
    }
    if (earlyClaim.kind === 'replay') {
      return pumpBusToSSE(c, earlyClaim.bus, { since: earlyClaim.since });
    }
    if (earlyClaim.kind === 'terminal') {
      return syntheticTerminalSSE(c, earlyClaim.event, earlyClaim.data);
    }
    if (earlyClaim.kind === 'reject') {
      if (earlyClaim.retryAfterMs !== undefined) {
        c.header(
          'Retry-After',
          String(Math.max(1, Math.ceil(earlyClaim.retryAfterMs / 1_000))),
        );
      }
      return c.json(earlyClaim.body, earlyClaim.status);
    }
    const commandAcceptance = earlyClaim.acceptance;
    const claimGuard = earlyClaim.guard;
    let commandSettled = false;
    const settleCommandFailure = async (
      reason: string,
      code?: string,
      error?: string,
    ): Promise<void> => {
      if (commandSettled) return;
      commandSettled = true;
      await terminalizeLocalCoderCommand(controlPlaneStore, commandAcceptance, {
        status: 'failed',
        reason,
      });
      if (dedupeKey) {
        recentMessageKeys.recordTerminal(id, dedupeKey, {
          event: 'error',
          data: { reason, ...(code ? { code } : {}), ...(error ? { error } : {}), duplicate: false },
        }, -1, claimGuard);
      }
    };
    try {
    let attachmentOpts: Awaited<ReturnType<typeof masterAttachmentOpts>>;
    try {
      attachmentOpts = await masterAttachmentOpts(id);
    } catch (error) {
      await settleCommandFailure('master-runtime-invalid', 'MASTER_RUNTIME_INVALID', error instanceof Error ? error.message : String(error));
      return c.json({
        error: error instanceof Error ? error.message : String(error),
        code: 'MASTER_RUNTIME_INVALID',
      }, 409);
    }
    let boardAttachments: import('@mcp/company-contracts').BoardAttachment[] | undefined;
    let attachments: AttachmentBody[] | undefined;
    try {
      attachments = await normalizeAttachmentsForModel(
        attachmentsCheck.value,
        attachmentOpts,
      );
      if (attachmentsCheck.value?.length) boardAttachments = await persistBoardAttachments(await companyFilesFor(id), attachmentsCheck.value);
    } catch (error) {
      await settleCommandFailure('attachment-normalization-failed', undefined, error instanceof Error ? error.message : String(error));
      throw error;
    }

    // Serialize the "is there already a master for this id?" decision so two
    // concurrent POSTs cannot both pass the status check.
    const decision = await withSessionLock(id, async (): Promise<
      | {
          kind: 'success';
          orchestrator: WorkerBackedOrchestrator;
          bus: WorkerBackedOrchestrator['metaBus'];
        }
      | {
          kind: 'reject';
          status: 404 | 409 | 500;
          body: { error: string; code?: string };
        }
      | { kind: 'replay'; bus: WorkerBackedOrchestrator['metaBus']; since: number }
      | { kind: 'gone' }
    > => {
      const cur = files.getSession();
      if (cur.status === 'running' || hasCompanyOrchestrator(id)) {
        return { kind: 'reject', status: 409, body: { error: 'Already running' } };
      }

      // Parse config from the bundle metadata — this is the source of truth for roles.
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
      // Bind the immutable command↔bus correlation before master startup can
      // produce any external effect.
      if (!(await bindCompanyCommandCompletion(
        id,
        dedupeKey,
        commandAcceptance,
        busForPump,
        claimGuard,
      ))) {
        await evictCompanyOrchestrator(id);
        return {
          kind: 'reject',
          status: 500,
          body: { error: 'Failed to bind the command to its company stream' },
        };
      }
      if (dedupeKey) {
        recentMessageKeys.record(id, dedupeKey, busForPump, -1, claimGuard);
      }

      // Await master spin-up — if it fails, return JSON error (not a broken SSE
      // stream). Resume-or-start: if this session ALREADY has a master run,
      // RESUME it (reuse coder-session + context) instead of spawning a
      // duplicate master. The 409 guard above already handled "currently
      // running"; here the session is stopped (error/idle/paused/completed).
      try {
        const masterExists = files
          .listAgentRunsSync()
          .some((r) => r.role === 'master');
        await resolveAndRunMaster(orchestrator, masterExists, {
          userMessage,
          provider: masterRuntime.provider,
          model: masterRuntime.model,
          maxTurns: maxTurnsRequested ?? 100,
          roleConfigs,
          attachments,
          boardAttachments,
          thinking: body.thinking ?? masterRuntime.thinking,
          thinkingBudgetTokens: masterRuntime.thinkingBudgetTokens,
          temperature: masterRuntime.temperature,
          reasoningEffort: masterRuntime.reasoningEffort,
          fallbackModels: masterRuntime.fallbackModels,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[company s=${id}] Master start failed:`, msg);
        const outcomeUnknown = isMutationOutcomeUnknownError(err);
        // Evict the worker so the next /start gets a fresh one rather
        // than a half-initialized instance.
        await evictCompanyOrchestrator(id);
        // A closed port may have lost only the acknowledgement; do not assert
        // that a possibly-started session failed.
        if (!outcomeUnknown) await files.updateSessionStatus('error');
        return {
          kind: 'reject',
          status: 500,
          body: outcomeUnknown
            ? {
                error:
                  `Master start outcome is unknown: ${msg}. ` +
                  'The mutating RPC was not replayed.',
                code: 'OUTCOME_UNKNOWN',
              }
            : { error: `Master start failed: ${msg}` },
        };
      }

      // Persist the user message so it survives page reload
      return { kind: 'success', orchestrator, bus: busForPump };
    });

    if (decision.kind === 'reject') {
      const outcomeUnknown = decision.body.code === 'OUTCOME_UNKNOWN';
      await settleCommandFailure(
        outcomeUnknown
          ? 'outcome_unknown'
          : decision.status === 409 ? 'company-command-conflict' : 'company-start-failed',
        decision.body.code,
        decision.body.error,
      );
      return c.json(decision.body, decision.status);
    }
    if (decision.kind === 'replay') {
      return pumpBusToSSE(c, decision.bus, { since: decision.since });
    }
    if (decision.kind === 'gone') {
      return syntheticDoneSSE(c, { reason: 'completed', duplicate: true });
    }
    const response = pumpBusToSSE(c, decision.bus, {
      since: -1,
      // Worker pool handles eviction via its own TTL sweep — no
      // explicit scheduling needed here.
      onDone: () => undefined,
    });
    commandSettled = true;
    return response;
    } catch (error) {
      await settleCommandFailure('company-start-setup-failed', undefined, error instanceof Error ? error.message : String(error));
      throw error;
    }
  });

  /**
   * Reattach to an in-flight company session's SSE stream.
   * Uses Last-Event-ID header for replay from the client's last seen seq.
  */
  app.get('/api/company/sessions/:id/attach', (c) => {
    const id = parseCompanySessionIdParam(c);
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
    const id = parseCompanySessionIdParam(c);
    const body = await parseJsonBody<{ message: string; attachments?: AttachmentBody[]; thinking?: boolean; client_msg_id?: string }>(c);
    const attachmentsCheck = validateAttachments(body.attachments);
    if (!attachmentsCheck.ok) {
      return c.json({ error: attachmentsCheck.error, code: attachmentsCheck.code }, attachmentsCheck.status);
    }
    let files: CompanySessionFiles;
    try {
      files = await companyFilesFor(id);
    } catch {
      return notFound(c);
    }
    const session = files.getSession();
    const dedupeKey = normalizeDedupeKey(body.client_msg_id);
    const message = body.message?.trim()
      ? body.message
      : (attachmentsCheck.value?.length ? DEFAULT_ATTACHMENT_PROMPT : '');
    if (!message) return c.json({ error: 'message required' }, 400);
    const earlyClaim = await withSessionLock(id, async () => claimCompanyCommand({
      sessionId: id,
      kind: 'resume',
      dedupeKey,
      fingerprint: fingerprintLocalCompanyCommand({
        message,
        attachments: attachmentsCheck.value,
        thinking: body.thinking,
      }),
      lastEventId: parseLastEventId(c),
    }));
    if (earlyClaim.kind === 'pending') {
      const settled = await earlyClaim.settled;
      if (settled.retryLater) {
        c.header(
          'Retry-After',
          String(Math.max(1, Math.ceil(settled.retryLater.retryAfterMs / 1_000))),
        );
        return c.json({
          error: 'the original request is still being admitted; retry later',
          code: 'IDEMPOTENCY_RETRY_LATER',
          retry_after_ms: settled.retryLater.retryAfterMs,
        }, 503);
      }
      if (settled.terminal) {
        return syntheticTerminalSSE(c, settled.terminal.event, settled.terminal.data);
      }
      if (settled.bus) {
        return pumpBusToSSE(c, settled.bus, {
          since: parseLastEventId(c),
        });
      }
      return syntheticDoneSSE(c, { reason: 'completed', duplicate: true });
    }
    if (earlyClaim.kind === 'replay') {
      return pumpBusToSSE(c, earlyClaim.bus, { since: earlyClaim.since });
    }
    if (earlyClaim.kind === 'terminal') {
      return syntheticTerminalSSE(c, earlyClaim.event, earlyClaim.data);
    }
    if (earlyClaim.kind === 'reject') {
      if (earlyClaim.retryAfterMs !== undefined) {
        c.header(
          'Retry-After',
          String(Math.max(1, Math.ceil(earlyClaim.retryAfterMs / 1_000))),
        );
      }
      return c.json(earlyClaim.body, earlyClaim.status);
    }
    const commandAcceptance = earlyClaim.acceptance;
    const claimGuard = earlyClaim.guard;
    let commandSettled = false;
    const settleResumeFailure = async (
      reason: string,
      code?: string,
      error?: string,
    ): Promise<void> => {
      if (commandSettled) return;
      commandSettled = true;
      await terminalizeLocalCoderCommand(controlPlaneStore, commandAcceptance, {
        status: 'failed',
        reason,
      });
      if (dedupeKey) {
        recentMessageKeys.recordTerminal(id, dedupeKey, {
          event: 'error',
          data: { reason, ...(code ? { code } : {}), ...(error ? { error } : {}), duplicate: false },
        }, -1, claimGuard);
      }
    };
    try {
    let attachmentOpts: Awaited<ReturnType<typeof masterAttachmentOpts>>;
    try {
      attachmentOpts = await masterAttachmentOpts(id);
    } catch (error) {
      await settleResumeFailure('master-runtime-invalid', 'MASTER_RUNTIME_INVALID', error instanceof Error ? error.message : String(error));
      return c.json({
        error: error instanceof Error ? error.message : String(error),
        code: 'MASTER_RUNTIME_INVALID',
      }, 409);
    }
    let boardAttachments: import('@mcp/company-contracts').BoardAttachment[] | undefined;
    let attachments: AttachmentBody[] | undefined;
    try {
      attachments = await normalizeAttachmentsForModel(
        attachmentsCheck.value,
        attachmentOpts,
      );
      if (attachmentsCheck.value?.length) boardAttachments = await persistBoardAttachments(await companyFilesFor(id), attachmentsCheck.value);
    } catch (error) {
      await settleResumeFailure('attachment-normalization-failed', undefined, error instanceof Error ? error.message : String(error));
      throw error;
    }

    // Serialize the "is there an existing orchestrator?" decision so two
    // concurrent /resume calls can't both observe registry-empty and each
    // create a fresh CompanyOrchestrator + start its own runCoder loop.
    const decision = await withSessionLock(id, async (): Promise<
      | { kind: 'attach'; orchestrator: WorkerBackedOrchestrator; since: number; bus: WorkerBackedOrchestrator['metaBus'] }
      | { kind: 'fresh'; orchestrator: WorkerBackedOrchestrator; bus: WorkerBackedOrchestrator['metaBus'] }
      | {
          kind: 'reject';
          status: 400 | 404 | 409 | 500;
          body: { error: string; code?: string };
        }
      | { kind: 'replay'; bus: WorkerBackedOrchestrator['metaBus']; since: number }
      | { kind: 'gone' }
    > => {
      const existing = getCompanyOrchestrator(id);
      if (existing) {
        if (!(await bindCompanyCommandCompletion(
          id,
          dedupeKey,
          commandAcceptance,
          existing.metaBus,
          claimGuard,
        ))) {
          return {
            kind: 'reject',
            status: 500,
            body: { error: 'Failed to bind the command to its company stream' },
          };
        }
        let delivery: { ok: boolean; pending?: 'interactive_wait' };
        try {
          delivery = await existing.sendMessageToMaster(message, {
            attachments,
            boardAttachments,
            thinking: body.thinking,
          });
        } catch (error) {
          const outcomeUnknown = isMutationOutcomeUnknownError(error);
          if (outcomeUnknown) await evictCompanyOrchestrator(id);
          return {
            kind: 'reject',
            status: 500,
            body: outcomeUnknown
              ? {
                  error:
                    'Resume message outcome is unknown because its worker acknowledgement ' +
                    'was lost. The mutating RPC was not replayed.',
                  code: 'OUTCOME_UNKNOWN',
                }
              : {
                  error:
                    `Resume message failed: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  code: 'MASTER_MESSAGE_DELIVERY_FAILED',
                },
          };
        }
        if (!delivery.ok) {
          return {
            kind: 'reject',
            status: 409,
            body: {
              error: delivery.pending === 'interactive_wait'
                ? 'master is waiting for an interactive answer'
                : 'master did not accept the message',
            },
          };
        }
        if (dedupeKey) {
          recentMessageKeys.record(
            id,
            dedupeKey,
            existing.metaBus,
            parseLastEventId(c),
            claimGuard,
          );
        }
        return { kind: 'attach', orchestrator: existing, since: parseLastEventId(c), bus: existing.metaBus };
      }

      const userMessage = message;

      // Sub-sessions (migration 067): a brand-new tab has no master_run
      // yet, so we cold-start instead of trying to resume.
      const agentRuns = files.listAgentRunsSync();
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

      // Spawn-or-attach helper. Wraps the single allowed attempt at:
      //   1. getOrSpawn the orchestrator (creates worker if needed)
      //   2. resume OR cold-start the master
      // Returns the spawn handle on success, throws on any failure. A lost
      // acknowledgement is never replayed onto a replacement worker.
      const attemptSpawnAndResume = async (): Promise<{
        orchestrator: WorkerBackedOrchestrator;
        bus: WorkerBackedOrchestrator['metaBus'];
      }> => {
        const spawned = await getOrSpawnCompanyOrchestrator(id);
        const orchestrator = spawned.orchestrator;
        if (!(await bindCompanyCommandCompletion(
          id,
          dedupeKey,
          commandAcceptance,
          spawned.bus,
          claimGuard,
        ))) {
          await evictCompanyOrchestrator(id);
          throw new Error('failed to bind the command to its company stream');
        }
        if (dedupeKey) {
          recentMessageKeys.record(id, dedupeKey, spawned.bus, -1, claimGuard);
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
          boardAttachments,
          thinking: body.thinking ?? masterRuntime.thinking,
          thinkingBudgetTokens: masterRuntime.thinkingBudgetTokens,
          temperature: masterRuntime.temperature,
          reasoningEffort: masterRuntime.reasoningEffort,
          fallbackModels: masterRuntime.fallbackModels,
        });
        return { orchestrator, bus: spawned.bus };
      };

      let result: {
        orchestrator: WorkerBackedOrchestrator;
        bus: WorkerBackedOrchestrator['metaBus'];
      };
      try {
        result = await attemptSpawnAndResume();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[company s=${id}] Resume failed:`, msg);
        // Once the command is bound, changing to a second worker/bus would
        // violate immutable command↔executor correlation and could repeat a
        // partially delivered message. Fail this command explicitly; a new
        // user action gets a new idempotency key and may spawn a fresh worker.
        await evictCompanyOrchestrator(id);
        return {
          kind: 'reject',
          status: 500,
          body: isMutationOutcomeUnknownError(err)
            ? {
                error:
                  `Resume outcome is unknown: ${msg}. ` +
                  'The mutating RPC was not replayed.',
                code: 'OUTCOME_UNKNOWN',
              }
            : { error: `Resume failed: ${msg}` },
        };
      }

      return { kind: 'fresh', orchestrator: result.orchestrator, bus: result.bus };
    });

    if (decision.kind === 'reject') {
      const outcomeUnknown = decision.body.code === 'OUTCOME_UNKNOWN';
      await settleResumeFailure(
        outcomeUnknown
          ? 'outcome_unknown'
          : decision.body.code === 'MASTER_MESSAGE_DELIVERY_FAILED'
            ? 'company-resume-setup-failed'
          : decision.status === 409 ? 'company-command-conflict' : 'company-resume-failed',
        decision.body.code,
        decision.body.error,
      );
      return c.json(decision.body, decision.status);
    }
    if (decision.kind === 'replay') {
      return pumpBusToSSE(c, decision.bus, { since: decision.since });
    }
    if (decision.kind === 'gone') {
      return syntheticDoneSSE(c, { reason: 'completed', duplicate: true });
    }
    if (decision.kind === 'attach') {
      const response = pumpBusToSSE(c, decision.bus, {
        since: decision.since,
      });
      commandSettled = true;
      return response;
    }
    const response = pumpBusToSSE(c, decision.bus, {
      since: -1,
      // Worker pool handles eviction via TTL sweep.
      onDone: () => undefined,
    });
    commandSettled = true;
    return response;
    } catch (error) {
      await settleResumeFailure('company-resume-setup-failed', undefined, error instanceof Error ? error.message : String(error));
      throw error;
    }
  });

  /**
   * Abort the entire company session — stops all runners.
  */
  app.on('POST', ['/api/company/sessions/:id/abort', '/api/company/sessions/:id/pause'], async (c) => {
    const id = parseCompanySessionIdParam(c);
    let files: CompanySessionFiles;
    try {
      files = await companyFilesFor(id);
    } catch {
      return notFound(c);
    }
    if (files.getSession().runtime_kind === 'app_studio') {
      return appOwnedControlPlaneConflict(c, 'session abort');
    }
    const pausing = c.req.path.endsWith('/pause');
    const result = await abortCompanyRuntime(id, pausing ? { finalStatus: 'paused' } : {});
    if (!result.ok) {
      if (result.reason === 'outcome_unknown') {
        return c.json({ error: result.error, code: result.code }, 500);
      }
      if (pausing) {
        await files.updateSessionStatus('paused');
        return c.json({ ok: true, status: 'paused' });
      }
      return c.json({ error: 'No active orchestrator' }, 404);
    }
    return c.json({ ok: true, ...(pausing ? { status: 'paused' } : {}) });
  });

  /**
   * Switch the master agent's provider/model and optionally update
   * subordinate role defaults. Works both while running (live swap)
   * and while idle (changes take effect on next start/resume).
  */
  app.post('/api/company/sessions/:id/switch', async (c) => {
    const id = parseCompanySessionIdParam(c);
    let files: CompanySessionFiles;
    try {
      files = await companyFilesFor(id);
    } catch {
      return notFound(c);
    }
    const session = files.getSession();
    if (session.runtime_kind === 'app_studio') {
      return appOwnedControlPlaneConflict(c, 'runtime/model configuration');
    }

    const body = await parseJsonBody<{
      provider: string;
      model?: string;
      role_assignments?: Array<{ role: string; provider: string; model: string; tier: string; skills?: string[] }>;
    }>(c);

    if (!body.provider) return c.json({ error: 'provider required' }, 400);

    // Update bundle-owned session configuration.
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(session.config_json); } catch { /* defaults */ }
    config.master_provider = body.provider;
    if (body.model) config.master_model = body.model;
    if (body.role_assignments) config.role_assignments = body.role_assignments;
    await files.updateSessionConfig(JSON.stringify(config));

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
        await orchestrator.updateRoleConfigs(body.role_assignments);
      }
    }

    // Update the master's independent agent-run record.
    const agentRuns = files.listAgentRunsSync();
    const masterRun = agentRuns.filter((r) => r.role === 'master').pop();
    if (masterRun) {
      await files.updateAgentRunProvider(
        masterRun.id,
        resolvedProvider,
        resolvedModel,
      );
    }

    return c.json({ ok: true, provider: resolvedProvider, model: resolvedModel });
  });

  /**
   * Human responds to the Master's submit_plan.
   * This unblocks the Master's waitForUserInput() call.
  */
  app.post('/api/company/sessions/:id/plan-response', async (c) => {
    const id = parseCompanySessionIdParam(c);
    const body = await parseJsonBody<PlanResponseBody>(c);
    if (body.approved === undefined) {
      return c.json({ error: 'approved field required' }, 400);
    }
    let files: CompanySessionFiles;
    try {
      files = await companyFilesFor(id);
    } catch {
      return notFound(c);
    }

    // Live path.
    const orchestrator = getCompanyOrchestrator(id);
    if (orchestrator) {
      let resolved: MasterPrompt | null;
      try {
        resolved = await orchestrator.respondToMasterPlan(
          body.approved,
          body.feedback,
          body.prompt_id,
          { retryOutcomeUnknown: body.retry_outcome_unknown },
        );
      } catch (error) {
        const code = (error as Error & { code?: string }).code;
        if (code === 'PROMPT_DELIVERY_PAYLOAD_CONFLICT') {
          return c.json({
            error: error instanceof Error ? error.message : String(error),
            code,
          }, 409);
        }
        return c.json({
          error:
            `${error instanceof Error ? error.message : String(error)}. ` +
            'The delivery outcome is unknown; retry only with ' +
            '{"retry_outcome_unknown":true} and the identical response payload.',
          code: 'OUTCOME_UNKNOWN',
        }, 500);
      }
      if (!resolved) {
        return c.json(
          {
            error:
              'No pending master plan accepted the response ' +
              '(already resolved, runner not waiting, or session ended)',
            code: 'MASTER_INPUT_NOT_ACCEPTED',
          },
          409,
        );
      }
      return c.json({ ok: true, prompt: resolved });
    }

    // Dead orchestrator: one critical section spans the durable delivery claim,
    // worker effect, and token-bound completion. The durable claim survives a
    // process restart; an uncertain RPC is fenced until an explicit,
    // same-payload retry is requested.
    const delivery = await withSessionLock(
      id,
      async (): Promise<PersistedPromptDeliveryResult> => {
        const pendingPlan = await files.getPendingMasterPrompt('plan');
        const promptId = body.prompt_id ?? pendingPlan?.id;
        if (promptId == null) {
          return {
            ok: false,
            error: 'Plan prompt is no longer pending',
            code: 'PROMPT_ALREADY_RESOLVED',
            status: 409,
          };
        }

        const deliveryToken = randomUUID();
        let claim: Awaited<ReturnType<typeof files.claimMasterPromptDelivery>>;
        try {
          claim = await files.claimMasterPromptDelivery(
            promptId,
            'plan',
            deliveryToken,
            hashControlPlanePayload({
              kind: 'plan',
              approved: body.approved!,
              feedback: body.feedback ?? null,
            }),
            { retryOutcomeUnknown: body.retry_outcome_unknown },
          );
        } catch (error) {
          return {
            ok: false,
            error:
              `Could not acquire durable plan-delivery authority: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            code: 'PROMPT_DELIVERY_AUTHORITY_UNAVAILABLE',
            status: 500,
          };
        }
        if (claim.kind === 'not_pending') {
          return {
            ok: false,
            error: 'Plan prompt is no longer pending',
            code: 'PROMPT_ALREADY_RESOLVED',
            status: 409,
          };
        }
        if (claim.kind === 'payload_conflict') {
          return {
            ok: false,
            error: 'The explicit retry payload differs from the uncertain plan delivery',
            code: 'PROMPT_DELIVERY_PAYLOAD_CONFLICT',
            status: 409,
          };
        }
        if (claim.kind !== 'claimed') {
          return {
            ok: false,
            error:
              'Plan delivery is in progress or has an unknown outcome. ' +
              'Retry only with {"retry_outcome_unknown":true} and the identical payload.',
            code: 'OUTCOME_UNKNOWN',
            status: 409,
          };
        }

        const verdict = body.approved
          ? `[plano APROVADO]${body.feedback ? ` ${body.feedback}` : ''}`
          : `[plano REJEITADO]${body.feedback ? ` ${body.feedback}` : ''}`;
        const res = await ensureCompanyMasterLiveLocked(id, deps, { message: verdict });
        if ('error' in res) {
          if (res.code === 'OUTCOME_UNKNOWN') {
            try {
              await files.markMasterPromptDeliveryOutcomeUnknown(promptId, deliveryToken);
            } catch { /* the response remains outcome-unknown */ }
            return {
              ok: false,
              error:
                `${res.error} Retry only with {"retry_outcome_unknown":true} ` +
                'and the identical payload.',
              code: 'OUTCOME_UNKNOWN',
              status: res.status,
            };
          }
          try {
            if (!(await files.releaseMasterPromptDelivery(promptId, deliveryToken))) {
              return {
                ok: false,
                error: 'Plan delivery failed and its durable reservation could not be released',
                code: 'OUTCOME_UNKNOWN',
                status: 500,
              };
            }
          } catch (error) {
            return {
              ok: false,
              error:
                `Plan delivery failed and reservation release was not confirmed: ` +
                `${error instanceof Error ? error.message : String(error)}`,
              code: 'OUTCOME_UNKNOWN',
              status: 500,
            };
          }
          return {
            ok: false,
            error: res.error,
            code: res.code ?? 'MASTER_RESUME_FAILED',
            status: res.status,
          };
        }

        let prompt: MasterPrompt | null;
        try {
          prompt = await files.completeMasterPromptDelivery(
            promptId,
            deliveryToken,
            {
              kind: 'plan',
              approved: body.approved!,
              feedback: body.feedback,
            },
          );
        } catch (error) {
          try {
            await files.markMasterPromptDeliveryOutcomeUnknown(promptId, deliveryToken);
          } catch { /* preserve primary failure */ }
          return {
            ok: false,
            error:
              `Plan was delivered but its durable prompt update failed: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            code: 'OUTCOME_UNKNOWN',
            status: 500,
          };
        }
        if (!prompt) {
          try {
            await files.markMasterPromptDeliveryOutcomeUnknown(promptId, deliveryToken);
          } catch { /* response remains outcome-unknown */ }
          return {
            ok: false,
            error: 'Plan was delivered but its durable completion was not confirmed',
            code: 'OUTCOME_UNKNOWN',
            status: 500,
          };
        }
        return { ok: true, prompt, orchestrator: res.orchestrator };
      },
    );
    if (!delivery.ok) {
      return c.json({
        error: delivery.error,
        code: delivery.code,
      }, delivery.status);
    }
    try { await delivery.orchestrator.postToBoard('human', null, 'decision', `Plan ${body.approved ? 'APPROVED' : 'REJECTED'}${body.feedback ? `: ${body.feedback}` : ''}`); }
    catch { /* best-effort */ }
    return c.json({ ok: true, resumed: true, prompt: delivery.prompt });
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
    const id = parseCompanySessionIdParam(c);
    const body = await parseJsonBody<{ message: string; interject?: boolean; attachments?: AttachmentBody[]; thinking?: boolean }>(c);
    const attachmentsCheck = validateAttachments(body.attachments);
    if (!attachmentsCheck.ok) {
      return c.json({ error: attachmentsCheck.error, code: attachmentsCheck.code }, attachmentsCheck.status);
    }
    const attachments = await normalizeAttachmentsForModel(
      attachmentsCheck.value,
      await masterAttachmentOpts(id),
    );
    const message = body.message?.trim()
      ? body.message
      : (attachments?.length ? DEFAULT_ATTACHMENT_PROMPT : '');
    if (!message) return c.json({ error: 'message required' }, 400);

    const boardAttachments = attachmentsCheck.value?.length
      ? await persistBoardAttachments(await companyFilesFor(id), attachmentsCheck.value) : undefined;

    // Live path.
    const orchestrator = getCompanyOrchestrator(id);
    if (orchestrator) {
      if (orchestrator.metaBus.ended) {
        return c.json({ error: 'Session has ended. Please start a new session.' }, 410);
      }
      let result: { ok: boolean; pending?: 'interactive_wait' };
      try {
        result = await orchestrator.sendMessageToMaster(message, {
          interject: body.interject,
          attachments,
          boardAttachments,
          thinking: body.thinking,
        });
      } catch (error) {
        if (isMutationOutcomeUnknownError(error)) {
          await evictCompanyOrchestrator(id);
          return c.json({
            error:
              'Master message outcome is unknown because its worker acknowledgement ' +
              'was lost. The mutating RPC was not replayed.',
            code: 'OUTCOME_UNKNOWN',
          }, 500);
        }
        return c.json({
          error: error instanceof Error ? error.message : String(error),
          code: 'MASTER_MESSAGE_DELIVERY_FAILED',
        }, 502);
      }
      if (!result.ok && result.pending === 'interactive_wait') {
        return c.json(
          {
            error: 'master is waiting for an interactive answer — use /plan-response or /answer, or pass {"interject": true} to override',
            code: 'INTERACTION_PENDING',
          },
          409,
        );
      }
      if (!result.ok) {
        return c.json({
          error: 'master did not accept the message',
          code: 'MASTER_MESSAGE_NOT_ACCEPTED',
        }, 503);
      }
      return c.json({ ok: true });
    }

    // Dead orchestrator: re-spawn + resume the master with this message instead
    // of 404ing (idle eviction / process restart should be invisible).
    const res = await ensureCompanyMasterLive(id, deps, {
      message,
      attachments,
      boardAttachments,
      interject: body.interject,
      thinking: body.thinking,
    });
    if ('error' in res) {
      return c.json({
        error: res.error,
        ...(res.code ? { code: res.code } : {}),
      }, res.status);
    }
    return c.json({ ok: true, resumed: true });
  });

  /**
   * Human answers a Master agent's ask_user question.
   * This unblocks the Master's waitForUserInput() call.
  */
  app.post('/api/company/sessions/:id/answer', async (c) => {
    const id = parseCompanySessionIdParam(c);
    const body = await parseJsonBody<{
      answer: string;
      prompt_id?: string;
      retry_outcome_unknown?: boolean;
    }>(c);
    if (!body.answer) {
      return c.json({ error: 'answer required' }, 400);
    }
    let files: CompanySessionFiles;
    try {
      files = await companyFilesFor(id);
    } catch {
      return notFound(c);
    }

    // Live path — master runner is in the pool: deliver to its waitForUserInput.
    const orchestrator = getCompanyOrchestrator(id);
    if (orchestrator) {
      let resolved: MasterPrompt | null;
      try {
        resolved = await orchestrator.respondToMasterQuestion(
          body.answer,
          body.prompt_id,
          { retryOutcomeUnknown: body.retry_outcome_unknown },
        );
      } catch (error) {
        const code = (error as Error & { code?: string }).code;
        if (code === 'PROMPT_DELIVERY_PAYLOAD_CONFLICT') {
          return c.json({
            error: error instanceof Error ? error.message : String(error),
            code,
          }, 409);
        }
        return c.json({
          error:
            `${error instanceof Error ? error.message : String(error)}. ` +
            'The delivery outcome is unknown; retry only with ' +
            '{"retry_outcome_unknown":true} and the identical answer.',
          code: 'OUTCOME_UNKNOWN',
        }, 500);
      }
      if (!resolved) {
        return c.json(
          {
            error:
              'No pending question accepted the answer ' +
              '(already resolved, runner not waiting, or session ended)',
            code: 'MASTER_INPUT_NOT_ACCEPTED',
          },
          409,
        );
      }
      return c.json({ ok: true, prompt: resolved });
    }

    const delivery = await withSessionLock(
      id,
      async (): Promise<PersistedPromptDeliveryResult> => {
        const pendingPrompt = await files.getPendingMasterPrompt('question');
        const promptId = body.prompt_id ?? pendingPrompt?.id;
        if (promptId == null) {
          return {
            ok: false,
            error: 'Question prompt is no longer pending',
            code: 'PROMPT_ALREADY_RESOLVED',
            status: 409,
          };
        }

        const deliveryToken = randomUUID();
        let claim: Awaited<ReturnType<typeof files.claimMasterPromptDelivery>>;
        try {
          claim = await files.claimMasterPromptDelivery(
            promptId,
            'question',
            deliveryToken,
            hashControlPlanePayload({ kind: 'question', answer: body.answer }),
            { retryOutcomeUnknown: body.retry_outcome_unknown },
          );
        } catch (error) {
          return {
            ok: false,
            error:
              `Could not acquire durable answer-delivery authority: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            code: 'PROMPT_DELIVERY_AUTHORITY_UNAVAILABLE',
            status: 500,
          };
        }
        if (claim.kind === 'not_pending') {
          return {
            ok: false,
            error: 'Question prompt is no longer pending',
            code: 'PROMPT_ALREADY_RESOLVED',
            status: 409,
          };
        }
        if (claim.kind === 'payload_conflict') {
          return {
            ok: false,
            error: 'The explicit retry payload differs from the uncertain answer delivery',
            code: 'PROMPT_DELIVERY_PAYLOAD_CONFLICT',
            status: 409,
          };
        }
        if (claim.kind !== 'claimed') {
          return {
            ok: false,
            error:
              'Answer delivery is in progress or has an unknown outcome. ' +
              'Retry only with {"retry_outcome_unknown":true} and the identical answer.',
            code: 'OUTCOME_UNKNOWN',
            status: 409,
          };
        }

        const res = await ensureCompanyMasterLiveLocked(id, deps, {
          message: `[resposta à pergunta do Master] ${body.answer}`,
        });
        if ('error' in res) {
          if (res.code === 'OUTCOME_UNKNOWN') {
            try {
              await files.markMasterPromptDeliveryOutcomeUnknown(promptId, deliveryToken);
            } catch { /* the response remains outcome-unknown */ }
            return {
              ok: false,
              error:
                `${res.error} Retry only with {"retry_outcome_unknown":true} ` +
                'and the identical answer.',
              code: 'OUTCOME_UNKNOWN',
              status: res.status,
            };
          }
          try {
            if (!(await files.releaseMasterPromptDelivery(promptId, deliveryToken))) {
              return {
                ok: false,
                error: 'Answer delivery failed and its durable reservation could not be released',
                code: 'OUTCOME_UNKNOWN',
                status: 500,
              };
            }
          } catch (error) {
            return {
              ok: false,
              error:
                `Answer delivery failed and reservation release was not confirmed: ` +
                `${error instanceof Error ? error.message : String(error)}`,
              code: 'OUTCOME_UNKNOWN',
              status: 500,
            };
          }
          return {
            ok: false,
            error: res.error,
            code: res.code ?? 'MASTER_RESUME_FAILED',
            status: res.status,
          };
        }

        let prompt: MasterPrompt | null;
        try {
          prompt = await files.completeMasterPromptDelivery(
            promptId,
            deliveryToken,
            { kind: 'question', answer: body.answer! },
          );
        } catch (error) {
          try {
            await files.markMasterPromptDeliveryOutcomeUnknown(promptId, deliveryToken);
          } catch { /* preserve primary failure */ }
          return {
            ok: false,
            error:
              `Answer was delivered but its durable prompt update failed: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            code: 'OUTCOME_UNKNOWN',
            status: 500,
          };
        }
        if (!prompt) {
          try {
            await files.markMasterPromptDeliveryOutcomeUnknown(promptId, deliveryToken);
          } catch { /* response remains outcome-unknown */ }
          return {
            ok: false,
            error: 'Answer was delivered but its durable completion was not confirmed',
            code: 'OUTCOME_UNKNOWN',
            status: 500,
          };
        }
        return { ok: true, prompt, orchestrator: res.orchestrator };
      },
    );
    if (!delivery.ok) {
      return c.json({
        error: delivery.error,
        code: delivery.code,
      }, delivery.status);
    }
    // Mirror the live path: record the human's answer on the PERSISTENT board so
    // it survives close/open (board_entries in SQLite).
    try { await delivery.orchestrator.postToBoard('human', null, 'decision', `Human answered: ${body.answer}`); }
    catch { /* best-effort */ }
    return c.json({ ok: true, resumed: true, prompt: delivery.prompt });
  });

  /**
   * Check if there's an active orchestrator for a company session.
  */
  app.get('/api/company/sessions/:id/status', (c) => {
    const id = parseCompanySessionIdParam(c);
    return c.json({
      active: hasCompanyOrchestrator(id),
      company_session_id: id,
    });
  });
}
