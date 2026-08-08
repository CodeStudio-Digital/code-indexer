import { createHash, timingSafeEqual } from 'node:crypto';
import { toBinary } from '@bufbuild/protobuf';
import { agentV1Capability } from '@mcp/agent-runtime-contracts';
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

  constructor(
    private readonly context: HostDataBoundContext,
    private readonly resolver: CapabilityDecisionResolver,
    private readonly nowUnixMs: () => bigint,
    private readonly limits: CapabilityGatewayLimits = DEFAULT_CAPABILITY_GATEWAY_LIMITS,
    private readonly executor?: HostCapabilityExecutor,
  ) {
    if (!Number.isSafeInteger(limits.maximumPreparedOperations)
      || limits.maximumPreparedOperations <= 0
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
    if (existing) {
      if (!sameDigest(existing.digest, digest)) {
        throw new CapabilityGatewayError(
          'operation_conflict',
          'capability operation replay diverged',
        );
      }
      return existing.result;
    }
    if (this.#prepared.size >= this.limits.maximumPreparedOperations) {
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

  get executedOperationCount(): number {
    return this.#executed.size;
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

