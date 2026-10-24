/**
 * Pure helpers shared between the company-mode routes that touch the
 * sandbox manager.
 *
 * Phase 8 part 2: extracted from `sessions.ts` ahead of the bigger
 * services + sandbox route split. These functions don't depend on the
 * route mount closure (no `app` / `deps` parameters) so they can be
 * tested in isolation and imported by any of the split files without
 * pulling in route plumbing.
 */
import { detectDockerfile } from '@mcp/services/sandbox/dockerfile-detector.js';
import { detectManifest } from '@mcp/services/sandbox/manifest-detector/detect.js';
import type { NodeManifest } from '@mcp/services/sandbox/manifest-detector/types.js';
import {
  BUILDER_STACKS,
  PROVISIONABLE_STACKS,
  type BuilderStack,
  type ProvisionableStack,
} from '@mcp/services/sandbox/types.js';

const BUILDER_STACKS_SET: ReadonlySet<string> = new Set(BUILDER_STACKS);
const PROVISIONABLE_STACKS_SET: ReadonlySet<string> = new Set(PROVISIONABLE_STACKS);

export function isBuilderStack(s: unknown): s is BuilderStack {
  return typeof s === 'string' && BUILDER_STACKS_SET.has(s);
}

/**
 * Permissive variant of {@link isBuilderStack} used by the sandbox
 * lifecycle routes (GET/POST /sandbox, restart-dev, logs). Accepts the
 * internal stacks (`'node-only'`) that aren't user-pickable but still
 * back real containers — without this, DS sessions can't have their
 * sandbox inspected or re-provisioned via the dashboard / API.
 */
export function isProvisionableStack(s: unknown): s is ProvisionableStack {
  return typeof s === 'string' && PROVISIONABLE_STACKS_SET.has(s);
}

export type ExternalProjectRuntime = 'dockerfile' | 'node';

export function isExternalProjectRuntime(value: unknown): value is ExternalProjectRuntime {
  return value === 'dockerfile' || value === 'node';
}

export function inferPortFromNodeScript(script: string): number | null {
  const match =
    script.match(/(?:^|\s)--port(?:=|\s+)(\d{2,5})(?=\s|$)/) ??
    script.match(/(?:^|\s)-p\s+(\d{2,5})(?=\s|$)/);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

export function inferNodeDevPort(
  stack: BuilderStack | ProvisionableStack,
  manifest: NodeManifest,
): number {
  const scriptName = manifest.devScriptName;
  const script = scriptName ? manifest.scripts[scriptName]?.toLowerCase() ?? '' : '';
  const scriptedPort = inferPortFromNodeScript(script);
  if (scriptedPort) return scriptedPort;
  if (stack === 'angular' || /\bng\s+serve\b/.test(script)) return 4200;
  if (/\bnext\s+(dev|start)\b/.test(script)) return 3000;
  return 5173;
}

type ExternalProvisionSpec =
  | {
      mountKind: 'external';
      imageSource: 'project_dockerfile';
      dockerfilePath: string;
      containerPortOverride: number;
      skipDefaultCommand: true;
    }
  | {
      mountKind: 'external';
      imageSource: 'default';
      containerPortOverride: number;
      skipDefaultCommand: false;
    };

export function resolveExternalProjectSpec(
  rootPath: string,
  stack: BuilderStack | ProvisionableStack,
  requestedRuntime?: ExternalProjectRuntime,
): ExternalProvisionSpec {
  const manifest = detectManifest(rootPath);
  const dockerfile = detectDockerfile(rootPath);
  const runtime =
    requestedRuntime ??
    (manifest?.kind === 'node' && manifest.devScriptName ? 'node' : 'dockerfile');

  if (runtime === 'node') {
    if (!manifest || manifest.kind !== 'node' || !manifest.devScriptName) {
      throw new Error(
        'Node dev image requires package.json with a dev, start, or serve script.',
      );
    }
    return {
      mountKind: 'external',
      imageSource: 'default',
      containerPortOverride: inferNodeDevPort(stack, manifest),
      skipDefaultCommand: false,
    };
  }

  const firstPort = dockerfile?.exposedPorts[0];
  if (!dockerfile || !firstPort) {
    throw new Error(
      "Dockerfile mode requires Dockerfile or Containerfile with EXPOSE <port>. Choose Node dev image for package.json projects.",
    );
  }
  return {
    mountKind: 'external',
    imageSource: 'project_dockerfile',
    dockerfilePath: dockerfile.path,
    containerPortOverride: firstPort,
    skipDefaultCommand: true,
  };
}

// Sandbox limits lightweight sanity validation. We don't parse the
// units — Podman/Docker will reject `"pancakes"` at run time with a
// clear error. The point here is to stop obvious nonsense (empty
// strings, NaN) before it's persisted.
const MEMORY_RE = /^\d+(\.\d+)?\s*(b|k|m|g|kb|mb|gb|ki|mi|gi)?$/i;
const CPUS_RE = /^\d+(\.\d+)?$/;

interface SandboxLimitsInput {
  memory?: string;
  cpus?: string;
  pids?: number;
}

export function validateLimits(limits: SandboxLimitsInput | undefined): string | null {
  if (!limits) return null;
  if (limits.memory !== undefined && !MEMORY_RE.test(limits.memory)) {
    return `Invalid builder.limits.memory: '${limits.memory}'. Expected e.g. '512m', '1g', '2048'.`;
  }
  if (limits.cpus !== undefined && !CPUS_RE.test(limits.cpus)) {
    return `Invalid builder.limits.cpus: '${limits.cpus}'. Expected a number like '0.5', '1', '2'.`;
  }
  if (limits.pids !== undefined && (!Number.isInteger(limits.pids) || limits.pids < 16)) {
    return `Invalid builder.limits.pids: '${limits.pids}'. Expected integer ≥ 16.`;
  }
  return null;
}
