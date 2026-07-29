import type { DelimitedByteChannel } from '../ipc/DelimitedByteChannel.js';
import type {
  HostSupervisorFactDriverOptions,
  HostSupervisorFactHandoff,
} from './HostSupervisorFactTypes.js';
import { HostSupervisorFactError } from './HostSupervisorFactError.js';

export interface HostSupervisorFactDriverBinding {
  readonly transport: DelimitedByteChannel;
  readonly owner: object;
  readonly handoff: HostSupervisorFactHandoff;
}

const constructionBindings = new WeakMap<
  HostSupervisorFactDriverOptions,
  HostSupervisorFactDriverBinding
>();

export function bindHostSupervisorFactDriver(
  options: HostSupervisorFactDriverOptions,
  binding: HostSupervisorFactDriverBinding,
): void {
  if (constructionBindings.has(options)) {
    throw new HostSupervisorFactError(
      'invalid_handoff',
      'management fact driver options are already bound',
    );
  }
  constructionBindings.set(options, binding);
}

export function takeHostSupervisorFactDriverBinding(
  options: HostSupervisorFactDriverOptions,
  transport: DelimitedByteChannel,
): HostSupervisorFactDriverBinding {
  const binding = constructionBindings.get(options);
  constructionBindings.delete(options);
  if (!binding) {
    throw new HostSupervisorFactError(
      'invalid_handoff',
      'management fact driver requires an authentic same-stream handoff',
    );
  }
  if (binding.transport !== transport) {
    const failure = new HostSupervisorFactError(
      'invalid_handoff',
      'management fact driver handoff changed its physical stream',
    );
    try {
      binding.transport.fail(failure, binding.owner);
    } catch {
      // Preserve an earlier owner failure.
    }
    try {
      transport.fail(failure);
    } catch {
      // Both physical aliases are unusable after a transplant mismatch.
    }
    throw failure;
  }
  return binding;
}
