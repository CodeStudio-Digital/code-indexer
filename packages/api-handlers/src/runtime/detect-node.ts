/**
 * Node.js runtime detection — enumerates the Node versions installed on
 * the machine so the project picker can offer a real choice (WebStorm
 * style). Mirrors terminal/shells.ts: best-effort, MUST NOT throw — a
 * missing version manager simply yields fewer entries.
 *
 * Sources: system PATH, Program Files (Windows), nvm / nvm-windows, fnm,
 * volta, and our own managed installs under the app data dir.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { NodeRuntime, NodeSource } from '@mcp/api-bus';

const isWin = process.platform === 'win32';
const NODE_EXE = isWin ? 'node.exe' : 'node';

/** Managed installs live here: `<managedDir>/node/v<version>/...`. */
export function managedNodeRoot(managedDir: string): string {
  return join(managedDir, 'node');
}

export function detectNodeRuntimes(managedDir: string): NodeRuntime[] {
  const out: NodeRuntime[] = [];
  const seen = new Set<string>();
  const add = (r: NodeRuntime | null): void => {
    if (!r || seen.has(r.binDir.toLowerCase())) return;
    seen.add(r.binDir.toLowerCase());
    out.push(r);
  };

  try {
    add(systemRuntime());
    if (isWin) add(programFilesRuntime());
    for (const r of versionManagerRuntimes()) add(r);
    for (const r of managedRuntimes(managedDir)) add(r);
  } catch {
    /* defensive — return whatever we gathered */
  }
  return out;
}

/** `node` on PATH → id 'system'. */
function systemRuntime(): NodeRuntime | null {
  const exe = findOnPath(NODE_EXE);
  if (!exe) return null;
  const binDir = dirOf(exe);
  return runtime('system', 'system', binDir, false);
}

function programFilesRuntime(): NodeRuntime | null {
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  const binDir = join(pf, 'nodejs');
  if (!hasNode(binDir)) return null;
  return runtime('programfiles', 'programfiles', binDir, false);
}

/** nvm (unix + windows), fnm, volta — each keyed by version folder. */
function versionManagerRuntimes(): NodeRuntime[] {
  const out: NodeRuntime[] = [];
  const home = homedir();

  // nvm (unix): ~/.nvm/versions/node/v20.11.0/bin
  scanVersioned(join(home, '.nvm', 'versions', 'node'), 'nvm', out);
  // nvm-windows: %NVM_HOME% or %APPDATA%\nvm with v* subfolders (node.exe at root)
  const nvmWin = process.env.NVM_HOME ?? join(process.env.APPDATA ?? '', 'nvm');
  scanVersioned(nvmWin, 'nvm', out);
  // fnm
  scanVersioned(join(home, '.fnm', 'node-versions'), 'fnm', out, 'installation');
  scanVersioned(join(home, '.local', 'share', 'fnm', 'node-versions'), 'fnm', out, 'installation');
  // volta: ~/.volta/tools/image/node/20.11.0/bin
  scanVersioned(join(home, '.volta', 'tools', 'image', 'node'), 'volta', out);

  return out;
}

function managedRuntimes(managedDir: string): NodeRuntime[] {
  const out: NodeRuntime[] = [];
  scanVersioned(managedNodeRoot(managedDir), 'managed', out);
  return out;
}

/**
 * Scan a parent dir whose children are version folders (e.g. `v20.11.0`
 * or `20.11.0`). `inner` optionally descends one fixed level first
 * (fnm nests the install under `installation/`).
 */
function scanVersioned(parent: string, source: NodeSource, out: NodeRuntime[], inner?: string): void {
  if (!parent || !existsSync(parent)) return;
  let entries: string[];
  try {
    entries = readdirSync(parent).filter((n) => {
      try {
        return statSync(join(parent, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return;
  }
  for (const name of entries) {
    const root = inner ? join(parent, name, inner) : join(parent, name);
    const binDir = findNodeBinDir(root);
    if (!binDir) continue;
    const version = normalizeVersion(name) || probeVersion(binDir);
    out.push(runtime(source, source, binDir, source === 'managed', version));
  }
}

/** Build a NodeRuntime, deriving version/label/id. */
function runtime(
  idKind: string,
  source: NodeSource,
  binDir: string,
  isManaged: boolean,
  knownVersion?: string,
): NodeRuntime {
  const version = knownVersion || probeVersion(binDir);
  const id =
    idKind === 'system' || idKind === 'programfiles'
      ? idKind
      : `${source}:${version || binDir}`;
  const label = version ? `v${version} (${source})` : `${source} (${binDir})`;
  return { kind: 'node', id, label, version, binDir, source, isManaged };
}

/** Locate the dir holding the node executable within `root`. */
function findNodeBinDir(root: string): string | null {
  if (!existsSync(root)) return null;
  const candidates = [root, join(root, 'bin')];
  for (const c of candidates) if (hasNode(c)) return c;
  // One sublevel (e.g. extracted `node-v20.11.0-win-x64/`).
  try {
    for (const name of readdirSync(root)) {
      const sub = join(root, name);
      try {
        if (!statSync(sub).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const c of [sub, join(sub, 'bin')]) if (hasNode(c)) return c;
    }
  } catch {
    /* unreadable — give up */
  }
  return null;
}

function hasNode(dir: string): boolean {
  return !!dir && existsSync(join(dir, NODE_EXE));
}

function probeVersion(binDir: string): string {
  try {
    const out = execFileSync(join(binDir, NODE_EXE), ['-v'], { timeout: 2000, encoding: 'utf8' });
    return normalizeVersion(out.trim());
  } catch {
    return '';
  }
}

/** "v20.11.0" / "20.11.0" → "20.11.0"; junk → "". */
function normalizeVersion(raw: string): string {
  const m = /(\d+\.\d+\.\d+)/.exec(raw);
  return m ? m[1] : '';
}

function dirOf(file: string): string {
  const idx = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return idx >= 0 ? file.slice(0, idx) : file;
}

function findOnPath(exe: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, exe);
    if (existsSync(full)) return full;
  }
  return null;
}
