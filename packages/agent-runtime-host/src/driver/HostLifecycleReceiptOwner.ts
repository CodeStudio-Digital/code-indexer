import type {
  ActiveAttemptAuthorityHandle,
  ActiveAttemptReceipt,
  PreparedAttemptReceipt,
} from './HostLifecycleReceipts.js';
import {
  consumeActiveAttemptReceipt,
  consumePreparedAttemptReceipt,
  inspectActiveAttemptAuthority,
  installActiveAttemptAuthority,
  mintPreparedAttemptReceipt,
  revokePreparedAttemptReceipt,
} from './HostLifecycleReceipts.js';
import { HostLifecycleDriverError } from './HostLifecycleDriverError.js';
import type {
  ActiveAttemptAuthorityFacts,
  ActiveAttemptAuthoritySnapshot,
  PreparedDurabilityFacts,
} from './HostLifecycleTypes.js';

export class HostLifecycleReceiptOwner {
  readonly #binding = {};
  #prepared?: PreparedAttemptReceipt;

  mintPrepared(
    facts: PreparedDurabilityFacts,
  ): PreparedAttemptReceipt {
    if (this.#prepared) {
      throw new HostLifecycleDriverError(
        'invalid_receipt',
        'prepared receipt owner already has a live receipt',
      );
    }
    const receipt = mintPreparedAttemptReceipt(this.#binding, facts);
    this.#prepared = receipt;
    return receipt;
  }

  consumePrepared(
    receipt: PreparedAttemptReceipt,
  ): PreparedDurabilityFacts {
    const facts = consumePreparedAttemptReceipt(receipt, this.#binding);
    if (this.#prepared === receipt) this.#prepared = undefined;
    return facts;
  }

  revokePrepared(): void {
    const receipt = this.#prepared;
    if (!receipt) return;
    this.#prepared = undefined;
    revokePreparedAttemptReceipt(receipt, this.#binding);
  }

  installActive(
    facts: ActiveAttemptAuthorityFacts,
    signal: AbortSignal,
  ): ActiveAttemptReceipt {
    return installActiveAttemptAuthority(
      this.#binding,
      facts,
      signal,
    );
  }

  consumeActive(
    receipt: ActiveAttemptReceipt,
  ): ActiveAttemptAuthorityHandle {
    return consumeActiveAttemptReceipt(receipt, this.#binding);
  }

  inspectActive(
    handle: ActiveAttemptAuthorityHandle,
  ): ActiveAttemptAuthoritySnapshot {
    return inspectActiveAttemptAuthority(handle, this.#binding);
  }
}
