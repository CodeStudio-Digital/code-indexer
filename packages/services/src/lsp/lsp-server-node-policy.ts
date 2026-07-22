import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { LspManagerDeps, LspNodeRuntimeStatus } from './lsp-server-manager-types.js';
import type { LspServerDef } from './server-registry.js';

type Version = readonly [major: number, minor: number, patch: number];
export type LspNodeRequirement = LspServerDef | string | undefined;

const DEFAULT_NPM_NODE_RANGE = '>=18.0.0';
const VERSION_TOKEN = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;
const COMPARATOR_TOKEN = /^(\^|~|>=|<=|>|<)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const probedVersions = new Map<string, string | undefined>();

function parseVersion(raw: string): Version | null {
  const exact = VERSION_TOKEN.exec(raw.trim());
  const path = /(?:^|[\\/])v?(\d+)\.(\d+)\.(\d+)(?=[\\/]|$)/.exec(raw);
  const match = exact ?? path;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function displayVersion(raw: string): string | undefined {
  const version = parseVersion(raw);
  return version ? version.join('.') : undefined;
}

function nodeBinVersion(nodeBin: string): string | undefined {
  const embedded = displayVersion(nodeBin);
  if (embedded) return embedded;
  if (probedVersions.has(nodeBin)) return probedVersions.get(nodeBin);
  let version: string | undefined;
  try {
    const executable = join(nodeBin, process.platform === 'win32' ? 'node.exe' : 'node');
    version = displayVersion(execFileSync(executable, ['--version'], {
      encoding: 'utf8', timeout: 2_000, windowsHide: true,
    }).trim());
  } catch { /* an unavailable selected runtime is reported as incompatible */ }
  if (probedVersions.size >= 64) probedVersions.delete(probedVersions.keys().next().value!);
  probedVersions.set(nodeBin, version);
  return version;
}

function compare(left: Version, right: Version): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function caretUpper([major, minor, patch]: Version): Version {
  if (major > 0) return [major + 1, 0, 0];
  if (minor > 0) return [0, minor + 1, 0];
  return [0, 0, patch + 1];
}

function tokenSatisfied(version: Version, token: string): boolean {
  const match = COMPARATOR_TOKEN.exec(token);
  if (!match) return false;
  const target = parseVersion(match[2]);
  if (!target) return false;
  const order = compare(version, target);
  switch (match[1] ?? '') {
    case '>=': return order >= 0;
    case '<=': return order <= 0;
    case '>': return order > 0;
    case '<': return order < 0;
    case '^': return order >= 0 && compare(version, caretUpper(target)) < 0;
    case '~': return order >= 0 && compare(version, [target[0], target[1] + 1, 0]) < 0;
    default: return order === 0;
  }
}

export function satisfiesLspNodeRange(rawVersion: string, range: string): boolean {
  const version = parseVersion(rawVersion);
  if (!version) return false;
  return range.trim().split(/\s*\|\|\s*/).some((clause) => {
    const tokens = clause.trim().split(/\s+/).filter(Boolean);
    return tokens.length > 0 && tokens.every((token) => tokenSatisfied(version, token));
  });
}

export function lspNodeRange(requirement: LspNodeRequirement): string {
  if (typeof requirement === 'string') return requirement;
  return requirement?.serverNodeRange ?? DEFAULT_NPM_NODE_RANGE;
}

/** Uses the effective profile range; ordinary npm servers retain the Node 18 floor. */
export function isSupportedLspNodeVersion(
  rawVersion: string,
  requirement?: LspNodeRequirement,
): boolean {
  return satisfiesLspNodeRange(rawVersion, lspNodeRange(requirement));
}

/** Read-only status used by the install prompt before a server is spawned. */
export function lspNodeRuntimeStatus(
  deps: Pick<LspManagerDeps, 'resolveNodeBin'>,
  projectId: number,
  def: LspServerDef,
): LspNodeRuntimeStatus {
  const range = lspNodeRange(def);
  const managed = deps.resolveNodeBin(projectId);
  const managedVersion = managed ? nodeBinVersion(managed) : undefined;
  if (managed && managedVersion && isSupportedLspNodeVersion(managedVersion, def)) {
    return { range, satisfied: true, source: 'project', version: managedVersion };
  }
  const appVersion = process.versions.node;
  if (isSupportedLspNodeVersion(appVersion, def)) {
    return { range, satisfied: true, source: 'app', version: appVersion };
  }
  const reason = managed
    ? `language server requires Node ${range}; project Node ${managedVersion ?? managed} and app Node ${appVersion} are incompatible`
    : `language server requires Node ${range}; app Node ${appVersion} is incompatible`;
  return {
    range,
    satisfied: false,
    version: managedVersion ?? appVersion,
    reason,
  };
}

/** Resolve Node for the language server independently from the app runtime. */
export function resolveLspServerNode(
  deps: Pick<LspManagerDeps, 'resolveNodeBin' | 'log'>,
  projectId: number,
  def: LspServerDef,
): { command: string; env?: Record<string, string> } {
  const range = lspNodeRange(def);
  const nodeBin = deps.resolveNodeBin(projectId);
  if (nodeBin) {
    const version = nodeBinVersion(nodeBin);
    if (version && isSupportedLspNodeVersion(version, def)) {
      return { command: join(nodeBin, process.platform === 'win32' ? 'node.exe' : 'node') };
    }
    deps.log?.(
      `[lsp] project ${projectId} managed node (${nodeBin}) does not satisfy ${range} — using app runtime`,
    );
  }
  if (!isSupportedLspNodeVersion(process.versions.node, def)) {
    throw new Error(`language server requires Node ${range}; app runtime is ${process.versions.node}`);
  }
  return process.versions.electron
    ? { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
    : { command: 'node' };
}
