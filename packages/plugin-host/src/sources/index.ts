import type { PluginSource } from '@mcp/plugin-sdk';
import { materializeLocal } from './fetch-local.js';
import { materializeGithub } from './fetch-github.js';
import { materializeMarket } from './fetch-market.js';

export interface MaterializeResult {
  /** Commit SHA for github sources; null otherwise. */
  ref: string | null;
}

/** Populate `stagingDir` on disk with the plugin's files from `source`. */
export async function materialize(
  source: PluginSource,
  stagingDir: string,
): Promise<MaterializeResult> {
  switch (source.source) {
    case 'local':
    case 'bundled':
      // 'bundled' is a first-party plugin shipped with the app; it lives on disk
      // exactly like a local source, only the recorded `source` tag differs.
      if (!source.path) throw new Error(`${source.source} source requires "path"`);
      return materializeLocal(source.path, stagingDir);
    case 'github':
      if (!source.repo) throw new Error('github source requires "repo"');
      return materializeGithub(source.repo, source.ref, stagingDir);
    case 'market':
      if (!source.name) throw new Error('market source requires "name"');
      return materializeMarket(source.name, source.ref, stagingDir);
    case 'url':
      throw new Error('source "url" is not supported yet');
    default:
      throw new Error(
        `unknown plugin source "${(source as { source: string }).source}"`,
      );
  }
}
