import { createRequire } from 'node:module';
import { basename } from 'node:path';
import { loadNativeHostBridge, type NativeDuplexOptions } from '@mcp/agent-runtime-host';
import type { McpServerConfig } from '@mcp/store/mcp-server-store.js';
import { loadProductNativeRuntimePackage } from '../native-runtime-package.js';
import { NativeMcpStdioTransport } from './NativeMcpStdioTransport.js';

/** Reuse the pinned MCP SDK's Windows command/shim compatibility parser. Only
 * command construction is reused; cross-spawn never launches this process. */
export function nativeMcpStdioOptions(config: McpServerConfig): NativeDuplexOptions {
  if (!config.command) throw new Error('MCP stdio command is missing');
  const requireLocal = createRequire(import.meta.url);
  const requireSdk = createRequire(requireLocal.resolve('@modelcontextprotocol/sdk/client/stdio.js'));
  const spawn = requireSdk('cross-spawn') as { _parse?: (command: string, args: string[], options: unknown) => {
    command: string; args: string[]; options: { windowsVerbatimArguments?: boolean };
  } };
  if (typeof spawn._parse !== 'function') throw new Error('MCP SDK command parser is incompatible');
  const requireSpawn = createRequire(requireSdk.resolve('cross-spawn'));
  const which = requireSpawn('which') as { sync(command: string, options: { path?: string }): string };
  const entries = new Map<string, [string, string]>();
  for (const [key, value] of Object.entries({ ...process.env, ...config.env })) {
    if (value !== undefined) entries.set(key.toLowerCase(), [key, value]);
  }
  const environment = Object.fromEntries(entries.values());
  const parsed = spawn._parse(config.command, config.args ?? [], { env: environment });
  const executable = which.sync(parsed.command, { path: entries.get('path')?.[1] });
  const args = [...parsed.args];
  if (parsed.options.windowsVerbatimArguments) {
    if (basename(executable).toLowerCase() !== 'cmd.exe' || args.length !== 4
      || args.slice(0, 3).join(' ').toLowerCase() !== '/d /s /c'
      || !args[3]!.startsWith('"') || !args[3]!.endsWith('"')) throw new Error('Unsupported MCP command shim');
    // The native launcher owns the outer cmd /S /C quotation pair.
    args[3] = args[3]!.slice(1, -1);
  }
  return { executable, arguments: args, cwd: process.cwd(), environment, timeoutMs: 86_400_000 };
}

export async function createNativeMcpStdioTransport(config: McpServerConfig): Promise<NativeMcpStdioTransport> {
  const binding = loadNativeHostBridge(await loadProductNativeRuntimePackage());
  if (!binding.startNativeHostDuplexProcess) throw new Error('Native MCP stdio API is unavailable');
  const options = nativeMcpStdioOptions(config);
  return new NativeMcpStdioTransport(() => binding.startNativeHostDuplexProcess!(options));
}
