/** Trusted callbacks supplied by the host, separate from serialized tool input. */
export interface HostUiDispatchScope {
  owner?: object;
  assertDispatch(): void;
  /** Autonomous page requests belong to the attempt, not the first tool's TTL. */
  assertLifetime?(): void;
  signal: AbortSignal;
}
