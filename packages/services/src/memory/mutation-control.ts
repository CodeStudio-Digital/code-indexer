/** Host-owned scope, never deserialized from model or worker input. */
export interface MemoryMutationControl {
  readonly signal?: AbortSignal;
  readonly deferEmbeddings?: boolean;
  assertCurrent(): void;
}
