/**
 * TokenHasher port — one-way hash for bearer secrets before storage.
 * Used for both API tokens and refresh tokens (DRY).
 * `verify` is constant-time where possible.
 */
export interface TokenHasher {
  hash(raw: string): string;
  verify(raw: string, expectedHash: string): boolean;
}
