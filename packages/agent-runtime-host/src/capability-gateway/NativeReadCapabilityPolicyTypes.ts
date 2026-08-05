export interface NativeReadWorkspaceLeaseBinding {
  readonly id: string;
  readonly version: bigint;
  readonly fencingEpoch: bigint;
}

export interface NativeReadCapabilityPolicyOptions {
  /** Trusted workspace root selected by the Host, never by provider input. */
  readonly rootPath: string;
  /** Content digest of the hydrated CapabilitySetSnapshotV1. */
  readonly capabilitySetSha256: Uint8Array;
  readonly environmentId: string;
  readonly environmentVersion: bigint;
  readonly workspaceLease?: NativeReadWorkspaceLeaseBinding;
  readonly resourceBindingId: string;
  readonly policyVersion: string;
  readonly grantTtlMs: bigint;
  readonly maxReadBytes: bigint;
  readonly maxOutputBytes: bigint;
  readonly requireUtf8: boolean;
}
