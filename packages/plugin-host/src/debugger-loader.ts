import { loadConfig } from '@mcp/shared/utils/config.js';
import { InstalledPluginStore } from '@mcp/store/installed-plugin-store.js';
import type { DebugAdapterRuntime, DebuggerDecl } from '@mcp/plugin-sdk';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { pluginDir } from './paths.js';

export interface DebuggerPluginRef {
  namespace: string;
  source: string;
  debuggers: DebuggerDecl[];
  runtime: {
    file: string;
    adapters: string[];
  } | null;
}

export interface LoadedDebugAdapter {
  namespace: string;
  pluginRoot: string;
  contribution: DebuggerDecl;
  runtime: DebugAdapterRuntime;
}

/** Read enabled debugger declarations without executing plugin code. */
export function listDebuggerPlugins(): DebuggerPluginRef[] {
  const { dbPath } = loadConfig();
  const store = new InstalledPluginStore(dbPath);
  const out: DebuggerPluginRef[] = [];
  try {
    for (const plugin of store.list({ enabled: true })) {
      const contribution = (plugin.contributions ?? {}) as {
        worker?: string | null;
        debuggers?: DebuggerDecl[];
        debuggerRuntime?: {
          protocol?: string;
          entry?: string;
          adapters?: string[];
        } | null;
      };
      const debuggers = Array.isArray(contribution.debuggers) ? contribution.debuggers : [];
      if (debuggers.length === 0) continue;
      const runtime =
        contribution.debuggerRuntime?.protocol === 'debug-adapter-v1' &&
        Array.isArray(contribution.debuggerRuntime.adapters) &&
        contribution.debuggerRuntime.adapters.length > 0
          ? {
              file: join(
                pluginDir(plugin.namespace),
                contribution.debuggerRuntime.entry ?? contribution.worker ?? './dist/plugin.js',
              ),
              adapters: contribution.debuggerRuntime.adapters,
            }
          : null;
      out.push({
        namespace: plugin.namespace,
        source: plugin.source,
        debuggers,
        runtime,
      });
    }
  } finally {
    store.close();
  }
  return out;
}

/** Executable debugger adapters are first-party only in v1. */
export function isFirstPartyBundledDebugger(ref: DebuggerPluginRef): boolean {
  return ref.source === 'bundled' && ref.namespace.endsWith('-debugger');
}

export interface LoadDebugAdapterOptions {
  refs?: DebuggerPluginRef[];
  firstParty?: (ref: DebuggerPluginRef) => boolean;
}

/**
 * Resolve and import one named debug adapter after enforcing bundled
 * provenance. An untrusted declaration remains visible as metadata but can
 * never cross the executable runtime boundary.
 */
export async function loadDebugAdapter(
  adapterId: string,
  options: LoadDebugAdapterOptions = {},
): Promise<LoadedDebugAdapter> {
  const refs = options.refs ?? listDebuggerPlugins();
  const ref = refs.find((candidate) => candidate.debuggers.some((d) => d.id === adapterId));
  if (!ref) throw new Error(`debug adapter '${adapterId}' is not installed or enabled`);
  if (!(options.firstParty ?? isFirstPartyBundledDebugger)(ref)) {
    throw new Error(`debug adapter '${adapterId}' is not a trusted bundled runtime`);
  }
  if (!ref.runtime?.adapters.includes(adapterId)) {
    throw new Error(`plugin '${ref.namespace}' does not own executable adapter '${adapterId}'`);
  }

  const module = (await import(`${pathToFileURL(ref.runtime.file).href}?debugger=${Date.now()}`)) as {
    debugAdapter?: DebugAdapterRuntime;
    debugAdapters?: DebugAdapterRuntime[];
  };
  const runtimes = [
    ...(module.debugAdapter ? [module.debugAdapter] : []),
    ...(Array.isArray(module.debugAdapters) ? module.debugAdapters : []),
  ];
  const runtime = runtimes.find((candidate) => candidate?.sdkVersion === 1 && candidate.id === adapterId);
  if (!runtime || typeof runtime.resolveAdapter !== 'function' || typeof runtime.resolveConfiguration !== 'function') {
    throw new Error(`plugin '${ref.namespace}' exported no valid debug-adapter-v1 runtime for '${adapterId}'`);
  }

  return {
    namespace: ref.namespace,
    pluginRoot: dirname(dirname(ref.runtime.file)),
    contribution: ref.debuggers.find((d) => d.id === adapterId)!,
    runtime,
  };
}
