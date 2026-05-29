import { dirname, join } from 'node:path';
import { loadConfig } from '@mcp/shared/utils/config.js';

/**
 * Root dir holding every installed plugin, one subdir per namespace. Derived
 * from the configured DB dir (not homedir) so MCP_INDEX_DB redirects plugin
 * storage along with the database — keeps installs co-located and tests
 * fully sandboxed in a temp dir.
 */
export function pluginsRoot(): string {
  return join(dirname(loadConfig().dbPath), 'plugins');
}

export function pluginDir(namespace: string): string {
  return join(pluginsRoot(), namespace);
}
