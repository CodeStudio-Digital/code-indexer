import type { PluginSource, AppManifest } from '@mcp/plugin-sdk';

export interface InstalledSkillSummary {
  id: string;
  name: string;
  kind: 'skill' | 'command';
  slash_command: string | null;
}

export interface InstalledMcpSummary {
  id: string;
  name: string;
  transport: string;
}

export interface InstallResult {
  namespace: string;
  name: string;
  version: string;
  source: PluginSource;
  /** Commit SHA for github sources; null otherwise. */
  ref: string | null;
  baseDir: string;
  skills: InstalledSkillSummary[];
  mcpServers: InstalledMcpSummary[];
  contributions: AppManifest | null;
  warnings: string[];
}
