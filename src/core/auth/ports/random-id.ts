/**
 * RandomId port — CSPRNG-backed identifier generation.
 * `token(bytes)` produces a hex string; `uuid()` returns an RFC 4122 UUID.
 */
export interface RandomId {
  token(bytes: number): string;
  uuid(): string;
}
