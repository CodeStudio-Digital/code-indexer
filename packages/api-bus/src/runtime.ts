import type { ApiContext, AsyncStream } from './common.js';

/**
 * Runtime management — Node.js versions. Detects what's installed on the
 * machine (PATH, nvm/fnm/volta, Program Files, and our managed installs),
 * lets the user download official builds into the app data dir, and is the
 * source the terminal + runner consult to put the project's chosen Node on
 * PATH at spawn time.
 */

export type NodeSource = 'system' | 'path' | 'nvm' | 'fnm' | 'volta' | 'programfiles' | 'managed';

/** A Node.js runtime found on (or installed by) this machine. */
export interface NodeRuntime {
  /** Stable selector stored per-project: 'system', 'nvm:20.11.0', 'managed:20.11.0'. */
  id: string;
  /** Human label for pickers, e.g. "v20.11.0 (nvm)". */
  label: string;
  /** Plain version string, e.g. "20.11.0" (empty if unknown). */
  version: string;
  /** Directory containing the `node`/`npm` executables. */
  binDir: string;
  source: NodeSource;
  /** True when installed/managed by us under the app data dir. */
  isManaged: boolean;
}

/** An official Node.js release available to download (from nodejs.org). */
export interface NodeRelease {
  /** Version without the leading 'v', e.g. "20.11.0". */
  version: string;
  /** LTS codename (e.g. "Iron") or false for non-LTS. */
  lts: string | false;
  date: string;
  security: boolean;
}

/** Progress frames emitted while downloading + extracting a Node build. */
export interface DownloadProgress {
  phase: 'download' | 'extract' | 'done';
  version: string;
  receivedBytes?: number;
  totalBytes?: number;
  /** Present on the final 'done' frame. */
  runtime?: NodeRuntime;
}

export interface RuntimeApi {
  /** Detected + managed Node runtimes on this machine. */
  listNode(_input: Record<string, never> | undefined, ctx: ApiContext): Promise<NodeRuntime[]>;

  /** Official Node releases available to download (LTS + recent current). */
  listAvailable(_input: Record<string, never> | undefined, ctx: ApiContext): Promise<NodeRelease[]>;

  /** Download + extract an official Node build into the app data dir. */
  download(input: { version: string }, ctx: ApiContext): AsyncStream<DownloadProgress>;

  /** Remove a managed (downloaded) Node install. */
  remove(input: { version: string }, ctx: ApiContext): Promise<void>;
}
