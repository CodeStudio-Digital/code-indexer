import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { agentV1Capability } from '@mcp/agent-runtime-contracts';
import type {
  ResolvedCapabilitySet,
} from '@mcp/agent-runtime-contracts';
import type {
  AuthorityClock,
  CapabilityDecisionResolver,
  CapabilityGatewayLimits,
  HostCapabilityExecutionOutcome,
  HostCapabilityExecutor,
  HostDataBoundContext,
  ValidatedCapabilityPrepare,
} from '@mcp/agent-runtime-host';
import { CapabilityGateway, nativeToolUseId } from '@mcp/agent-runtime-host';
import { deriveCapabilityDescriptor } from '../core/capability-catalog.js';
import { isExplicitlyParallelSafeRead } from '../core/policy.js';
import { resolveRegisteredToolOutputPolicy } from '../core/tool-output-policy.js';
import type { ToolContext, ToolResult } from '../core/tool.js';
import { finalizeToolOutput } from '../core/runner/pure-helpers.js';
import type { ToolRegistry } from '../core/registry.js';
import type { HostEffectScope } from './host-effect-scope.js';
import { resolveHostCapabilityDigest, type HostCapabilitySnapshot } from './host-capability-snapshot.js';
import type { NativeGoalMutation } from '@mcp/session-storage/native-goal-projection.js';
import { NativeInvocationBudget, NativeNestedCapabilities, type NativeToolCallBudget } from './native-nested-capabilities.js';
import { ToolCallLedger } from '../core/tool-call-ledger.js';
import { boundedToolResultData } from './bounded-tool-result-data.js';
import { hasOwnedCancellationReceipt, settleOwnedCancellation } from './native-cancellation-settlement.js';

export const HOST_TOOL_RESULT_SCHEMA_ID = 'codestudio.tool-result.v1';
export const HOST_TOOL_RESULT_SCHEMA_VERSION = 1;

const DEFAULT_MAXIMUM_ENCODED_RESULT_BYTES = 1024 * 1024;
const DEFAULT_MAXIMUM_INLINE_CHARS = 128 * 1024;
const MAXIMUM_DURATION_MS = 24n * 60n * 60n * 1_000n;
const MAXIMUM_JSON_DEPTH = 64;
const MAXIMUM_JSON_NODES = 100_000;

interface ExecutableEntry {
  readonly toolName: string;
  readonly capabilityId: string;
  readonly version: string;
  readonly mutates: boolean;
  readonly requiresFence: boolean;
  readonly mayHaveEffects: boolean;
  readonly parallelSafe: boolean;
}

export interface HostToolExecutionPayload {
  readonly structuredData?: unknown;
  readonly content: string;
  readonly isError: boolean;
  readonly contentFormat?: 'text' | 'markdown' | 'json';
  readonly extraUserMessageHex?: string;
  readonly nativeGoal?: NativeGoalMutation;
  readonly nativeTasks?: import('@mcp/session-storage/native-task-projection.js').NativeTaskMutation;
  readonly nativeWorktreeTransition?: import('../ports/worktree-transition-port.js').NativeWorktreeTransition;
  readonly error?: {
    readonly code?: string;
    readonly kind?: string;
    readonly retryable?: boolean;
    readonly suggestedAction?: string;
  };
  readonly transport: {
    readonly structuredDataOmitted?: 'invalid' | 'too_large';
    readonly truncated: boolean;
    readonly originalBytes: number;
    readonly outputId?: string;
  };
}

export interface ToolRegistryHostCapabilityExecutorOptions {
  /** Product proof that an owned question closed before any answer was delivered.
   * This cannot be inferred from an error string or a model/tool assertion. */
  readonly cancelledQuestionWithoutResponse?: (request: ValidatedCapabilityPrepare, toolName: string) => boolean;
  readonly invocationBudget?: NativeToolCallBudget;
  readonly bindNested?: (request: ValidatedCapabilityPrepare) => ToolContext['nestedCapabilityDispatch'];
  /** Membership must already be frozen for this AgentRunAttempt. */
  readonly registry: ToolRegistry;
  /** Exact set persisted for the attempt, including catalog-only skills. */
  readonly capabilitySet: ResolvedCapabilitySet;
  /** Exact product-generated protobuf snapshot hydrated into the Rust runner. */
  readonly wireSnapshot?: HostCapabilitySnapshot;
  /** Attempt-scoped ports, fences, output store and lifecycle callbacks. */
  readonly toolContext: ToolContext;
  readonly effects?: HostEffectScope;
  /** Revalidate the product policy/resource seal immediately before dispatch. */
  readonly validateGrant?: (request: ValidatedCapabilityPrepare,
    grant: agentV1Capability.SealedExecutionGrant) => Promise<void>;
  readonly nowUnixMs?: () => bigint;
  readonly maximumEncodedResultBytes?: number;
  readonly maximumInlineChars?: number;
  /** Durable accounting hook for usage, extra blocks and full pre-cap results. */
  readonly commitResult?: (input: {
    readonly request: ValidatedCapabilityPrepare;
    readonly grant: agentV1Capability.SealedExecutionGrant;
    readonly toolName: string;
    readonly result: ToolResult;
  }) => void | HostToolResultCommit | Promise<void | HostToolResultCommit>;
}

export interface HostToolResultCommit {
  extraUserMessageHex?: string;
  nativeGoal?: NativeGoalMutation;
  nativeTasks?: import('@mcp/session-storage/native-task-projection.js').NativeTaskMutation;
  nativeWorktreeTransition?: import('../ports/worktree-transition-port.js').NativeWorktreeTransition;
}

export type ToolRegistryCapabilityDecisionResolverFactory = (
  context: HostDataBoundContext,
  clock: AuthorityClock,
) => CapabilityDecisionResolver;

export interface ToolRegistryCapabilityGatewayFactoryOptions
extends Omit<ToolRegistryHostCapabilityExecutorOptions, 'nowUnixMs'> {
  readonly maximumToolCalls?: number;
  /**
   * Product-owned policy authority. The adapter never manufactures an allow
   * decision: policy/approval must resolve before the executor can run.
   */
  readonly decisionResolverFactory: ToolRegistryCapabilityDecisionResolverFactory;
  readonly gatewayLimits?: CapabilityGatewayLimits;
  /** Version stamped on snapshot-firewall rejections before policy runs. */
  readonly snapshotPolicyVersion?: string;
}

export type ToolRegistryCapabilityGatewayFactory = (
  context: HostDataBoundContext,
  clock: AuthorityClock,
) => CapabilityGateway;

/**
 * Production composition point for the Rust attempt data adapter. It binds a
 * sealed ToolRegistry, its exact capability-set digest, the product decision
 * authority and the Host executor into one attempt-local CapabilityGateway.
 */
export function createToolRegistryCapabilityGatewayFactory(
  options: ToolRegistryCapabilityGatewayFactoryOptions,
): ToolRegistryCapabilityGatewayFactory {
  const snapshot = createAttemptSnapshotGuard(options.registry, options.capabilitySet, options.wireSnapshot);
  const localBudget = new NativeInvocationBudget(options.maximumToolCalls);
  const budget: NativeToolCallBudget = { take: () => localBudget.take() && (options.invocationBudget?.take() ?? true) };
  const toolContext = { ...options.toolContext,
    toolCallLedger: options.toolContext.toolCallLedger ?? new ToolCallLedger() };
  const snapshotPolicyVersion = boundedIdentifier(
    options.snapshotPolicyVersion ?? 'capability-snapshot/v1',
    'snapshotPolicyVersion',
  );
  return (context, clock) => {
    if (context.identity.agentRunId !== options.capabilitySet.agentRunId) {
      throw new Error('Host data attempt identity diverges from the ToolRegistry capability set');
    }
    const authority = options.decisionResolverFactory(context, clock);
    let nested: NativeNestedCapabilities | undefined;
    if (options.registry.has('code_exec') || options.registry.has('self_review')) {
      if (!options.effects || !options.validateGrant) throw new Error('Native nested calls require owned effects and policy grants');
      nested = new NativeNestedCapabilities({ registry: options.registry, capabilitySet: options.capabilitySet,
        resolver: authority, validateGrant: options.validateGrant, effects: options.effects, budget, now: () => clock.now() });
    }
    const guardedAuthority: CapabilityDecisionResolver = {
      retire: (request, decision) => { nested?.retire(request); authority.retire?.(request, decision); },
      async resolve(request) {
        if (!snapshot.accepts(request)) {
          return {
            case: 'rejected',
            value: create(agentV1Capability.CapabilityRejectedSchema, {
              decisionId: `decision/snapshot/${randomUUID()}`,
              reasonCode: 'host_capability_not_in_attempt_snapshot',
              policyVersion: snapshotPolicyVersion,
              decidedAtUnixMs: clock.now(),
            }),
          };
        }
        return authority.resolve(request);
      },
    };
    const executor = new ToolRegistryHostCapabilityExecutor({
      registry: options.registry,
      capabilitySet: options.capabilitySet,
      wireSnapshot: options.wireSnapshot,
      toolContext,
      invocationBudget: budget,
      bindNested: request => nested?.bind(request),
      effects: options.effects,
      cancelledQuestionWithoutResponse: options.cancelledQuestionWithoutResponse,
      validateGrant: options.validateGrant,
      nowUnixMs: () => clock.now(),
      ...(options.maximumEncodedResultBytes === undefined
        ? {}
        : { maximumEncodedResultBytes: options.maximumEncodedResultBytes }),
      ...(options.maximumInlineChars === undefined
        ? {}
        : { maximumInlineChars: options.maximumInlineChars }),
      ...(options.commitResult === undefined ? {} : { commitResult: options.commitResult }),
    });
    return new CapabilityGateway(
      context,
      guardedAuthority,
      () => clock.now(),
      options.gatewayLimits,
      executor,
    );
  };
}

/**
 * Executes the immutable ToolRegistry snapshot behind the Rust
 * `HostCapability` port. MCP, plugins, indexer and native host tools already
 * converge on `CoderTool`; this adapter keeps that one dispatch authority
 * instead of rebuilding an executor per source.
 */
export class ToolRegistryHostCapabilityExecutor implements HostCapabilityExecutor {
  readonly #entries = new Map<string, ExecutableEntry>();
  readonly #capabilitySetDigest: Uint8Array;
  readonly #eligible: ReadonlySet<string>;
  readonly #nowUnixMs: () => bigint;
  readonly #maximumEncodedResultBytes: number;
  readonly #maximumInlineChars: number;

  constructor(readonly options: ToolRegistryHostCapabilityExecutorOptions) {
    if (!options.registry.isSealed) {
      throw new Error('HostCapability executor requires a sealed ToolRegistry attempt snapshot');
    }
    decodeSha256(options.capabilitySet.hash);
    this.#capabilitySetDigest = resolveHostCapabilityDigest(options.registry, options.capabilitySet, options.wireSnapshot);
    this.#eligible = new Set(options.capabilitySet.eligible.filter((id) =>
      !options.wireSnapshot || options.capabilitySet.visible.includes(id)));
    this.#nowUnixMs = options.nowUnixMs ?? (() => BigInt(Date.now()));
    this.#maximumEncodedResultBytes = boundedPositiveInteger(
      options.maximumEncodedResultBytes,
      DEFAULT_MAXIMUM_ENCODED_RESULT_BYTES,
      1_024,
      DEFAULT_MAXIMUM_ENCODED_RESULT_BYTES,
      'maximumEncodedResultBytes',
    );
    this.#maximumInlineChars = boundedPositiveInteger(
      options.maximumInlineChars,
      Math.min(
        DEFAULT_MAXIMUM_INLINE_CHARS,
        Math.max(64, Math.floor(this.#maximumEncodedResultBytes / 8)),
      ),
      64,
      Math.max(64, Math.floor(this.#maximumEncodedResultBytes / 8)),
      'maximumInlineChars',
    );

    const registered = new Set(options.capabilitySet.registered);
    for (const tool of options.registry.list()) {
      const descriptor = deriveCapabilityDescriptor(tool).descriptor;
      if (!registered.has(descriptor.capabilityId)) {
        throw new Error(
          `ToolRegistry capability '${descriptor.capabilityId}' is absent from the sealed capability set`,
        );
      }
      if (this.#entries.has(descriptor.capabilityId)) {
        throw new Error(`Duplicate executable capability '${descriptor.capabilityId}'`);
      }
      this.#entries.set(descriptor.capabilityId, Object.freeze({
        toolName: tool.name,
        capabilityId: descriptor.capabilityId,
        version: descriptor.version,
        mutates: descriptor.execution.mutates,
        parallelSafe: isExplicitlyParallelSafeRead(tool),
        requiresFence: descriptor.execution.mutates
          || descriptor.execution.class !== 'read'
          || tool.effectBoundary !== undefined,
        mayHaveEffects: descriptor.execution.mutates
          || descriptor.execution.class !== 'read'
          || tool.effectBoundary !== undefined,
      }));
    }
  }

  isParallelSafe(request: ValidatedCapabilityPrepare): boolean {
    const entry = this.#entries.get(request.capabilityId);
    return entry?.parallelSafe === true && this.#eligible.has(request.capabilityId)
      && entry.version === request.capabilityVersion && !request.mutates
      && request.executionClass === agentV1Capability.CapabilityExecutionClass.HOST_CAPABILITY
      && sameDigest(request.capabilitySetSha256, this.#capabilitySetDigest);
  }

  async execute(
    request: ValidatedCapabilityPrepare,
    grant: agentV1Capability.SealedExecutionGrant,
  ): Promise<HostCapabilityExecutionOutcome> {
    const startedAt = this.#nowUnixMs();
    const entry = this.#entries.get(request.capabilityId);
    if (!entry
      || !this.#eligible.has(request.capabilityId)
      || request.capabilityVersion !== entry.version
      || request.mutates !== entry.mutates
      || request.executionClass
        !== agentV1Capability.CapabilityExecutionClass.HOST_CAPABILITY
      || !sameDigest(request.capabilitySetSha256, this.#capabilitySetDigest)) {
      return this.#failed('host_capability_not_in_attempt_snapshot', startedAt);
    }
    if (entry.requiresFence && !this.options.toolContext.mutationFence) {
      return this.#failed('host_mutation_fence_unavailable', startedAt);
    }
    if (request.deadlineAtUnixMs <= this.#nowUnixMs()) {
      return this.#cancelled('host_capability_deadline_elapsed', startedAt);
    }

    let args: Record<string, unknown>;
    try {
      args = decodeJsonObject(request.encodedJsonInput);
    } catch {
      return this.#failed('host_capability_input_invalid', startedAt);
    }

    const controller = new AbortController();
    const parentSignal = this.options.toolContext.signal;
    if (parentSignal?.aborted) {
      return this.#cancelled('host_capability_parent_cancelled', startedAt);
    }
    let abortReason: 'deadline' | 'parent' | undefined;
    const onParentAbort = (): void => {
      abortReason = 'parent';
      controller.abort(parentSignal?.reason);
    };
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    const remainingMs = request.deadlineAtUnixMs - this.#nowUnixMs();
    const timer = setTimeout(() => {
      abortReason = 'deadline';
      controller.abort(new Error('HostCapability deadline elapsed'));
    }, Number(remainingMs > BigInt(2_147_483_647) ? 2_147_483_647n : remainingMs));

    const context: ToolContext = {
      ...this.options.toolContext,
      currentToolUseId: nativeToolUseId(request.identity.attemptId, request.providerOperationId, request.toolUseId),
      signal: controller.signal,
    };
    let dispatched = false;
    try {
      await this.options.validateGrant?.(request, grant);
      if (controller.signal.aborted) return this.#cancelled('host_capability_cancelled_before_dispatch', startedAt);
      if (this.options.invocationBudget && !this.options.invocationBudget.take()) return this.#failed('max_tool_calls', startedAt);
      if (entry.toolName === 'code_exec' || entry.toolName === 'self_review') {
        const nested = this.options.bindNested?.(request);
        if (!nested) return this.#failed('host_nested_capability_authority_unavailable', startedAt);
        context.nestedCapabilityDispatch = nested;
      }
      dispatched = true;
      const invoke = () => this.options.registry.invoke(entry.toolName, args, context);
      const invocation = this.options.effects ? this.options.effects.track(invoke) : invoke();
      const settled = await Promise.race([
        invocation.then((result) => ({ case: 'result' as const, result })),
        aborted(controller.signal).then(() => ({ case: 'aborted' as const })),
      ]);
      if (settled.case === 'aborted') {
        void invocation.catch(() => undefined);
        const reason = abortReason === 'deadline'
          ? 'host_capability_deadline_after_dispatch'
          : 'host_capability_cancelled_after_dispatch';
        const unansweredQuestion = (entry.toolName === 'ask_user' || entry.toolName === 'decision_gate')
          && this.options.cancelledQuestionWithoutResponse?.(request, entry.toolName) === true;
        // Only an owned, settled operation can prove cancellation safe. Review
        // bookkeeping must be durably closed; an abort alone proves nothing.
        const cancellationSettled = await settleOwnedCancellation(entry.toolName, context, invocation);
        return entry.mayHaveEffects && !unansweredQuestion && !cancellationSettled
          ? this.#unknown(reason, startedAt)
          : this.#cancelled(reason, startedAt);
      }

      if (settled.result.effectOutcome === 'unknown') {
        return this.#unknown('host_capability_effect_unconfirmed', startedAt);
      }
      let extra: void | HostToolResultCommit;
      try {
        extra = await this.options.commitResult?.({
          request,
          grant,
          toolName: entry.toolName,
          result: settled.result,
        });
      } catch {
        return entry.mayHaveEffects
          ? this.#unknown('host_capability_result_commit_ambiguous', startedAt)
          : this.#failed('host_capability_result_commit_failed', startedAt);
      }
      if (settled.result.extraUserBlocks?.length && !extra?.extraUserMessageHex) {
        return entry.mayHaveEffects ? this.#unknown('host_capability_extra_content_not_committed', startedAt)
          : this.#failed('host_capability_extra_content_not_committed', startedAt);
      }
      return await this.#succeeded(entry.toolName, settled.result, startedAt, extra);
    } catch {
      if (controller.signal.aborted && hasOwnedCancellationReceipt(entry.toolName, context)) {
        return this.#cancelled('host_owned_operation_cancelled', startedAt);
      }
      return dispatched && entry.mayHaveEffects
        ? this.#unknown('host_capability_executor_ambiguous', startedAt)
        : this.#failed('host_capability_executor_failed', startedAt);
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    }
  }

  async #succeeded(
    toolName: string,
    result: ToolResult,
    startedAt: bigint,
    extra?: void | HostToolResultCommit,
  ): Promise<HostCapabilityExecutionOutcome> {
    const policy = resolveRegisteredToolOutputPolicy(
      toolName,
      this.options.registry.get(toolName),
    );
    const finalized = finalizeToolOutput({
      toolName,
      rawContent: result.content,
      shapedContent: result.content,
      isError: result.isError === true,
      cap: this.#maximumInlineChars,
      store: this.options.toolContext.toolOutputStore,
      sourceTruncations: result.sourceTruncations,
      policy,
    });
    // A recovery ID is a promise of durable content. Finalization may have
    // created the spill after commitResult, so drain before returning its ACK.
    await this.options.toolContext.toolOutputStore?.drain?.();
    const sourceTruncated = (result.sourceTruncations?.length ?? 0) > 0;
    const structured = boundedToolResultData(result.structuredData, Math.min(64 * 1024, Math.floor(this.#maximumEncodedResultBytes / 4)));
    const payload: HostToolExecutionPayload = {
      content: finalized.content,
      isError: result.isError === true,
      ...(structured.structuredData !== undefined ? { structuredData: structured.structuredData } : {}),
      ...(extra?.extraUserMessageHex ? { extraUserMessageHex: extra.extraUserMessageHex } : {}),
      ...(extra?.nativeGoal ? { nativeGoal: extra.nativeGoal } : {}),
      ...(extra?.nativeTasks ? { nativeTasks: extra.nativeTasks } : {}),
      ...(extra?.nativeWorktreeTransition ? { nativeWorktreeTransition: extra.nativeWorktreeTransition } : {}),
      ...(result.contentFormat ? { contentFormat: result.contentFormat } : {}),
      ...(result.error ? {
        error: {
          ...(result.error.code ? { code: boundedText(result.error.code) } : {}),
          ...(result.error.kind ? { kind: boundedText(result.error.kind) } : {}),
          ...(typeof result.error.retryable === 'boolean'
            ? { retryable: result.error.retryable }
            : {}),
          ...(result.error.suggestedAction
            ? { suggestedAction: boundedText(result.error.suggestedAction) }
            : {}),
        },
      } : {}),
      transport: {
        ...(structured.structuredDataOmitted ? { structuredDataOmitted: structured.structuredDataOmitted } : {}),
        truncated: finalized.truncated === true || sourceTruncated,
        originalBytes: Buffer.byteLength(result.content, 'utf8'),
        ...(finalized.outputId ? { outputId: boundedText(finalized.outputId) } : {}),
      },
    };
    const encodedResult = Buffer.from(JSON.stringify(payload), 'utf8');
    if (encodedResult.byteLength > this.#maximumEncodedResultBytes) {
      return this.#failed('host_capability_output_budget_exceeded', startedAt);
    }
    return {
      case: 'succeeded',
      schemaId: HOST_TOOL_RESULT_SCHEMA_ID,
      schemaVersion: HOST_TOOL_RESULT_SCHEMA_VERSION,
      encodedResult,
      bytesRead: BigInt(payload.transport.originalBytes),
      truncated: payload.transport.truncated,
      durationMs: this.#duration(startedAt),
    };
  }

  #failed(reasonCode: string, startedAt: bigint): HostCapabilityExecutionOutcome {
    return { case: 'failed', reasonCode, durationMs: this.#duration(startedAt) };
  }

  #cancelled(reasonCode: string, startedAt: bigint): HostCapabilityExecutionOutcome {
    return { case: 'cancelled', reasonCode, durationMs: this.#duration(startedAt) };
  }

  #unknown(reasonCode: string, startedAt: bigint): HostCapabilityExecutionOutcome {
    return { case: 'outcomeUnknown', reasonCode, durationMs: this.#duration(startedAt) };
  }

  #duration(startedAt: bigint): bigint {
    const duration = this.#nowUnixMs() - startedAt;
    if (duration <= 0n) return 0n;
    return duration > MAXIMUM_DURATION_MS ? MAXIMUM_DURATION_MS : duration;
  }
}

export function decodeHostToolExecutionPayload(
  encoded: Uint8Array,
): HostToolExecutionPayload {
  const decoded = decodeJsonObject(encoded);
  if (typeof decoded.content !== 'string'
    || typeof decoded.isError !== 'boolean'
    || !decoded.transport
    || typeof decoded.transport !== 'object'
    || Array.isArray(decoded.transport)) {
    throw new Error('invalid host tool execution payload');
  }
  const transport = decoded.transport as Record<string, unknown>;
  if (typeof transport.truncated !== 'boolean'
    || !Number.isSafeInteger(transport.originalBytes)
    || Number(transport.originalBytes) < 0
    || (transport.outputId !== undefined && typeof transport.outputId !== 'string')) {
    throw new Error('invalid host tool execution transport');
  }
  return decoded as unknown as HostToolExecutionPayload;
}

function decodeJsonObject(encoded: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(encoded);
  const value: unknown = JSON.parse(text);
  validateJsonValue(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('JSON object required');
  }
  return value as Record<string, unknown>;
}

function validateJsonValue(root: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    nodes += 1;
    if (nodes > MAXIMUM_JSON_NODES || depth > MAXIMUM_JSON_DEPTH) {
      throw new Error('JSON complexity limit');
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('finite JSON number required');
      continue;
    }
    if (!value || typeof value !== 'object') throw new Error('JSON value required');
    if (Array.isArray(value)) {
      for (const item of value) pending.push({ value: item, depth: depth + 1 });
      continue;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new Error('unsafe JSON key');
      }
      pending.push({ value: item, depth: depth + 1 });
    }
  }
}

function decodeSha256(value: string): Uint8Array {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error('invalid capability set SHA-256');
  return Buffer.from(value, 'hex');
}

function sameDigest(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

function boundedText(value: string): string {
  return value.replaceAll('\0', '').slice(0, 1_024);
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(label);
  }
  return resolved;
}

/** Stable helper used by P3 fixtures and external audit receipts. */
export function hostToolExecutionPayloadSha256(payload: HostToolExecutionPayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function createAttemptSnapshotGuard(
  registry: ToolRegistry,
  capabilitySet: ResolvedCapabilitySet,
  wireSnapshot?: HostCapabilitySnapshot,
): { accepts(request: ValidatedCapabilityPrepare): boolean } {
  if (!registry.isSealed) {
    throw new Error('CapabilityGateway factory requires a sealed ToolRegistry attempt snapshot');
  }
  decodeSha256(capabilitySet.hash);
  const digest = resolveHostCapabilityDigest(registry, capabilitySet, wireSnapshot);
  const eligible = new Set<string>(capabilitySet.eligible.filter((id) => !wireSnapshot || capabilitySet.visible.includes(id)));
  const executable = new Map<string, { version: string; mutates: boolean }>();
  for (const tool of registry.list()) {
    const descriptor = deriveCapabilityDescriptor(tool).descriptor;
    if (!capabilitySet.registered.includes(descriptor.capabilityId)) {
      throw new Error(`Executable capability '${descriptor.capabilityId}' is absent from the attempt snapshot`);
    }
    if (executable.has(descriptor.capabilityId)) {
      throw new Error(`Duplicate executable capability '${descriptor.capabilityId}'`);
    }
    executable.set(descriptor.capabilityId, {
      version: descriptor.version,
      mutates: descriptor.execution.mutates,
    });
  }
  return Object.freeze({
    accepts(request: ValidatedCapabilityPrepare): boolean {
      const expected = executable.get(request.capabilityId);
      return expected !== undefined
        && eligible.has(request.capabilityId)
        && request.capabilityVersion === expected.version
        && request.mutates === expected.mutates
        && request.executionClass
          === agentV1Capability.CapabilityExecutionClass.HOST_CAPABILITY
        && sameDigest(request.capabilitySetSha256, digest);
    },
  });
}

function boundedIdentifier(value: string, label: string): string {
  if (value.length === 0 || value.length > 1_024 || value.includes('\0')) {
    throw new RangeError(label);
  }
  return value;
}
