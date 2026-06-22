/**
 * Base URL for the DEV cloud bridge only. Empty string ⇒ relative `/v1/...`
 * requests, which the Vite dev server proxies to the Worker (avoids CORS — see
 * the `/v1` proxy in vite.config.ts). Override with `VITE_CLOUD_API_URL` to hit a
 * specific Worker directly. The production Electron app does NOT use this — its
 * transport lives in main with the deployed Worker URL.
 */
const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

export const CLOUD_API_BASE: string = (env.VITE_CLOUD_API_URL ?? '').replace(/\/$/, '');

/** Web account portal (Cloudflare Pages) — email/password sign-in + account
 *  management. Override with `VITE_PORTAL_URL`. */
export const PORTAL_URL: string = (env.VITE_PORTAL_URL ?? 'https://account.codestudio.dev').replace(/\/$/, '');
