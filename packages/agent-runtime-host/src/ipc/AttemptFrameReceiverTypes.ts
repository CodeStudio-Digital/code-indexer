export const MAX_REPLAY_WINDOW_ENTRIES = 4_096;
export const MAX_TRACKED_MESSAGE_IDS = 65_536;
export const MAX_UINT64 = (1n << 64n) - 1n;
export const MAX_INT64 = (1n << 63n) - 1n;

export interface AttemptFrameReceiverLimits {
  replayCapacity: number;
  totalIdentityCapacity: number;
  maxReplayBytes: number;
}

export function receiverLimitErrorCode(
  limits: AttemptFrameReceiverLimits,
):
  | 'invalid_replay_window'
  | 'replay_window_too_large'
  | 'invalid_total_identity_capacity'
  | 'invalid_replay_byte_budget'
  | undefined {
  if (!Number.isInteger(limits.replayCapacity) || limits.replayCapacity <= 0) {
    return 'invalid_replay_window';
  }
  if (limits.replayCapacity > MAX_REPLAY_WINDOW_ENTRIES) {
    return 'replay_window_too_large';
  }
  if (
    !Number.isInteger(limits.totalIdentityCapacity)
    || limits.totalIdentityCapacity <= 0
    || limits.totalIdentityCapacity > MAX_TRACKED_MESSAGE_IDS
    || limits.replayCapacity > limits.totalIdentityCapacity
  ) {
    return 'invalid_total_identity_capacity';
  }
  if (!Number.isSafeInteger(limits.maxReplayBytes) || limits.maxReplayBytes <= 0) {
    return 'invalid_replay_byte_budget';
  }
  return undefined;
}
