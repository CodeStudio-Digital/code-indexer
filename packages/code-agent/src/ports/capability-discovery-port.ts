/** Read-only view of the exact capability set already hydrated into Rust.
 * Discovery cannot modify membership or manufacture execution permissions. */
export interface CapabilityDiscoveryPort {
  readonly capabilitySetDigest: string;
  readonly visibleToolNames: ReadonlySet<string>;
  readonly eligibleCapabilityIds: ReadonlySet<string>;
  assertCurrent(): void;
}
