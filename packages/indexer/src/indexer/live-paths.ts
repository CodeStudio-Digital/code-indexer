import { globIterate } from 'glob';
import { minimatch } from 'minimatch';
import { stat } from 'node:fs/promises';
import { buildScannerIgnore, GLOB_PRUNE_DIRS } from './scanner-ignore.js';
import { isHardExcluded } from './mapper.js';
import { getProjectIgnoreRulesAsync, projectGlobPrunePatterns } from '@mcp/shared/utils/project-ignore.js';

export interface LivePathSource { rootPath: string; prefix: string; ignorePatterns?: string[] }
export interface LivePaths {
  paths: string[]; totalMatches: number; totalMatchesExact: boolean; truncated: boolean; failedRoots: number;
}

/** Bounded discovery, using the same project policy as the structural scanner. */
export async function discoverLivePaths(sources: readonly LivePathSource[], options: {
  glob?: string; maxFiles?: number; signal?: AbortSignal; exclude?: ReadonlySet<string>; timeoutMs?: number;
} = {}): Promise<LivePaths> {
  const result: LivePaths = { paths: [], totalMatches: 0, totalMatchesExact: true, truncated: false, failedRoots: 0 };
  const max = Math.max(1, Math.min(200_000, Math.floor(options.maxFiles ?? 20_000)));
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  let examined = 0;
  for (const source of sources) {
    options.signal?.throwIfAborted();
    try {
      if (!(await stat(source.rootPath)).isDirectory()) throw new Error('Root unavailable');
      const rules = await getProjectIgnoreRulesAsync(source.rootPath);
      const ignored = buildScannerIgnore(source.rootPath, source.ignorePatterns ?? [], isHardExcluded, rules);
      for await (const raw of globIterate('**/*', {
        cwd: source.rootPath, nodir: true, dot: true, follow: false, signal: options.signal,
        ignore: [...GLOB_PRUNE_DIRS.map(d => `**/${d}/**`), ...projectGlobPrunePatterns(rules)],
      })) {
        options.signal?.throwIfAborted();
        if (++examined > 200_000 || Date.now() > deadline) {
          result.truncated = true; result.totalMatchesExact = false; return result;
        }
        const rel = raw.replace(/\\/g, '/');
        if (ignored.ignores(rel)) continue;
        const file = source.prefix ? `${source.prefix}/${rel}` : rel;
        if (options.glob && !minimatch(file, options.glob, { dot: true })) continue;
        if (options.exclude?.has(file)) continue;
        result.totalMatches++;
        if (result.paths.length >= max) {
          result.truncated = true; result.totalMatchesExact = false; return result;
        }
        result.paths.push(file);
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      result.failedRoots++;
      result.totalMatchesExact = false;
    }
  }
  return result;
}
