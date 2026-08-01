const MAX_INT64 = (1n << 63n) - 1n;

/** Maximum local Windows wall-clock quantization accepted across processes. */
export const LOCAL_PEER_CLOCK_SKEW_MS = 50n;

export function earliestLocalPeerTimestamp(value: bigint): bigint {
  return value > LOCAL_PEER_CLOCK_SKEW_MS
    ? value - LOCAL_PEER_CLOCK_SKEW_MS
    : 1n;
}

export function latestLocalPeerTimestamp(value: bigint): bigint {
  return value > MAX_INT64 - LOCAL_PEER_CLOCK_SKEW_MS
    ? MAX_INT64
    : value + LOCAL_PEER_CLOCK_SKEW_MS;
}
