import { rm } from 'node:fs/promises';
import { SkillStore } from '@mcp/store/skill-store.js';
import { McpServerStore } from '@mcp/store/mcp-server-store.js';
import { InstalledPluginStore } from '@mcp/store/installed-plugin-store.js';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { pluginDir } from './paths.js';

export interface UninstallResult {
  namespace: string;
  skillsRemoved: number;
  mcpRemoved: number;
  baseDir: string;
}

/**
 * Tear down everything a namespace installed: its skills (tagged with the
 * namespace as author), its MCP servers (config.installed_by_namespace), the
 * installed_plugins row, and the on-disk plugin dir.
 */
export async function uninstallPlugin(namespace: string): Promise<UninstallResult> {
  const { dbPath } = loadConfig();

  const skillStore = new SkillStore(dbPath);
  let skillsRemoved = 0;
  try {
    for (const s of skillStore.listSkills({ source: 'imported' })) {
      const owned = s.author === namespace || (s.tags?.includes(namespace) ?? false);
      if (owned) {
        skillStore.deleteSkill(s.id);
        skillsRemoved++;
      }
    }
  } finally {
    skillStore.close();
  }

  const mcpStore = new McpServerStore(dbPath);
  let mcpRemoved = 0;
  try {
    for (const srv of mcpStore.listServers()) {
      const cfg = (srv.config ?? {}) as { installed_by_namespace?: string };
      if (cfg.installed_by_namespace === namespace) {
        mcpStore.deleteServer(srv.id);
        mcpRemoved++;
      }
    }
  } finally {
    mcpStore.close();
  }

  const pluginStore = new InstalledPluginStore(dbPath);
  try {
    pluginStore.delete(namespace);
  } finally {
    pluginStore.close();
  }

  const baseDir = pluginDir(namespace);
  await rm(baseDir, { recursive: true, force: true });
  return { namespace, skillsRemoved, mcpRemoved, baseDir };
}
