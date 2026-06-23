import type { ApiContext, AsyncStream } from './common.js';

/**
 * Runtime management — per-project toolchains for Node.js, PHP and Python.
 * Detects what's installed on the machine (PATH, version managers, package
 * managers, and our own managed installs), lets the user install official
 * builds into the app data dir, and is the source the terminal + runner
 * consult to put the project's chosen runtime(s) on PATH at spawn time.
 *
 * The surface is `kind`-aware: one set of verbs serves every runtime, with
 * the concrete detection/install strategy living per-kind in the backend.
 */

export type RuntimeKind = 'node' | 'php' | 'python';

/** Where a detected runtime came from. */
export type RuntimeSource =
  // common to every kind
  | 'system'
  | 'path'
  | 'programfiles'
  | 'managed'
  // node version managers
  | 'nvm'
  | 'fnm'
  | 'volta'
  // php / python
  | 'homebrew'
  | 'pyenv'
  | 'pylauncher'
  | 'pythonorg'
  | 'scoop'
  | 'choco';

/** Back-compat alias — detect-node.ts still imports `NodeSource`. */
export type NodeSource = RuntimeSource;

/** A runtime found on (or installed by) this machine. */
export interface Runtime {
  kind: RuntimeKind;
  /** Stable selector stored per-project: 'system', 'managed:8.3.7', 'homebrew:8.3.7'. */
  id: string;
  /** Human label for pickers, e.g. "v20.11.0 (nvm)" / "PHP 8.3.7 (managed)". */
  label: string;
  /** Plain version string, e.g. "20.11.0" / "8.3.7" (empty if unknown). */
  version: string;
  /** Directory containing the runtime's executable(s). */
  binDir: string;
  source: RuntimeSource;
  /** True when installed/managed by us under the app data dir. */
  isManaged: boolean;
}

/** Back-compat alias — the Node UI/store still import `NodeRuntime`. */
export type NodeRuntime = Runtime;

/** An official release available to install. */
export interface RuntimeRelease {
  /** Version without any leading 'v', e.g. "20.11.0" / "8.3.7" / "3.12.3". */
  version: string;
  /** Optional human label (e.g. arch/build notes). */
  label?: string;
  /** LTS codename (e.g. "Iron") or false — node only. */
  lts?: string | false;
  date?: string;
  security?: boolean;
}

/** Back-compat alias — the Node dialog still imports `NodeRelease`. */
export type NodeRelease = RuntimeRelease;

/**
 * Progress frames emitted while installing a runtime. Download/extract drive
 * a byte progress bar (portable-zip strategy); `log` carries a line of stdout
 * for shell-out installers (brew/pyenv) where progress is indeterminate.
 */
export interface InstallProgress {
  kind: RuntimeKind;
  phase: 'download' | 'extract' | 'install' | 'log' | 'done';
  version: string;
  receivedBytes?: number;
  totalBytes?: number;
  /** Present on the `log` phase. */
  line?: string;
  /** Present on the final `done` frame. */
  runtime?: Runtime;
}

/** Back-compat alias — the Node dialog still imports `DownloadProgress`. */
export type DownloadProgress = InstallProgress;

/** A PHP extension on a managed install (bundled in the build, or external/PECL). */
export interface PhpExtension {
  /** Extension name as it appears in php.ini, e.g. "curl", "pdo_mysql". */
  name: string;
  /** Enabled via an active `extension=` line in php.ini. */
  enabled: boolean;
  /** Ships in the build's `ext/` dir (vs an external/PECL extension we fetched). */
  builtin: boolean;
  /** Reported as loaded by `php -m` (best-effort confirmation). */
  loaded?: boolean;
}

export interface RuntimeApi {
  /** Detected + managed runtimes of `kind` on this machine. */
  list(input: { kind: RuntimeKind }, ctx: ApiContext): Promise<Runtime[]>;

  /** Official releases of `kind` available to install. */
  listReleases(input: { kind: RuntimeKind }, ctx: ApiContext): Promise<RuntimeRelease[]>;

  /** Install an official build of `kind` (portable zip, silent installer, or brew/pyenv). */
  install(input: { kind: RuntimeKind; version: string }, ctx: ApiContext): AsyncStream<InstallProgress>;

  /** Remove a managed install. */
  uninstall(input: { kind: RuntimeKind; version: string }, ctx: ApiContext): Promise<void>;

  // ── PHP extension management (managed installs only) ──

  /** List a managed PHP install's extensions (bundled + external), with enabled/loaded state. */
  listExtensions(input: { version: string }, ctx: ApiContext): Promise<PhpExtension[]>;

  /** Enable/disable an extension by rewriting its `extension=` line in php.ini. */
  setExtension(input: { version: string; name: string; enabled: boolean }, ctx: ApiContext): Promise<void>;

  /** Fetch + enable an external/PECL extension matched to the managed PHP's ABI. */
  installPeclExtension(input: { version: string; name: string }, ctx: ApiContext): AsyncStream<InstallProgress>;
}
