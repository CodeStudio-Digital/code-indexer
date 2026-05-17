export interface JwtClaims {
  iss: string;
  sub: string;
  aud: string;
  exp: number;           // unix seconds
  iat: number;
  scope: string;         // space-separated
  jti?: string;
  [extra: string]: unknown;
}

/**
 * TokenSigner port — signs and verifies self-contained access tokens (JWT).
 * Keeps the algorithm pluggable (HS256 local, future: RS256 for multi-node).
 */
export interface TokenSigner {
  sign(claims: JwtClaims): string;
  verify(token: string): JwtClaims | null;
}
