import { resolve } from 'node:path';
import { getProjectDiscoveryCacheVersion, scanProjectTree } from '@mcp/shared/utils/project-ignore.js';
import type { DotnetProjectScan } from './dotnet-project-files.js';

interface Manifests { dotnet: DotnetProjectScan; composer: string[] }
const cache = new Map<string, { version: string; expires: number; value: Manifests }>();
const pending = new Map<string, Promise<Manifests>>();

/** PHP and .NET discovery visit the same directories on project open. Share paths,
 * while leaving script contents and install state live for each detection. */
export function scanRunnerManifests(root: string, maxDepth = 6): Promise<Manifests> {
  const key = JSON.stringify([resolve(root), maxDepth]);
  const version = getProjectDiscoveryCacheVersion(root);
  const hit = cache.get(key);
  if (hit?.version === version && hit.expires > Date.now()) return Promise.resolve(hit.value);
  const flight = key + version;
  const existing = pending.get(flight);
  if (existing) return existing;
  const work = scanProjectTree(root, {
    maxDepth,
    includeUnityContents: true,
    // Composer-installed dependencies own their own manifests. A directory
    // named vendor in a non-PHP project may still hold a real .NET project.
    skipDirectory: (name, siblings) => name === 'vendor' && siblings.some(entry => entry.name.toLowerCase() === 'composer.json'),
    acceptFile: name => name === 'composer.json' || /\.(?:csproj|slnx?)$/.test(name),
  }).then(({ files, rules }) => {
    const unityRoot = rules.scopes.some(scope => scope.path === '' && scope.kind === 'unity');
    const value = {
      dotnet: {
        unityRoot,
        projects: unityRoot ? [] : files.filter(file => /\.csproj$/i.test(file)).sort(),
        solutions: unityRoot ? [] : files.filter(file => /\.slnx?$/i.test(file)).sort(),
      },
      composer: files.filter(file => /(?:^|\/)composer\.json$/i.test(file) && !/(?:^|\/)vendor\//i.test(file)).sort(),
    };
    if (getProjectDiscoveryCacheVersion(root) === version) {
      cache.delete(key);
      if (cache.size >= 64) cache.delete(cache.keys().next().value!);
      cache.set(key, { version, expires: Date.now() + 30_000, value });
    }
    return value;
  }).finally(() => pending.delete(flight));
  pending.set(flight, work);
  return work;
}

export function clearRunnerManifestCache(): void { cache.clear(); }
