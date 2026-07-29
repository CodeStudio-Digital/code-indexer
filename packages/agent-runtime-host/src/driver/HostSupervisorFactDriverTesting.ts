import type { DelimitedByteChannel } from '../ipc/DelimitedByteChannel.js';
import { HostSupervisorFactDriver } from './HostSupervisorFactDriver.js';
import {
  bindHostSupervisorFactDriver,
} from './HostSupervisorFactDriverConstruction.js';
import type {
  DurableSupervisorFactPort,
  HostSupervisorFactDriverOptions,
} from './HostSupervisorFactTypes.js';

/** Internal raw-handoff seam; unavailable through the package export map. */
export function createHostSupervisorFactDriverForTesting(
  transport: DelimitedByteChannel,
  durableFacts: DurableSupervisorFactPort,
  options: HostSupervisorFactDriverOptions,
): HostSupervisorFactDriver {
  bindHostSupervisorFactDriver(options, {
    transport,
    owner: {},
    handoff: options.handoff,
  });
  return new HostSupervisorFactDriver(transport, durableFacts, options);
}
