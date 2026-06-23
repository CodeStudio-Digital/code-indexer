import type { RefreshToken } from '../domain/refresh-token.js';

export interface RefreshTokenRepo {
  insert(token: RefreshToken): void;
  findByHash(hash: string): RefreshToken | null;
  /** Mark old token as rotated (pointing to successor hash). */
  markRotated(oldHash: string, successorHash: string, at: number): void;
  revoke(hash: string, at: number): void;
  /** Revoke an entire chain starting from any hash in it (rotation theft defense). */
  revokeChain(hash: string, at: number): void;
}
