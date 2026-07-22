/**
 * Executable debugger runtime contract for trusted bundled plugins.
 *
 * This is deliberately independent from the plugin worker contract. The host
 * imports the named export only after proving bundled first-party provenance,
 * then remains the sole owner of child processes, sockets and DAP messages.
 */

export interface DebugAdapterTcpTransport {
  kind: 'tcp';
  /** Must be loopback in debug-adapter-v1. */
  host: '127.0.0.1' | '::1';
  /** The host replaces this token in command arguments with a reserved port. */
  portToken: string;
  connectTimeoutMs?: number;
}

export interface DebugAdapterStdioTransport {
  kind: 'stdio';
}

export interface DebugAdapterExecutable {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  transport: DebugAdapterTcpTransport | DebugAdapterStdioTransport;
}

export interface DebugAdapterResolveContext {
  pluginRoot: string;
  projectRoot: string;
  platform: NodeJS.Platform;
  nodePath: string;
}

export interface DebugRunnerInput {
  manager: string;
  /** Script name, for example `dev` from package.json. */
  script?: string;
  executable?: string;
  args?: string[];
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface DebugConfigurationInput {
  request: 'launch' | 'attach';
  name?: string;
  projectRoot: string;
  file?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  runner?: DebugRunnerInput;
  /**
   * Loopback port selected and temporarily reserved by the host for a target
   * runtime that cannot publish its own inspector address (for example
   * `wrangler dev`). Plugins may ignore it when their adapter discovers
   * targets dynamically.
   */
  targetPort?: number;
  /** Adapter-specific explicit overrides, applied last by the plugin. */
  configuration?: Record<string, unknown>;
}

/** A target process that the trusted host launches and owns outside the DAP. */
export interface DebugTargetLaunch {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Files materialized by the host immediately before launching the target. */
  preparedFiles?: Array<{
    /** Absolute path, or a path relative to cwd. Must remain inside cwd. */
    path: string;
    content: string;
  }>;
  /**
   * Literal output emitted by the target when its inspector is ready for the
   * adapter to attach. Output from both stdout and stderr is observed.
   */
  readyPattern?: string;
  /** Maximum time to wait for readyPattern. Defaults to 30 seconds. */
  readyTimeoutMs?: number;
}

/**
 * Structured result for runtimes whose process lifecycle is separate from the
 * adapter connection. Wrangler is the canonical example: the host launches
 * `wrangler dev`, while js-debug attaches to Workerd's Inspector endpoint.
 */
export interface DebugResolvedConfiguration {
  configuration: Record<string, unknown>;
  dapRequest: 'launch' | 'attach';
  target?: DebugTargetLaunch;
}

export function isDebugResolvedConfiguration(
  value: Record<string, unknown> | DebugResolvedConfiguration,
): value is DebugResolvedConfiguration {
  return value !== null
    && typeof value === 'object'
    && (value as Partial<DebugResolvedConfiguration>).configuration !== undefined
    && ((value as Partial<DebugResolvedConfiguration>).dapRequest === 'launch'
      || (value as Partial<DebugResolvedConfiguration>).dapRequest === 'attach');
}

export interface DebugAdapterRuntime {
  readonly sdkVersion: 1;
  readonly id: string;
  resolveAdapter(context: DebugAdapterResolveContext): DebugAdapterExecutable;
  resolveConfiguration(input: DebugConfigurationInput): Record<string, unknown> | DebugResolvedConfiguration;
}

export function defineDebugAdapter(
  runtime: Omit<DebugAdapterRuntime, 'sdkVersion'>,
): DebugAdapterRuntime {
  if (!runtime.id || typeof runtime.resolveAdapter !== 'function' || typeof runtime.resolveConfiguration !== 'function') {
    throw new TypeError('debug adapter requires id, resolveAdapter and resolveConfiguration');
  }
  return Object.freeze({ sdkVersion: 1 as const, ...runtime });
}
