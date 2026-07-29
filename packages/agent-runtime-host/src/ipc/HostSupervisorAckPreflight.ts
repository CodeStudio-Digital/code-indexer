import {
  HostSupervisorFactError,
} from '../driver/HostSupervisorFactError.js';
import type {
  HostSupervisorFactHandoff,
} from '../driver/HostSupervisorFactTypes.js';
import type {
  HostSupervisorReplayHistory,
} from './HostSupervisorReplayHistory.js';

export function assertSupervisorAckCapacity(
  maximumAckBytes: number,
  handoff: HostSupervisorFactHandoff,
  history: HostSupervisorReplayHistory,
): void {
  if (maximumAckBytes > handoff.maximumFrameBytes) {
    throw new HostSupervisorFactError(
      'ack_frame_too_large',
      `ACK upper bound ${maximumAckBytes} exceeds frame cap`,
    );
  }
  if (!history.canRetain(maximumAckBytes)) {
    throw new HostSupervisorFactError(
      'replay_capacity_exhausted',
      'management replay byte capacity is exhausted',
    );
  }
}
