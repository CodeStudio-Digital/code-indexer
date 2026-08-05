import { createHash, timingSafeEqual } from 'node:crypto';
import { toBinary } from '@bufbuild/protobuf';
import { agentV1Capability } from '@mcp/agent-runtime-contracts';
import type { HostDataBoundContext } from '../ipc/HostDataAttemptChannelValidation.js';
import { CapabilityGatewayError } from './CapabilityGatewayError.js';
import type {
  CapabilityDecisionResolver,
  CapabilityGatewayLimits,
} from './CapabilityGatewayTypes.js';
import { DEFAULT_CAPABILITY_GATEWAY_LIMITS } from './CapabilityGatewayTypes.js';
import {
  capabilityResolutionToUpdate,
  validateCapabilityPrepare,
} from './CapabilityGatewayValidation.js';

interface PreparedEntry {
  readonly digest: Uint8Array;
  readonly result: Promise<agentV1Capability.CapabilityUpdate>;
}

export class CapabilityGateway {
  readonly #prepared = new Map<string, PreparedEntry>();

  constructor(
    private readonly context: HostDataBoundContext,
    private readonly resolver: CapabilityDecisionResolver,
    private readonly nowUnixMs: () => bigint,
    private readonly limits: CapabilityGatewayLimits = DEFAULT_CAPABILITY_GATEWAY_LIMITS,
  ) {
    if (!Number.isSafeInteger(limits.maximumPreparedOperations)
      || limits.maximumPreparedOperations <= 0
      || !Number.isSafeInteger(limits.maximumInputBytes)
      || limits.maximumInputBytes <= 0) {
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
    this.#prepared.set(request.operationId, { digest, result });
    void result.catch(() => { this.#prepared.delete(request.operationId); });
    return result;
  }

  get preparedOperationCount(): number {
    return this.#prepared.size;
  }
}

function sameDigest(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

