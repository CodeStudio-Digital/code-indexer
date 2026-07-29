import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { AttemptFrameError } from './AttemptFrameError.js';

export type AttemptTransportChannel =
  | agentV1Runtime.TransportChannel.CONTROL
  | agentV1Runtime.TransportChannel.DATA;

export const ATTEMPT_FRAME_MAX_BYTES = {
  [agentV1Runtime.TransportChannel.CONTROL]: 256 * 1024,
  [agentV1Runtime.TransportChannel.DATA]: 1024 * 1024,
} as const satisfies Record<AttemptTransportChannel, number>;

export function assertAttemptFrameSize(
  encodedFrame: Uint8Array,
  channel: AttemptTransportChannel,
  negotiatedMaximum: number,
): void {
  if (encodedFrame.byteLength === 0) {
    throw new AttemptFrameError('empty_frame', 'attempt frame cannot be empty');
  }
  if (!Number.isSafeInteger(negotiatedMaximum) || negotiatedMaximum <= 0) {
    throw new AttemptFrameError(
      'invalid_frame_limit',
      'negotiated frame maximum must be a positive safe integer',
    );
  }
  const maximum = Math.min(
    ATTEMPT_FRAME_MAX_BYTES[channel],
    negotiatedMaximum,
  );
  if (encodedFrame.byteLength > maximum) {
    throw new AttemptFrameError(
      'frame_too_large',
      `attempt frame has ${encodedFrame.byteLength} bytes; maximum is ${maximum}`,
    );
  }
}
