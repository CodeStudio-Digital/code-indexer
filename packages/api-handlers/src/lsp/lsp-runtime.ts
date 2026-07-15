import { delimiter, dirname, join } from 'node:path';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { mcpDataDir } from '@mcp/shared/utils/config.js';
import { parseRuntimeVersions } from '@mcp/shared/utils/runtime-versions.js';
import type { Runtime } from '@mcp/api-bus';
import type { LspRuntimeResolution } from '@mcp/services/lsp/server-registry.js';
import { detectJavaRuntimes } from '../runtime/detect-java.js';
import { detectDotnetRuntimes } from '../runtime/detect-dotnet.js';

function majorOf(version: string): number {
  const major = Number.parseInt(version, 10);
  return Number.isFinite(major) ? major : 0;
}

function compareVersions(a: Runtime, b: Runtime): number {
  return b.version.localeCompare(a.version, undefined, { numeric: true });
}

// The detectors do a synchronous PATH probe + readdir sweep across every
// JDK/dotnet root ON THE ELECTRON MAIN LOOP, and this resolver runs on every
// LSP acquire and status poll — uncached it taxes each hover/completion with
// milliseconds of fs work (worse under Windows AV). A satisfied resolution is
// stable for a minute; an unsatisfied one re-probes fast so "install SDK →
// retry" stays responsive. The key embeds the project's runtime SELECTION, so
// changing it in Project Settings misses the cache without an explicit clear.
const TTL_SATISFIED_MS = 60_000;
const TTL_UNSATISFIED_MS = 5_000;
const runtimeCache = new Map<string, { at: number; res: LspRuntimeResolution }>();

/** Drop all cached resolutions — call after a runtime/server install or restart. */
export function invalidateLspRuntimeCache(): void {
  runtimeCache.clear();
}

export function resolveLspRuntime(
  db: CodeIndexDB,
  projectId: number,
  requirement: { kind: 'java' | 'dotnet'; minMajor: number },
): LspRuntimeResolution {
  const project = db.getProject(projectId);
  const selected = project ? parseRuntimeVersions(project.runtime_versions)[requirement.kind] : undefined;
  const key = `${projectId}:${requirement.kind}:${requirement.minMajor}:${selected ?? ''}`;
  const hit = runtimeCache.get(key);
  if (hit && Date.now() - hit.at < (hit.res.satisfied ? TTL_SATISFIED_MS : TTL_UNSATISFIED_MS)) {
    return hit.res;
  }
  const res = resolveUncached(requirement, selected);
  runtimeCache.set(key, { at: Date.now(), res });
  return res;
}

function resolveUncached(
  requirement: { kind: 'java' | 'dotnet'; minMajor: number },
  selected: string | undefined,
): LspRuntimeResolution {
  const runtimes = requirement.kind === 'java'
    ? detectJavaRuntimes(mcpDataDir())
    : detectDotnetRuntimes(mcpDataDir());
  const adequate = (runtime: Runtime): boolean => majorOf(runtime.version) >= requirement.minMajor;
  const candidates = [
    selected ? runtimes.find((runtime) => runtime.id === selected && adequate(runtime)) : undefined,
    ...runtimes.filter((runtime) => runtime.isManaged && adequate(runtime)).sort(compareVersions),
    ...runtimes.filter((runtime) => !runtime.isManaged && adequate(runtime)).sort(compareVersions),
  ];
  const picked = candidates.find(
    (runtime, index) => runtime && candidates.findIndex((candidate) => candidate?.id === runtime.id) === index,
  );

  if (!picked) {
    const label = requirement.kind === 'java' ? `JDK ${requirement.minMajor}+` : `.NET SDK ${requirement.minMajor}+`;
    return {
      ...requirement,
      satisfied: false,
      reason: `${label} is required; install or select a compatible runtime in Project Settings`,
    };
  }

  const command = requirement.kind === 'java'
    ? join(picked.binDir, process.platform === 'win32' ? 'java.exe' : 'java')
    : join(picked.binDir, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
  const env: Record<string, string> = { PATH: `${picked.binDir}${delimiter}${process.env.PATH ?? ''}` };
  if (requirement.kind === 'java') env.JAVA_HOME = dirname(picked.binDir);
  else {
    env.DOTNET_ROOT = picked.binDir;
    env.DOTNET_MULTILEVEL_LOOKUP = '0';
  }
  return { ...requirement, satisfied: true, version: picked.version, command, env };
}
