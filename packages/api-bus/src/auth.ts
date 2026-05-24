import type { ApiContext } from './common.js';

/**
 * Auth = user-of-the-app authentication. The backend is a thin proxy to
 * `worker-license` (Cloudflare Worker, separate). All endpoints below
 * forward to the Worker; the local backend caches the resulting JWT in
 * SQLite (`license_cache` table, migration 105) so the app works offline
 * until JWT expires (~30d).
 *
 * **Distinct from the existing OAuth 2.1 AS** (apps/http-api/oauth/*),
 * which serves MCP clients (Cursor, Claude Desktop, etc.). That stays
 * intact; this is a parallel auth surface for end-users of the IDE.
 */

export interface SessionToken {
  jwt: string;
  user: { id: string; email: string; tier: 'free' | 'pro' };
  exp: number;
}

export interface AuthApi {
  signup(input: { email: string; password: string }, ctx: ApiContext): Promise<SessionToken>;
  signin(input: { email: string; password: string }, ctx: ApiContext): Promise<SessionToken>;

  /**
   * Validate the cached JWT against the Worker. Worker may rotate the
   * token (response header `X-New-Token`) if TTL <7 days; backend updates
   * the local cache transparently.
   */
  me(input: void, ctx: ApiContext): Promise<{ user: { id: string; email: string; tier: 'free' | 'pro' }; exp: number }>;

  logout(input: void, ctx: ApiContext): Promise<{ ok: true }>;

  forgot(input: { email: string }, ctx: ApiContext): Promise<{ ok: true }>;
  reset(input: { token: string; new_password: string }, ctx: ApiContext): Promise<{ ok: true }>;

  /**
   * Force a refresh of the cached JWT (e.g. after Stripe checkout). The
   * backend hits the Worker even if the cached JWT is still valid, so
   * the new tier reflects immediately in the UI.
   */
  refresh(input: void, ctx: ApiContext): Promise<SessionToken>;
}
