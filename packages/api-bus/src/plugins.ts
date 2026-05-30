/**
 * `plugins` namespace — install / uninstall / manage IDE plugins.
 *
 * One-shot RPC only (no streams), so it mounts as `api:plugins:*` and
 * needs no preload streaming-path entry. `searchMarket` / `marketInfo`
 * arrive with the hosted Market phase.
 */
import type { ApiContext, AsyncStream } from './common.js';

/** A frame of a streamed plugin command (live `wrangler tail`, `login`, …). */
export type PluginExecChunk =
  | { type: 'data'; data: string }
  | { type: 'exit'; code: number | null };

export type PluginInstallSource =
  | { source: 'local'; path: string }
  | { source: 'github'; repo: string; ref?: string }
  | { source: 'url'; url: string }
  | { source: 'market'; name: string; ref?: string };

export interface PluginInstallInput {
  source: PluginInstallSource;
  /** Override the namespace (defaults to the plugin.json `name`). */
  namespace?: string;
  overwrite?: boolean;
}

/** Capability requirements a plugin declares / the user grants (mirrors the SDK). */
export interface PluginPermissionsShape {
  fs?: { read?: string[]; write?: string[] };
  exec?: { allow: string[] };
  storage?: boolean;
}

export interface InstalledPluginInfo {
  namespace: string;
  name: string;
  version: string;
  source: string;
  enabled: boolean;
  manifest: Record<string, unknown> | null;
  contributions: Record<string, unknown> | null;
  installed_at: string;
  updated_at: string;
  /** Capabilities the plugin declares (drives the permissions UI). */
  permissions: PluginPermissionsShape | null;
}

export interface PluginInstallResult {
  namespace: string;
  name: string;
  version: string;
  skills: Array<{ id: string; name: string; kind: string; slash_command: string | null }>;
  mcpServers: Array<{ id: string; name: string; transport: string }>;
  warnings: string[];
}

export interface MarketPluginInfo {
  name: string;
  displayName?: string;
  description?: string;
  latestVersion: string;
  downloads: number;
  category?: string;
  author?: string;
  brandColor?: string;
}

export interface PluginsApi {
  list(input: void, ctx: ApiContext): Promise<InstalledPluginInfo[]>;
  get(input: { namespace: string }, ctx: ApiContext): Promise<InstalledPluginInfo | null>;
  install(input: PluginInstallInput, ctx: ApiContext): Promise<PluginInstallResult>;
  uninstall(
    input: { namespace: string },
    ctx: ApiContext,
  ): Promise<{ ok: true; skillsRemoved: number; mcpRemoved: number }>;
  setEnabled(
    input: { namespace: string; enabled: boolean },
    ctx: ApiContext,
  ): Promise<{ ok: true }>;
  /** Read a text asset (e.g. a tool-window HTML entry) from a plugin's dir. */
  readAsset(
    input: { namespace: string; path: string },
    ctx: ApiContext,
  ): Promise<{ content: string }>;

  /** Search the hosted market catalog. */
  searchMarket(input: { query: string }, ctx: ApiContext): Promise<MarketPluginInfo[]>;
  /** Look up one market plugin by name (null if absent). */
  marketInfo(input: { name: string }, ctx: ApiContext): Promise<MarketPluginInfo | null>;

  /** Invoke an installed plugin's own tool from its webview (namespace-bound by the bridge). */
  invokeTool(
    input: { namespace: string; tool: string; args?: Record<string, unknown>; projectId?: number },
    ctx: ApiContext,
  ): Promise<{ content: string; isError?: boolean }>;

  /**
   * Stream a long-running allowlisted command for a plugin (live `wrangler
   * tail`, `wrangler login`). Namespace + cmd are checked against the plugin's
   * granted `exec.allow`; cwd is the project root. The `Stream` suffix makes it
   * auto-mount as a MessagePort/SSE stream (handlers-mount convention).
   */
  execStream(
    input: { namespace: string; cmd: string; args: string[]; projectId?: number },
    ctx: ApiContext,
  ): AsyncStream<PluginExecChunk>;

  /** Declared + currently-granted capability subsets (for the approval UI). */
  getPermissions(
    input: { namespace: string },
    ctx: ApiContext,
  ): Promise<{ declared: PluginPermissionsShape | null; granted: PluginPermissionsShape | null }>;
  /** Record the capability subset the user approved at install / in settings. */
  requestPermission(
    input: { namespace: string; granted: PluginPermissionsShape },
    ctx: ApiContext,
  ): Promise<{ ok: true }>;
  /** Per-plugin key-value storage (also reachable from a plugin's own webview). */
  storageGet(
    input: { namespace: string; key: string },
    ctx: ApiContext,
  ): Promise<{ value: string | null }>;
  storageSet(
    input: { namespace: string; key: string; value: string },
    ctx: ApiContext,
  ): Promise<{ ok: true }>;
  storageList(input: { namespace: string }, ctx: ApiContext): Promise<{ keys: string[] }>;
}
