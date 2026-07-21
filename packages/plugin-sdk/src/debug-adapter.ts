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
  /** Adapter-specific explicit overrides, applied last by the plugin. */
  configuration?: Record<string, unknown>;
}

export interface DebugAdapterRuntime {
  readonly sdkVersion: 1;
  readonly id: string;
  resolveAdapter(context: DebugAdapterResolveContext): DebugAdapterExecutable;
  resolveConfiguration(input: DebugConfigurationInput): Record<string, unknown>;
}

export function defineDebugAdapter(
  runtime: Omit<DebugAdapterRuntime, 'sdkVersion'>,
): DebugAdapterRuntime {
  if (!runtime.id || typeof runtime.resolveAdapter !== 'function' || typeof runtime.resolveConfiguration !== 'function') {
    throw new TypeError('debug adapter requires id, resolveAdapter and resolveConfiguration');
  }
  return Object.freeze({ sdkVersion: 1 as const, ...runtime });
}
