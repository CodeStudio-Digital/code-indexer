/**
 * Typed cloud RPC for the renderer. `cloudCall(op, input)` routes over the
 * Electron-main `cloud` bridge (HTTPS to the deployed Worker), NOT the in-process
 * api bus. Throws a typed `CloudError` on failure; tokens are handled entirely in
 * main and never reach here.
 */
import type { CloudInput, CloudOp, CloudOutput, CloudAuthState } from '@mcp/api-bus';
import { CloudError, mapCloudError } from './cloud-errors.js';
import { createDevCloudBridge } from './dev-cloud-bridge.js';

export type OAuthProviderId = 'google' | 'github' | 'microsoft';

interface CloudBridge {
  fetch(op: string, input: unknown): Promise<{ ok: boolean; status: number; body: unknown }>;
  getAuthState(): Promise<CloudAuthState>;
  logout(): Promise<{ ok: true }>;
  /** Desktop-only: browser OAuth login via the loopback handoff. */
  startBrowserLogin?(provider: string): Promise<{ ok: boolean; error?: string }>;
  /** Desktop-only: Enterprise SSO login (same loopback handoff, keyed by org id). */
  startSsoLogin?(orgId: string): Promise<{ ok: boolean; error?: string }>;
  /** Desktop-only: device login via the web portal (browser; any auth method). */
  startPortalLogin?(): Promise<{ ok: boolean; error?: string }>;
  onAuthChanged(cb: (s: CloudAuthState) => void): (() => void) | void;
}

const isDev = (): boolean => !!(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV;
let devBridge: CloudBridge | null = null;

/**
 * The real bridge lives on `electronAPI.cloud` (main process, OS-keychain tokens).
 * In browser `vite dev` it's absent → fall back to the localStorage dev bridge so
 * login works + persists during dev. In production (DEV=false) a missing bridge
 * throws — cloud features require the desktop app.
 */
export function cloudBridge(): CloudBridge {
  const real = (globalThis as { electronAPI?: { cloud?: CloudBridge } }).electronAPI?.cloud;
  if (real) return real;
  if (isDev()) return (devBridge ??= createDevCloudBridge());
  throw new CloudError('server_error', 0, 'Cloud features require the desktop app.');
}

export async function cloudCall<Op extends CloudOp>(op: Op, input: CloudInput<Op>): Promise<CloudOutput<Op>> {
  const res = await cloudBridge().fetch(op, input);
  if (!res.ok) throw mapCloudError(res.status, res.body);
  return res.body as CloudOutput<Op>;
}

/**
 * Start browser OAuth login (desktop only). Returns `{ ok }`; on success the
 * `cloud:auth-changed` broadcast (consumed by useCloudSession) flips the UI to
 * signed-in — no tokens reach the renderer. Absent bridge (web dev) ⇒ desktop_only.
 */
export async function cloudStartBrowserLogin(provider: OAuthProviderId): Promise<{ ok: boolean; error?: string }> {
  const bridge = cloudBridge();
  if (!bridge.startBrowserLogin) return { ok: false, error: 'desktop_only' };
  return bridge.startBrowserLogin(provider);
}

/** Start Enterprise SSO login for an org (desktop only). Same loopback handoff as
 *  OAuth; the renderer only learns ok/error (tokens stay in main). */
export async function cloudStartSsoLogin(orgId: string): Promise<{ ok: boolean; error?: string }> {
  const bridge = cloudBridge();
  if (!bridge.startSsoLogin) return { ok: false, error: 'desktop_only' };
  return bridge.startSsoLogin(orgId);
}

/** Start device login via the web portal (desktop only): opens the portal in the
 *  browser where the user signs in by ANY method (email/password or OAuth), then is
 *  handed back to the desktop via the loopback. */
export async function cloudStartPortalLogin(): Promise<{ ok: boolean; error?: string }> {
  const bridge = cloudBridge();
  if (!bridge.startPortalLogin) return { ok: false, error: 'desktop_only' };
  return bridge.startPortalLogin();
}
