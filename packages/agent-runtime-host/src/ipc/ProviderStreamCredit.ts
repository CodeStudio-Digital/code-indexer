import type { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { raceAbort } from '../provider-gateway/ProviderAbort.js';
import { HostDataChannelError } from './HostDataChannelError.js';

/** Transport consumption only. This never confirms persistence or an effect. */
export class ProviderStreamCredit {
  private pending?: { sequence: bigint; resolve(): void; reject(cause: unknown): void };
  private cancelledSequence?: bigint;
  constructor(readonly operationId: string) {}

  reserve(sequence: bigint): (signal?: AbortSignal) => Promise<void> {
    if (this.pending || sequence <= 0n) throw failure();
    const consumed = new Promise<void>((resolve, reject) => { this.pending = { sequence, resolve, reject }; });
    void consumed.catch(() => undefined);
    return async signal => {
      try { await (signal ? raceAbort(consumed, signal) : consumed); }
      finally {
        if (this.pending?.sequence === sequence) {
          this.cancelledSequence = sequence;
          this.pending = undefined;
        }
      }
    };
  }

  acknowledge(receipt: agentV1Runtime.ProviderEventConsumed): void {
    // An ACK already in the pipe may race the operation's cancellation. It
    // retires this one credit without admitting a new provider event.
    if (!this.pending && receipt.operationId === this.operationId && receipt.eventSequence === this.cancelledSequence) {
      this.cancelledSequence = undefined;
      return;
    }
    if (receipt.operationId !== this.operationId || !this.pending || receipt.eventSequence !== this.pending.sequence) throw failure();
    const { resolve } = this.pending;
    this.pending = undefined;
    resolve();
  }

  close(cause: unknown): void { this.pending?.reject(cause); this.pending = undefined; this.cancelledSequence = undefined; }
}

function failure() { return new HostDataChannelError('provider_failure', 'provider consumption credit is absent or divergent'); }
