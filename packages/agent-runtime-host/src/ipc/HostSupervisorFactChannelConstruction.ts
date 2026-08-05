import type { HostSupervisorFactHandoff } from '../driver/HostSupervisorFactTypes.js';
import { HostSupervisorFactError } from '../driver/HostSupervisorFactError.js';
import type { DelimitedByteChannel } from './DelimitedByteChannel.js';
import { HostSupervisorCommandLane } from './HostSupervisorCommandLane.js';
import { HostSupervisorReplayHistory } from './HostSupervisorReplayHistory.js';
import { snapshotFactHandoff } from './HostSupervisorFactValidation.js';

interface FactChannelConstruction {
  readonly handoff: HostSupervisorFactHandoff;
  readonly commands: HostSupervisorCommandLane;
  readonly history: HostSupervisorReplayHistory;
}

export function constructHostSupervisorFactChannel(
  transport: DelimitedByteChannel,
  owner: object,
  handoff: HostSupervisorFactHandoff,
  nowUnixMs: () => bigint,
  onFailure: (cause: HostSupervisorFactError) => void,
): FactChannelConstruction {
  let snapshot: HostSupervisorFactHandoff;
  try {
    snapshot = snapshotFactHandoff(handoff);
  } catch (cause) {
    transport.fail(cause, owner);
    throw cause;
  }
  transport.claim(owner);
  if (transport.maximumFrameBytes !== snapshot.maximumFrameBytes) {
    const failure = new HostSupervisorFactError(
      'invalid_handoff',
      'transport frame cap does not match the negotiated handoff',
    );
    transport.fail(failure, owner);
    throw failure;
  }
  return {
    handoff: snapshot,
    commands: new HostSupervisorCommandLane(
      transport,
      owner,
      snapshot,
      nowUnixMs,
      onFailure,
    ),
    history: new HostSupervisorReplayHistory(
      snapshot.trackedMessageIdCapacity,
      snapshot.maximumReplayBytes,
      [snapshot.bootstrapInboundMessageId],
    ),
  };
}
