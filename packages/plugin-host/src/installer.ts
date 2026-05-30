import { mkdir, rm, rename, access } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { InstalledPluginStore } from '@mcp/store/installed-plugin-store.js';
import type { PluginSource } from '@mcp/plugin-sdk';
import { materialize } from './sources/index.js';
import { loadManifest } from './manifest-loader.js';
import { applySkills } from './apply/skills.js';
import { applyMcp } from './apply/mcp.js';
import { buildContributions } from './apply/contributions.js';
import { pluginsRoot, pluginDir } from './paths.js';
import type { InstallResult } from './types.js';

export interface InstallPluginOptions {
  source: PluginSource;
  /** Override the namespace (defaults to the plugin.json `name`). */
  namespace?: string;
  /** Replace an existing install of the same namespace. */
  overwrite?: boolean;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Install a Claude Code-compatible plugin bundle by namespace. Materializes
 * the bundle to disk, validates plugin.json/.app.json, then applies skills +
 * MCP servers + UI/agent contributions and records the install.
 */
export async function installPlugin(opts: InstallPluginOptions): Promise<InstallResult> {
  const { dbPath } = loadConfig();
  const root = pluginsRoot();
  await mkdir(root, { recursive: true });

  const stagingDir = join(root, `.staging-${randomUUID()}`);
  try {
    const { ref } = await materialize(opts.source, stagingDir);

    const { manifest, app } = await loadManifest(stagingDir);
    const namespace = (opts.namespace ?? manifest.name).toLowerCase();

    const baseDir = pluginDir(namespace);
    const exists = await pathExists(baseDir);
    if (exists && !opts.overwrite) {
      throw new Error(
        `Plugin "${namespace}" is already installed (pass overwrite to replace)`,
      );
    }
    if (exists) await rm(baseDir, { recursive: true, force: true });
    await rename(stagingDir, baseDir);

    const repo = opts.source.source === 'github' ? (opts.source.repo ?? null) : null;
    const skills = await applySkills({ dbPath, baseDir, namespace, repo, commit: ref });
    const mcp = await applyMcp({ dbPath, baseDir, namespace });
    const contributions = buildContributions(app);

    if (skills.installed.length === 0 && mcp.installed.length === 0 && !contributions) {
      await rm(baseDir, { recursive: true, force: true });
      throw new Error(
        `Plugin "${namespace}" contributed no skills, MCP servers, or app contributions`,
      );
    }

    const store = new InstalledPluginStore(dbPath);
    try {
      store.upsert({
        namespace,
        name: manifest.name,
        version: manifest.version,
        source: opts.source.source,
        source_ref: opts.source as unknown as Record<string, unknown>,
        manifest: manifest as unknown as Record<string, unknown>,
        contributions: contributions as unknown as Record<string, unknown> | null,
        enabled: true,
      });
      // Install == consent (the Claude Code / VS Code model): grant exactly the
      // capabilities the plugin declared. They're shown + revocable in the
      // Plugins manager. Without this, ctx.fs/exec/storage stay denied.
      if (contributions?.permissions) {
        store.setPermissionsGranted(
          namespace,
          contributions.permissions as unknown as Record<string, unknown>,
        );
      }
    } finally {
      store.close();
    }

    return {
      namespace,
      name: manifest.name,
      version: manifest.version,
      source: opts.source,
      ref,
      baseDir,
      skills: skills.installed,
      mcpServers: mcp.installed,
      contributions: app,
      warnings: [...skills.warnings, ...mcp.warnings],
    };
  } finally {
    // No-op after a successful rename; cleans the staging dir on any failure.
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}
