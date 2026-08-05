import type { EstablishedAttemptChannel } from '../ipc/EstablishedAttemptChannel.js';
import type { HostAuthorityLifetime } from './HostAuthorityLifetime.js';
import type { HostHeartbeatMonitor } from './HostHeartbeatMonitor.js';
import { HostLifecycleDriverError } from './HostLifecycleDriverError.js';
import type { HostLifecycleDriverPhase } from './HostLifecycleDriverState.js';
import type { ActiveAttemptAuthorityHandle } from './HostLifecycleReceipts.js';
import type { HostLifecycleReceiptOwner } from './HostLifecycleReceiptOwner.js';
import {
  executeHostCancel,
  executeHostFence,
} from './HostLifecycleTerminate.js';
import type {
  ActiveAttemptAuthorityFacts,
  HostCancelAttemptRequest,
  HostFenceAttemptRequest,
} from './HostLifecycleTypes.js';

interface HostLifecycleTerminatorOptions {
  readonly receipts: HostLifecycleReceiptOwner;
  readonly phase: HostLifecycleDriverPhase;
  readonly channel: EstablishedAttemptChannel;
  readonly monitor: HostHeartbeatMonitor;
  readonly lifetime: HostAuthorityLifetime;
  readonly timeoutMs: number;
  readonly release: () => void;
  readonly raise: (cause: unknown) => never;
}

export class HostLifecycleTerminator {
  constructor(private readonly options: HostLifecycleTerminatorOptions) {}

  cancel(
    handle: ActiveAttemptAuthorityHandle,
    request: HostCancelAttemptRequest,
  ): Promise<void> {
    return this.#run(handle, (authority) => executeHostCancel(
      this.#commandOptions(authority),
      request,
    ));
  }

  fence(
    handle: ActiveAttemptAuthorityHandle,
    request: HostFenceAttemptRequest,
  ): Promise<void> {
    return this.#run(handle, (authority) => executeHostFence(
      this.#commandOptions(authority),
      request,
    ));
  }

  async #run(
    handle: ActiveAttemptAuthorityHandle,
    command: (authority: ActiveAttemptAuthorityFacts) => Promise<void>,
  ): Promise<void> {
    try {
      this.options.phase.require('active');
      const authority = this.options.receipts.inspectActive(handle);
      this.options.phase.set('terminating');
      await command(authority);
      this.options.monitor.close();
      this.options.lifetime.abort(new HostLifecycleDriverError(
        'active_authority_revoked',
        'active attempt authority ended after acknowledged termination',
      ));
      this.options.phase.set('terminated');
      this.options.release();
    } catch (cause) {
      this.options.raise(cause);
    }
  }

  #commandOptions(authority: ActiveAttemptAuthorityFacts) {
    return {
      channel: this.options.channel,
      monitor: this.options.monitor,
      authority,
      timeoutMs: this.options.timeoutMs,
    };
  }
}
