import { createHash, randomUUID } from 'node:crypto';
import {
  CONTROL_PLANE_SCHEMA_VERSION,
  asAgentRunAttemptId,
  asAgentRunId,
  asCorrelationId,
  asRuntimeEventId,
  asSessionCommandId,
  asSessionId,
  classifyCoderTerminalOutcome,
  runtimeEventClass,
  type AgentRunId,
  type ControlPlaneEventType,
  type SessionCommand,
  type SessionCommandKind,
  type SessionCommandStatus,
} from '@mcp/agent-runtime-contracts';
import {
  hashControlPlanePayload,
  type ControlPlaneCommandContext,
  type ControlPlaneRunContext,
} from '@mcp/store/control-plane/index.js';
import type { ControlPlaneAuthority } from './file-control-plane-store.js';

const EXECUTOR_LEASE_MS = 10 * 60_000;

export interface CoderControlPlaneShadowMetrics {
  accepted: number;
  existing: number;
  payloadConflicts: number;
  versionConflicts: number;
  runsStarted: number;
  runsTerminalized: number;
  toolBoundaries: number;
  leaseRenewals: number;
  writeErrors: number;
  lifecycleErrors: number;
  divergences: number;
  mirroredByClass: Record<string, number>;
  appendLatency: { p50: number; p95: number; p99: number; samples: number };
  queue: { depth: number; highWatermark: number; dropped: number };
}

const metrics = {
  accepted: 0,
  existing: 0,
  payloadConflicts: 0,
  versionConflicts: 0,
  runsStarted: 0,
  runsTerminalized: 0,
  toolBoundaries: 0,
  leaseRenewals: 0,
  writeErrors: 0,
  lifecycleErrors: 0,
  divergences: 0,
  queueHighWatermark: 0,
  queueDropped: 0,
};

const mirroredByClass: Record<string, number> = {};
const appendLatencies: number[] = [];
const APPEND_LATENCY_BUFFER = 512;
const DEFAULT_SHADOW_WRITE_QUEUE_CAP = 2_048;

interface ShadowWriteJob {
  label: string;
  write: () => void | Promise<void>;
  resolve: () => void;
}

const shadowWriteQueue: ShadowWriteJob[] = [];
const shadowDrainWaiters: Array<() => void> = [];
let shadowWriteScheduled = false;
let shadowWriteRunning = false;

function shadowWriteQueueCap(): number {
  return DEFAULT_SHADOW_WRITE_QUEUE_CAP;
}

function resolveShadowDrainWaiters(): void {
  if (shadowWriteRunning || shadowWriteQueue.length > 0) return;
  while (shadowDrainWaiters.length > 0) shadowDrainWaiters.shift()?.();
}

async function runNextShadowWrite(): Promise<void> {
  shadowWriteScheduled = false;
  const job = shadowWriteQueue.shift();
  if (!job) {
    shadowWriteRunning = false;
    resolveShadowDrainWaiters();
    return;
  }
  shadowWriteRunning = true;
  await executeShadowWriteJob(job);
  // One filesystem job per event-loop turn. This preserves FIFO while yielding
  // between writes so worker bus publication/IPC stays responsive.
  shadowWriteScheduled = true;
  setImmediate(() => void runNextShadowWrite());
}

async function executeShadowWriteJob(job: ShadowWriteJob): Promise<void> {
  try {
    await measureAppend(job.write, 'queued');
  } catch (error) {
    metrics.lifecycleErrors += 1;
    console.warn(
      `[control-plane-shadow] queued ${job.label} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    job.resolve();
  }
}

function scheduleShadowWritePump(): void {
  if (shadowWriteScheduled || shadowWriteRunning) return;
  shadowWriteScheduled = true;
  setImmediate(() => void runNextShadowWrite());
}

function enqueueShadowWrite(
  label: string,
  write: () => void | Promise<void>,
): Promise<void> {
  return new Promise((resolve) => {
    const cap = shadowWriteQueueCap();
    if (shadowWriteQueue.length >= cap) {
      // Only observational journal projections enter this queue. Authority
      // (claim/start/lease/terminal) is committed synchronously, so overload
      // can safely shed this newest observation without unbounded growth.
      metrics.queueDropped += 1;
      resolve();
      return;
    }
    shadowWriteQueue.push({ label, write, resolve });
    metrics.queueHighWatermark = Math.max(metrics.queueHighWatermark, shadowWriteQueue.length);
    scheduleShadowWritePump();
  });
}

/** Wait until every write queued before this call has settled. */
export function drainLocalCoderShadowWrites(): Promise<void> {
  if (!shadowWriteRunning && shadowWriteQueue.length === 0) return Promise.resolve();
  return new Promise((resolve) => shadowDrainWaiters.push(resolve));
}

function recordAppendLatency(ms: number): void {
  appendLatencies.push(ms);
  if (appendLatencies.length > APPEND_LATENCY_BUFFER) {
    appendLatencies.splice(0, appendLatencies.length - APPEND_LATENCY_BUFFER);
  }
}

async function measureAppend<T>(
  write: () => T | Promise<T>,
  _label?: string,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await write();
  } finally {
    const ms = performance.now() - startedAt;
    recordAppendLatency(ms);
  }
}

function appendLatencyPercentiles(): { p50: number; p95: number; p99: number; samples: number } {
  const samples = appendLatencies.length;
  if (samples === 0) return { p50: 0, p95: 0, p99: 0, samples: 0 };
  const sorted = [...appendLatencies].sort((a, b) => a - b);
  const pick = (p: number): number =>
    sorted[Math.min(samples - 1, Math.max(0, Math.ceil((p / 100) * samples) - 1))];
  return { p50: pick(50), p95: pick(95), p99: pick(99), samples };
}

function recordMirrored(eventClass: string, count = 1): void {
  mirroredByClass[eventClass] = (mirroredByClass[eventClass] ?? 0) + count;
}

export function recordLocalCoderShadowDivergences(count: number): void {
  metrics.divergences += count;
}

export function coderControlPlaneShadowEnabled(): boolean {
  // Compatibility name: this now controls only the optional root AgentRun
  // projection. SessionCommand acceptance/terminal state is always authoritative
  // whenever the HTTP server's filesystem control-plane authority is available.
  // Child AgentRun enforcement requires the root run to be established
  // synchronously with command acceptance. Opting into ENFORCE therefore
  // enables this projection even when the audit-only root flag is omitted.
  // The child shadow also needs a root parent row; treating it as an alias
  // prevents every child spawn from degrading on a missing parent.
  return process.env.CODER_CONTROL_PLANE_SHADOW === '1'
    || process.env.CODER_AGENT_RUN_STORE_SHADOW === '1'
    || process.env.CODER_AGENT_RUN_STORE_ENFORCE === '1';
}

export function coderRuntimeJournalShadowEnabled(): boolean {
  return coderControlPlaneShadowEnabled() && process.env.CODER_RUNTIME_JOURNAL_SHADOW === '1';
}

export function snapshotCoderControlPlaneShadowMetrics(): CoderControlPlaneShadowMetrics {
  const {
    queueHighWatermark,
    queueDropped,
    ...baseMetrics
  } = metrics;
  return {
    ...baseMetrics,
    mirroredByClass: { ...mirroredByClass },
    appendLatency: appendLatencyPercentiles(),
    queue: {
      depth: shadowWriteQueue.length + (shadowWriteRunning ? 1 : 0),
      highWatermark: queueHighWatermark,
      dropped: queueDropped,
    },
  };
}

export function resetCoderControlPlaneShadowMetricsForTests(): void {
  for (const key of Object.keys(metrics) as Array<keyof typeof metrics>) metrics[key] = 0;
  for (const key of Object.keys(mirroredByClass)) delete mirroredByClass[key];
  appendLatencies.length = 0;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function opaqueValueHash(value: unknown): string {
  try {
    return hashControlPlanePayload(value);
  } catch {
    const shape = value === null
      ? 'null'
      : Array.isArray(value)
        ? `array:${value.length}`
        : typeof value === 'object'
          ? `object:${Object.keys(value as object).sort().join(',')}`
          : typeof value;
    return digest(`non-json:${shape}`);
  }
}

function stableUuid(value: string): string {
  const bytes = Buffer.from(digest(value).slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

function stableCommandKey(input: {
  sessionId: string;
  kind: SessionCommandKind;
  idempotencyKey?: string | null;
}): { key: string; digest: string } {
  const key = input.idempotencyKey ?? `server:${randomUUID()}`;
  return {
    key,
    digest: digest(`coder:${input.sessionId}:${input.kind}:${key}`),
  };
}

export interface LocalCoderMessageFingerprintInput {
  content?: string;
  attachments?: Array<{ name: string; mediaType: string; path?: string; base64?: string; text?: string }>;
  resume?: boolean;
  agent?: string | null;
  profile?: string | null;
  planMode?: boolean;
  maxTurns?: number;
  selectedSkillIds?: string[];
  worktree?: { name?: string; branch?: string };
}

export function fingerprintLocalCoderMessage(input: LocalCoderMessageFingerprintInput): Record<string, unknown> {
  return {
    contentHash: digest(input.content ?? ''),
    contentChars: input.content?.length ?? 0,
    attachments: (input.attachments ?? []).map((attachment) => ({
      name: attachment.name,
      mediaType: attachment.mediaType,
      pathHash: attachment.path ? digest(attachment.path) : null,
      contentHash: digest(attachment.base64 ?? attachment.text ?? ''),
      encodedChars: attachment.base64?.length ?? attachment.text?.length ?? 0,
    })),
    resume: input.resume === true,
    agent: input.agent ?? null,
    profile: input.profile ?? null,
    planMode: input.planMode === true,
    maxTurns: input.maxTurns ?? null,
    selectedSkillIds: [...(input.selectedSkillIds ?? [])].sort(),
    worktree: input.worktree
      ? { name: input.worktree.name ?? null, branch: input.worktree.branch ?? null }
      : null,
  };
}

export function fingerprintLocalCompanyCommand(input: {
  message: string;
  attachments?: Array<{ name: string; mediaType: string; base64?: string; text?: string }>;
  thinking?: boolean;
  maxTurns?: number;
}): Record<string, unknown> {
  return {
    messageHash: digest(input.message),
    messageChars: input.message.length,
    attachments: (input.attachments ?? []).map((attachment) => ({
      nameHash: digest(attachment.name),
      mediaType: attachment.mediaType,
      contentHash: digest(attachment.base64 ?? attachment.text ?? ''),
      encodedChars: attachment.base64?.length ?? attachment.text?.length ?? 0,
    })),
    thinking: input.thinking === true,
    maxTurns: input.maxTurns ?? null,
  };
}

export interface AcceptLocalCoderCommandInput {
  store?: ControlPlaneAuthority | null;
  sessionId: ReturnType<typeof asSessionId>;
  kind: SessionCommandKind;
  idempotencyKey?: string | null;
  fingerprint: Record<string, unknown>;
  createRun: boolean;
  linkedAgentRunId?: AgentRunId;
  role: string;
  agentDefinitionId: string;
  requestedProvider?: string;
  requestedModel?: string;
  requestedReasoningEffort?: string;
  requestedPreset?: string;
  requestedCapabilityProfile: string;
  requestedAt?: string;
}

export interface LocalCoderShadowAcceptance {
  outcome: 'accepted' | 'existing' | 'payload_conflict' | 'version_conflict';
  commandStatus?: SessionCommandStatus;
  /** Durable terminal reason, used to replay typed outcomes such as ACK loss. */
  commandReasonCode?: string;
  /** Durable correlation used to prove that a live worker bus owns this command. */
  agentRunId?: AgentRunId;
  executionBusId?: string;
  commandContext?: ControlPlaneCommandContext;
  runContext?: ControlPlaneRunContext;
}

function commandExecutionBusId(command: { result?: unknown }): string | undefined {
  if (!command.result || typeof command.result !== 'object') return undefined;
  const busId = (command.result as { busId?: unknown }).busId;
  return typeof busId === 'string' && busId.length > 0 ? busId : undefined;
}

export async function acceptLocalCoderCommand(
  input: AcceptLocalCoderCommandInput,
): Promise<LocalCoderShadowAcceptance | null> {
  // The command ledger is the idempotency authority, independently from the
  // diagnostic shadow flags. Journal/AgentRun projections remain separately
  // gated by their callers and the filesystem authority's journal setting.
  if (!input.store) return null;

  const requestedAt = input.requestedAt ?? new Date().toISOString();
  const identity = stableCommandKey(input);
  const sessionId = input.sessionId;
  const commandId = asSessionCommandId(
    stableUuid(`command:coder:${identity.digest}`),
  );
  const correlationId = asCorrelationId(
    stableUuid(`correlation:coder:${identity.digest}`),
  );
  const actor = {
    actorId: 'local-user',
    actorType: 'user' as const,
    source: 'http' as const,
  };
  const command: SessionCommand<Record<string, unknown>> = {
    schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
    commandId,
    idempotencyKey: identity.key,
    kind: input.kind,
    sessionId,
    actor,
    requestedAt,
    correlationId,
    payload: input.fingerprint,
  };
  const agentRunId = asAgentRunId(
    stableUuid(`agent-run:coder:${identity.digest}`),
  );
  const attemptId = asAgentRunAttemptId(
    stableUuid(`agent-run-attempt:coder:${identity.digest}:1`),
  );

  try {
    const result = await measureAppend(() => input.store!.acceptCommand({
      command,
      payloadHash: hashControlPlanePayload(command.payload),
      // Before this contract was stabilized, the first POST /messages was
      // persisted as `start` and later messages as `send_message`. Canonical
      // non-resume requests are now always `send_message`, but an old first
      // message must still win the same idempotency key during rolling upgrade.
      idempotencyKindAliases: input.kind === 'send_message' ? ['start'] : undefined,
      linkedAgentRunId: input.linkedAgentRunId,
      run: input.createRun
        ? {
            agentRunId,
            attemptId,
            role: input.role,
            agentDefinitionId: input.agentDefinitionId,
            waitMode: 'foreground',
            requestedProvider: input.requestedProvider,
            requestedModel: input.requestedModel,
            requestedReasoningEffort: input.requestedReasoningEffort,
            requestedPreset: input.requestedPreset,
            requestedCapabilityProfile: input.requestedCapabilityProfile,
            executorOwnerId: `coder-worker:${input.sessionId}:${agentRunId}`,
            executorExpiresAt: new Date(Date.parse(requestedAt) + EXECUTOR_LEASE_MS).toISOString(),
          }
        : undefined,
    }), 'acceptCommand');

    if (result.kind === 'accepted') {
      metrics.accepted += 1;
      recordMirrored('A', input.createRun ? 2 : 1);
    }
    else if (result.kind === 'existing') metrics.existing += 1;
    else if (result.kind === 'payload_conflict') metrics.payloadConflicts += 1;
    else metrics.versionConflicts += 1;

    if (result.kind === 'payload_conflict' || result.kind === 'version_conflict') {
      console.warn('[control-plane] command rejected', {
        sessionId: input.sessionId,
        kind: input.kind,
        outcome: result.kind,
      });
      return {
        outcome: result.kind,
        ...('command' in result ? { commandStatus: result.command.status } : {}),
        ...('command' in result && result.command.reasonCode
          ? { commandReasonCode: result.command.reasonCode }
          : {}),
        ...('command' in result && result.command.agentRunId
          ? { agentRunId: result.command.agentRunId }
          : {}),
        ...('command' in result && commandExecutionBusId(result.command)
          ? { executionBusId: commandExecutionBusId(result.command) }
          : {}),
      };
    }

    // A compatibility alias may return an older `start` row whose generated
    // command/correlation ids differ from the new `send_message` identity.
    // Every follow-up write must target the persisted winner, never the
    // uninserted canonical candidate.
    const persistedCommand = result.command;
    const commandContext: ControlPlaneCommandContext = {
      sessionId: persistedCommand.sessionId,
      commandId: persistedCommand.commandId,
      correlationId: persistedCommand.correlationId,
      actor: persistedCommand.actor,
    };
    const runContext = input.createRun
      && result.agentRun
      && result.attempt
      && result.attempt.status !== 'terminal'
      && result.attempt.executorLease.status === 'active'
      ? {
          ...commandContext,
          agentRunId: result.agentRun.agentRunId,
          attemptId: result.attempt.attemptId,
          executorOwnerId: result.attempt.executorLease.ownerId,
          fencingEpoch: result.attempt.executorLease.fencingEpoch,
        }
      : undefined;
    return {
      outcome: result.kind,
      commandStatus: result.command.status,
      ...(result.command.reasonCode ? { commandReasonCode: result.command.reasonCode } : {}),
      ...(result.command.agentRunId ? { agentRunId: result.command.agentRunId } : {}),
      ...(commandExecutionBusId(result.command)
        ? { executionBusId: commandExecutionBusId(result.command) }
        : {}),
      commandContext,
      runContext,
    };
  } catch (error) {
    metrics.writeErrors += 1;
    console.warn(
      `[control-plane] command accept failed session=${input.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export async function acceptLocalCompanyCommand(input: {
  store?: ControlPlaneAuthority | null;
  companySessionId: string;
  kind: Extract<SessionCommandKind, 'start' | 'resume'>;
  idempotencyKey?: string | null;
  fingerprint: Record<string, unknown>;
  requestedAt?: string;
}): Promise<LocalCoderShadowAcceptance | null> {
  if (!input.store) return null;
  const requestedAt = input.requestedAt ?? new Date().toISOString();
  const key = input.idempotencyKey ?? `server:${randomUUID()}`;
  const identity = digest(`company:${input.companySessionId}:${input.kind}:${key}`);
  const sessionId = asSessionId(input.companySessionId);
  const commandId = asSessionCommandId(
    stableUuid(`command:company:${identity}`),
  );
  const correlationId = asCorrelationId(
    stableUuid(`correlation:company:${identity}`),
  );
  const actor = {
    actorId: 'local-user',
    actorType: 'user' as const,
    source: 'company' as const,
  };
  const command: SessionCommand<Record<string, unknown>> = {
    schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
    commandId,
    idempotencyKey: key,
    kind: input.kind,
    sessionId,
    actor,
    requestedAt,
    correlationId,
    payload: input.fingerprint,
  };
  try {
    const result = await measureAppend(() => input.store!.acceptCommand({
      command,
      payloadHash: hashControlPlanePayload(command.payload),
    }), 'acceptCommand');
    if (result.kind === 'payload_conflict' || result.kind === 'version_conflict') {
      return {
        outcome: result.kind,
        ...('command' in result ? { commandStatus: result.command.status } : {}),
        ...('command' in result && result.command.reasonCode
          ? { commandReasonCode: result.command.reasonCode }
          : {}),
      };
    }
    const commandContext: ControlPlaneCommandContext = {
      sessionId,
      commandId,
      correlationId,
      actor,
    };
    return {
      outcome: result.kind,
      commandStatus: result.command.status,
      ...(result.command.reasonCode ? { commandReasonCode: result.command.reasonCode } : {}),
      ...(commandExecutionBusId(result.command)
        ? { executionBusId: commandExecutionBusId(result.command) }
        : {}),
      commandContext,
    };
  } catch (error) {
    metrics.writeErrors += 1;
    console.warn(
      `[control-plane] company command accept failed session=${input.companySessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export async function bindLocalCommandBus(
  store: ControlPlaneAuthority | null | undefined,
  acceptance: LocalCoderShadowAcceptance | null,
  busId: string,
): Promise<boolean> {
  if (!store || !acceptance?.commandContext) return false;
  try {
    await measureAppend(
      () => store.bindCommandExecution(acceptance.commandContext!, busId),
      'bindCommandExecution',
    );
    acceptance.commandStatus = 'running';
    acceptance.executionBusId = busId;
    return true;
  } catch (error) {
    metrics.writeErrors += 1;
    console.warn(
      `[control-plane] command bus binding failed command=${acceptance.commandContext.commandId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

export async function terminalizeLocalCoderCommand(
  store: ControlPlaneAuthority | null | undefined,
  acceptance: LocalCoderShadowAcceptance | null,
  input: { status: 'succeeded' | 'failed' | 'cancelled'; reason: string; errorRef?: string },
): Promise<void> {
  // Command terminal state is part of idempotency authority, not a shadow
  // projection. Callers await it so a racing retry observes terminal state
  // before any side-effect path can be re-entered.
  if (!store || !acceptance?.commandContext) return;
  try {
    await measureAppend(() => store.terminalizeCommand({
      context: acceptance.commandContext!,
      status: input.status,
      reason: input.reason,
      errorRef: input.errorRef,
      // Check under the authority queue, not in a preceding snapshot read:
      // the worker may commit its terminal between that read and this write.
      preserveExistingTerminal: true,
    }), 'terminalizeCommand');
    const current = acceptance.runContext
      ? (await store.getAttemptState(acceptance.runContext, false)).command : undefined;
    if (current && current.commandId !== acceptance.commandContext.commandId) throw new Error('Terminal command identity differs');
    acceptance.commandStatus = current?.status ?? input.status;
    acceptance.commandReasonCode = current?.reasonCode ?? input.reason;
    recordMirrored('A');
  } catch (error) {
    metrics.lifecycleErrors += 1;
    console.warn(
      `[control-plane] command terminalization failed command=${acceptance.commandContext.commandId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function markLocalCoderRunStarted(
  store: ControlPlaneAuthority | null | undefined,
  context: ControlPlaneRunContext | null | undefined,
  runnerRunId?: string,
): Promise<void> {
  if (!store || !context) return;
  // This transition establishes runner_run_id → AgentRun resolution used by
  // child fencing. It is authority, not observational journal traffic, so it
  // must be committed before a following tool/subagent event can overtake it.
  try {
    await measureAppend(
      () => store.markRunStarted(context, runnerRunId),
      'markRunStarted',
    );
    metrics.runsStarted += 1;
    recordMirrored('C');
  } catch (error) {
    metrics.lifecycleErrors += 1;
    console.warn(
      `[control-plane-agent-run] start failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function renewLocalCoderRunLease(
  store: ControlPlaneAuthority | null | undefined,
  context: ControlPlaneRunContext | null | undefined,
  at = new Date().toISOString(),
): Promise<boolean> {
  if (!store || !context) return false;
  try {
    await measureAppend(() => store.renewAttemptLease(
        context,
        new Date(Date.parse(at) + EXECUTOR_LEASE_MS).toISOString(),
        at,
      ), 'renewAttemptLease');
    metrics.leaseRenewals += 1;
    return true;
  } catch (error) {
    metrics.lifecycleErrors += 1;
    console.warn(
      `[control-plane-agent-run] lease renewal failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

export function mirrorLocalCoderToolBoundary(
  store: ControlPlaneAuthority | null | undefined,
  context: ControlPlaneRunContext | null | undefined,
  input: {
    phase: 'started' | 'completed';
    toolUseId: string;
    toolName: string;
    value?: unknown;
    durationMs?: number;
  },
): Promise<void> {
  if (!store || !context || !coderRuntimeJournalShadowEnabled()) return Promise.resolve();
  // Reduce before enqueueing: the backlog must never retain raw tool input or
  // result objects, even transiently. This mirrors ClaudeOpen's hook/event
  // boundary, where transport carries metadata rather than capability data.
  const valueHash = opaqueValueHash(input.value);
  const durationMs = input.durationMs ?? null;
  const phase = input.phase;
  const toolUseId = input.toolUseId;
  const toolName = input.toolName;
  return enqueueShadowWrite(`tool-${input.phase}`, async () => {
    await store.appendToolBoundary({
      context,
      toolUseId,
      toolName,
      phase,
      payload: {
        valueHash,
        durationMs,
      },
    });
    metrics.toolBoundaries += 1;
    recordMirrored('B');
  });
}

/**
 * Generic lifecycle mirror for the extended A–C runner vocabulary (approvals,
 * interactions, provider/compaction transitions, workflow/agents/worktree).
 * Payloads must already be reduced to ids/hashes/counts by the caller — the
 * redaction metadata records exactly which keys were projected.
 */
export function mirrorLocalCoderLifecycleEvent(
  store: ControlPlaneAuthority | null | undefined,
  context: ControlPlaneRunContext | null | undefined,
  input: {
    type: ControlPlaneEventType;
    payload: Record<string, unknown>;
    idempotencyKey?: string;
    occurredAt?: string;
  },
): Promise<void> {
  if (!store || !context || !coderRuntimeJournalShadowEnabled()) return Promise.resolve();
  // Compute hashes before enqueueing so the closure holds only the redacted,
  // bounded projection and stable identity — never the raw worker payload.
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const eventClass = runtimeEventClass(input.type);
  const eventKey = input.idempotencyKey ?? opaqueValueHash(input.payload);
  return enqueueShadowWrite(`lifecycle:${input.type}`, async () => {
    await store.appendRuntimeEvent({
        schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
        eventId: asRuntimeEventId(
          stableUuid(`evt:${context.agentRunId}:${input.type}:${eventKey}`),
        ),
        eventClass,
        partitionKey: context.sessionId,
        sessionId: context.sessionId,
        commandId: context.commandId,
        agentRunId: context.agentRunId,
        attemptId: context.attemptId,
        causationId: context.commandId,
        correlationId: context.correlationId,
        type: input.type,
        occurredAt,
        actor: context.actor,
        payload: input.payload,
        idempotencyKey: `lifecycle:${context.agentRunId}:${input.type}:${eventKey}`,
        redaction: { policyVersion: 'control-plane-shadow-v1', fields: Object.keys(input.payload), secretRefs: [] },
    });
    recordMirrored(eventClass);
  });
}

function terminalStatus(input: {
  event: 'done' | 'error';
  data: unknown;
  mode?: 'normal' | 'worker_crash' | 'worker_start_failure' | 'evicted' | 'authority_lost';
}): {
  runStatus: 'completed' | 'failed' | 'aborted' | 'interrupted';
  commandStatus: 'succeeded' | 'failed' | 'cancelled';
  reason: string;
  errorRef?: string;
  leaseStatus: 'released' | 'fenced';
} {
  const data = input.data && typeof input.data === 'object'
    ? input.data as Record<string, unknown>
    : {};
  const reason = typeof data.reason === 'string'
    ? data.reason
    : input.mode === 'worker_crash'
      ? 'worker-crashed'
      : input.mode === 'worker_start_failure'
        ? 'worker-runFresh-failed'
      : input.mode === 'evicted'
        ? 'worker-evicted'
        : input.mode === 'authority_lost'
          ? 'control-plane-authority-lost'
        : input.event === 'error'
          ? 'error'
          : 'completed';
  const rawError = typeof data.error === 'string'
    ? data.error
    : typeof data.message === 'string'
      ? data.message
      : undefined;
  const errorRef = rawError ? `error:sha256:${digest(rawError)}` : undefined;

  if (
    input.mode === 'worker_crash'
    || input.mode === 'worker_start_failure'
    || input.mode === 'evicted'
    || input.mode === 'authority_lost'
  ) {
    return { runStatus: 'interrupted', commandStatus: 'failed', reason, errorRef, leaseStatus: 'fenced' };
  }
  const terminal = classifyCoderTerminalOutcome({
    event: input.event,
    reason,
    error: data.error,
    message: data.message,
  });
  if (terminal.classification === 'cancelled') {
    return { runStatus: 'aborted', commandStatus: 'cancelled', reason, errorRef, leaseStatus: 'released' };
  }
  if (terminal.classification === 'interrupted') {
    return { runStatus: 'interrupted', commandStatus: 'failed', reason, errorRef, leaseStatus: 'released' };
  }
  if (terminal.classification === 'failed') {
    return { runStatus: 'failed', commandStatus: 'failed', reason, errorRef, leaseStatus: 'released' };
  }
  return { runStatus: 'completed', commandStatus: 'succeeded', reason, errorRef, leaseStatus: 'released' };
}

export async function terminalizeLocalCoderRun(
  store: ControlPlaneAuthority | null | undefined,
  context: ControlPlaneRunContext | null | undefined,
  input: {
    event: 'done' | 'error';
    data: unknown;
    mode?: 'normal' | 'worker_crash' | 'worker_start_failure' | 'evicted' | 'authority_lost';
  },
): Promise<void> {
  if (!store || !context) return;
  const terminal = terminalStatus(input);
  const terminalInput = {
      context,
      status: terminal.runStatus,
      commandStatus: terminal.commandStatus,
      reason: terminal.reason,
      errorRef: terminal.errorRef,
      attemptLeaseStatus: terminal.leaseStatus,
  };
  // Run + command terminal state is idempotency authority. CoderWorkerPool
  // marks/publishes the bus terminal first, then callers await this authority
  // commit before admitting a retry.
  try {
    await measureAppend(async () => {
      if (
        input.mode === 'worker_crash'
        || input.mode === 'worker_start_failure'
        || input.mode === 'evicted'
        || input.mode === 'authority_lost'
      ) {
        await store.interruptRun(terminalInput);
      } else {
        await store.terminalizeRun(terminalInput);
      }
    }, 'terminalizeRun');
    metrics.runsTerminalized += 1;
    recordMirrored('A');
    recordMirrored('C');
  } catch (error) {
    metrics.lifecycleErrors += 1;
    console.warn(
      `[control-plane-agent-run] terminalization failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
