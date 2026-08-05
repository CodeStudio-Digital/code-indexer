import type { agentV1Common } from '@mcp/agent-runtime-contracts';
import { ProviderGatewayError } from './ProviderGatewayError.js';
import { identityKey } from './ProviderGatewayValidation.js';

interface ActiveProviderOperation {
  readonly identityKey: string;
  readonly controller: AbortController;
  readonly owner: symbol;
}

export interface ProviderOperationLease {
  readonly operationId: string;
  readonly controller: AbortController;
  release(): void;
}

export class ProviderOperationRegistry {
  readonly #operations = new Map<string, ActiveProviderOperation>();

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new ProviderGatewayError(
        'invalid_provider_request',
        'provider registry capacity must be a positive safe integer',
      );
    }
  }

  get size(): number {
    return this.#operations.size;
  }

  reserve(
    operationId: string,
    identity: agentV1Common.AttemptIdentity,
  ): ProviderOperationLease {
    if (this.#operations.has(operationId)) {
      throw new ProviderGatewayError(
        'provider_operation_conflict',
        `provider operation ${operationId} is already active`,
      );
    }
    if (this.#operations.size >= this.capacity) {
      throw new ProviderGatewayError('provider_registry_full', 'provider registry is full');
    }
    const owner = Symbol(operationId);
    const controller = new AbortController();
    this.#operations.set(operationId, {
      identityKey: identityKey(identity),
      controller,
      owner,
    });
    let released = false;
    return {
      operationId,
      controller,
      release: () => {
        if (released) return;
        released = true;
        const current = this.#operations.get(operationId);
        if (current?.owner === owner) this.#operations.delete(operationId);
      },
    };
  }

  abort(
    operationId: string,
    identity: agentV1Common.AttemptIdentity,
    reason: ProviderGatewayError,
  ): void {
    const active = this.#operations.get(operationId);
    if (!active) {
      throw new ProviderGatewayError(
        'provider_operation_not_found',
        `provider operation ${operationId} is not active`,
      );
    }
    if (active.identityKey !== identityKey(identity)) {
      throw new ProviderGatewayError(
        'provider_operation_identity_mismatch',
        `provider operation ${operationId} belongs to another attempt`,
      );
    }
    active.controller.abort(reason);
  }

  abortAttempt(identity: agentV1Common.AttemptIdentity, reason: ProviderGatewayError): number {
    const expected = identityKey(identity);
    let aborted = 0;
    for (const active of this.#operations.values()) {
      if (active.identityKey !== expected) continue;
      active.controller.abort(reason);
      aborted += 1;
    }
    return aborted;
  }
}
