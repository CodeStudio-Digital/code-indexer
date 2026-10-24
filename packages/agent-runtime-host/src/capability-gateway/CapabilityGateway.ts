import { createHash, timingSafeEqual } from 'node:crypto';
import { toBinary } from '@bufbuild/protobuf';
import { agentV1Capability, agentV1SessionStore } from '@mcp/agent-runtime-contracts';
import { attemptIdentityEqual } from '../ipc/FrameHeaderValidation.js';
import { isEngineBudgetRefusal, isEngineWorkspaceRefusal } from './EngineBudgetRefusal.js';
import { validateCapabilityRetirement } from './CapabilityRetirement.js';
import { validateCapabilityReadBatch } from './CapabilityReadBatchValidation.js';
import type { HostDataBoundContext } from '../ipc/HostDataAttemptChannelValidation.js';
import { CapabilityGatewayError } from './CapabilityGatewayError.js';
import type {
  CapabilityDecisionResolver,
  CapabilityGatewayLimits,
  HostCapabilityExecutor,
} from './CapabilityGatewayTypes.js';
import { DEFAULT_CAPABILITY_GATEWAY_LIMITS } from './CapabilityGatewayTypes.js';
import {
  capabilityResolutionToUpdate,
  validateCapabilityPrepare,
} from './CapabilityGatewayValidation.js';
import {
  ambiguousExecutionResult,
  executionResult,
  validateCapabilityExecute,
} from './CapabilityExecutionValidation.js';

interface PreparedEntry {
  readonly digest: Uint8Array;
  readonly request: ReturnType<typeof validateCapabilityPrepare>;
  readonly result: Promise<agentV1Capability.CapabilityUpdate>;
}

interface ExecutedEntry {
  readonly digest: Uint8Array;
  readonly result: Promise<agentV1Capability.CapabilityExecutionResult>;
}

export class CapabilityGateway {
  readonly #prepared = new Map<string, PreparedEntry>();
  readonly #executed = new Map<string, ExecutedEntry>();
  readonly #retired = new Map<string, Uint8Array>();

  constructor(
    private readonly context: HostDataBoundContext,
    private readonly resolver: CapabilityDecisionResolver,
    private readonly nowUnixMs: () => bigint,
    private readonly limits: CapabilityGatewayLimits = DEFAULT_CAPABILITY_GATEWAY_LIMITS,
    private readonly executor?: HostCapabilityExecutor,
  ) {
    if (!Number.isSafeInteger(limits.maximumPreparedOperations)
      || limits.maximumPreparedOperations <= 0
      || !Number.isSafeInteger(limits.maximumRetiredOperations ?? 100_000)
      || (limits.maximumRetiredOperations ?? 100_000) <= 0
      || !Number.isSafeInteger(limits.maximumInputBytes)
      || limits.maximumInputBytes <= 0
      || !Number.isSafeInteger(limits.maximumOutputBytes)
      || limits.maximumOutputBytes <= 0) {
      throw new RangeError('capability gateway limits');
    }
  }

  prepare(
    value: agentV1Capability.CapabilityPrepare,
  ): Promise<agentV1Capability.CapabilityUpdate> {
    const request = validateCapabilityPrepare(
      value,
      this.context,
      this.limits.maximumInputBytes,
      this.nowUnixMs(),
    );
    const digest = createHash('sha256')
      .update(toBinary(agentV1Capability.CapabilityPrepareSchema, value))
      .digest();
    const existing = this.#prepared.get(request.operationId);
    if (this.#retired.has(request.operationId)) throw new CapabilityGatewayError(
      'operation_conflict', 'capability operation has a durable terminal; replay cannot authorize execution');
    if (existing) {
      if (!sameDigest(existing.digest, digest)) {
        throw new CapabilityGatewayError(
          'operation_conflict',
          'capability operation replay diverged',
        );
      }
      return existing.result;
    }
    if (this.#prepared.size >= this.limits.maximumPreparedOperations
      || this.#retired.size + this.#prepared.size >= (this.limits.maximumRetiredOperations ?? 100_000)) {
      throw new CapabilityGatewayError('registry_full', 'capability registry is full');
    }
    const result = this.resolver.resolve(request).then((resolution) => (
      capabilityResolutionToUpdate(resolution, request, this.nowUnixMs())
    ));
    this.#prepared.set(request.operationId, { digest, request, result });
    void result.catch(() => { this.#prepared.delete(request.operationId); });
    return result;
  }

  async execute(
    value: agentV1Capability.CapabilityExecute,
  ): Promise<agentV1Capability.CapabilityExecutionResult> {
    const prepared = this.#prepared.get(value.operationId);
    if (!prepared) throw new CapabilityGatewayError(
      'operation_conflict',
      'capability execution has no prepared operation',
    );
    const update = await prepared.result;
    if (update.decision.case !== 'accepted') throw new CapabilityGatewayError(
      'operation_conflict',
      'capability execution does not have an accepted grant',
    );
    const grant = update.decision.value;
    validateCapabilityExecute(
      value,
      this.context,
      prepared.request,
      grant,
      this.nowUnixMs(),
    );
    const digest = createHash('sha256')
      .update(toBinary(agentV1Capability.CapabilityExecuteSchema, value))
      .digest();
    const existing = this.#executed.get(value.operationId);
    if (existing) {
      if (!sameDigest(existing.digest, digest)) throw new CapabilityGatewayError(
        'operation_conflict',
        'capability execution replay diverged',
      );
      return existing.result;
    }
    const result = this.#executePrepared(prepared.request, grant);
    this.#executed.set(value.operationId, { digest, result });
    return result;
  }

  get preparedOperationCount(): number {
    return this.#prepared.size;
  }

  validateReadBatch(value: agentV1Capability.CapabilityReadBatchExecute) {
    return validateCapabilityReadBatch(value, this.context, this.nowUnixMs,
      (id) => this.#prepared.get(id), this.executor);
  }

  get executedOperationCount(): number {
    return this.#executed.size;
  }

  /** Called only by the authenticated Data owner, after the native journal
   * commit and its ACK. Keep a bounded digest tombstone, never a reusable grant. */
  async retireCommitted(record: agentV1SessionStore.EngineEventRecordV1): Promise<void> {
    const body = record.body;
    if (body.case !== 'capabilityTerminal' && body.case !== 'capabilityRefused') return;
    if (!record.identity || !attemptIdentityEqual(record.identity, this.context.identity)) {
      throw new CapabilityGatewayError('operation_conflict', 'foreign capability retirement');
    }
    const id = body.value.operationId;
    const digest = createHash('sha256').update(toBinary(agentV1SessionStore.EngineEventRecordV1Schema, record)).digest();
    const retired = this.#retired.get(id);
    if (retired) {
      if (!sameDigest(retired, digest)) throw new CapabilityGatewayError('operation_conflict', 'capability retirement replay diverged');
      return;
    }
    const prepared = this.#prepared.get(id);
    if (!prepared) {
      // The authenticated engine may refuse an unopened invocation using its
      // sealed budget. This only removes authority: no grant or effect exists.
      if (this.#executed.has(id) || !(isEngineBudgetRefusal(record, this.nowUnixMs()) || isEngineWorkspaceRefusal(record, this.nowUnixMs()))) {
        throw new CapabilityGatewayError('operation_conflict', 'capability retirement has no preparation');
      }
      if (this.#retired.size + this.#prepared.size >= (this.limits.maximumRetiredOperations ?? 100_000)) {
        throw new CapabilityGatewayError('registry_full', 'capability registry is full');
      }
      this.#retired.set(id, digest);
      return;
    }
    const decision = await prepared.result;
    const executed = this.#executed.get(id);
    validateCapabilityRetirement(record, decision, await executed?.result);
    // Install the tombstone first, including when a cleanup hook throws.
    this.#retired.set(id, digest);
    this.#prepared.delete(id);
    this.#executed.delete(id);
    this.resolver.retire?.(prepared.request, decision);
  }

  async #executePrepared(
    request: PreparedEntry['request'],
    grant: agentV1Capability.SealedExecutionGrant,
  ): Promise<agentV1Capability.CapabilityExecutionResult> {
    if (!this.executor) return executionResult(request, grant, this.context, {
      case: 'failed',
      reasonCode: 'host_executor_unavailable',
      durationMs: 0n,
    }, this.limits.maximumOutputBytes);
    try {
      return executionResult(
        request,
        grant,
        this.context,
        await this.executor.execute(request, grant),
        this.limits.maximumOutputBytes,
      );
    } catch {
      return ambiguousExecutionResult(request, grant, this.context);
    }
  }
}

function sameDigest(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

