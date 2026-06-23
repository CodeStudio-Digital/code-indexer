/**
 * Python runtime detection — enumerates Python installs on the machine.
 * Best-effort, MUST NOT throw (mirrors detect-node.ts).
 *
 * Sources: system PATH, our managed installs (`<dataDir>/python/<ver>/`),
 * the Windows `py` launcher, pyenv (unix + pyenv-win), Homebrew, and
 * python.org installs (Windows Programs dir + macOS framework).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Runtime, RuntimeSource } from '@mcp/api-bus';
import { managedRuntimeRoot } from './runtime-shared.js';
import { dirOf, findOnPath, isExecutable, isWin, listDirs, normalizeSemver, probe } from './detect-shared.js';

const PY_EXES = isWin ? ['python.exe'] : ['python3', 'python'];

export function detectPythonRuntimes(managedDir: string): Runtime[] {
  const out: Runtime[] = [];
  const seen = new Set<string>();
  const add = (r: Runtime | null): void => {
    if (!r || seen.has(r.binDir.toLowerCase())) return;
    seen.add(r.binDir.toLowerCase());
    out.push(r);
  };

  try {
    add(systemRuntime());
    for (const r of managedRuntimes(managedDir)) add(r);
    for (const r of pyenvRuntimes()) add(r);
    if (isWin) {
      for (const r of pyLauncherRuntimes()) add(r);
      for (const r of pythonOrgWinRuntimes()) add(r);
    } else {
      for (const r of homebrewRuntimes()) add(r);
      for (const r of frameworkMacRuntimes()) add(r);
    }
  } catch {
    /* defensive — return whatever we gathered */
  }
  return out;
}

/** Find a python executable inside `binDir`, optionally a specific name first. */
function pythonExe(binDir: string, prefer?: string): string | null {
  for (const name of prefer ? [prefer, ...PY_EXES] : PY_EXES) {
    const full = join(binDir, name);
    if (isExecutable(full)) return full;
  }
  return null;
}

function pyAt(binDir: string, source: RuntimeSource, isManaged: boolean, knownVersion?: string, preferExe?: string): Runtime | null {
  const exe = pythonExe(binDir, preferExe);
  if (!exe) return null;
  const version = knownVersion || normalizeSemver(probe(exe, ['--version']));
  const id = source === 'system' ? 'system' : `${source}:${version || binDir}`;
  const label = version ? `Python ${version} (${source})` : `Python (${binDir})`;
  return { kind: 'python', id, label, version, binDir, source, isManaged };
}

function systemRuntime(): Runtime | null {
  for (const exe of PY_EXES) {
    const full = findOnPath(exe);
    if (full) return pyAt(dirOf(full), 'system', false);
  }
  return null;
}

/** `<managedDir>/python/<ver>/` — python.exe at root (Windows silent install). */
function managedRuntimes(managedDir: string): Runtime[] {
  const root = managedRuntimeRoot(managedDir, 'python');
  const out: Runtime[] = [];
  for (const name of listDirs(root)) {
    const verDir = join(root, name);
    const known = normalizeSemver(name) || undefined;
    // Windows: python.exe at root; unix: under bin/.
    const r = pyAt(verDir, 'managed', true, known) ?? pyAt(join(verDir, 'bin'), 'managed', true, known);
    if (r) out.push(r);
  }
  return out;
}

/** pyenv: `~/.pyenv/versions/<ver>/bin` (unix) and `~/.pyenv/pyenv-win/versions/<ver>` (win). */
function pyenvRuntimes(): Runtime[] {
  const base = join(homedir(), '.pyenv');
  const root = isWin ? join(base, 'pyenv-win', 'versions') : join(base, 'versions');
  const out: Runtime[] = [];
  for (const name of listDirs(root)) {
    const verDir = join(root, name);
    const known = normalizeSemver(name) || undefined;
    const r = pyAt(isWin ? verDir : join(verDir, 'bin'), 'pyenv', false, known);
    if (r) out.push(r);
  }
  return out;
}

/** Windows `py -0p` → one install per line: `-V:3.12 *  C:\...\python.exe`. */
function pyLauncherRuntimes(): Runtime[] {
  const listing = probe('py', ['-0p']);
  if (!listing) return [];
  const out: Runtime[] = [];
  for (const line of listing.split(/\r?\n/)) {
    // Drive-letter OR UNC path ending in python(w).exe.
    const path = /((?:[A-Za-z]:\\|\\\\)[^\r\n]*python(?:w)?\.exe)/i.exec(line)?.[1];
    if (!path) continue;
    // Probe the exe for the full version rather than trusting the `-V:` minor.
    const r = pyAt(dirOf(path), 'pylauncher', false);
    if (r) out.push(r);
  }
  return out;
}

/** python.org on Windows: %LocalAppData%/Programs/Python/PythonXY + %ProgramFiles%/PythonXY. */
function pythonOrgWinRuntimes(): Runtime[] {
  const roots = [
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python'),
    process.env.ProgramFiles ?? 'C:\\Program Files',
  ];
  const out: Runtime[] = [];
  for (const root of roots) {
    for (const name of listDirs(root, (n) => /^Python\d/i.test(n))) {
      const r = pyAt(join(root, name), 'pythonorg', false);
      if (r) out.push(r);
    }
  }
  return out;
}

/** Homebrew: `<prefix>/opt/python@3.12/bin` → prefer `python3.12`. */
function homebrewRuntimes(): Runtime[] {
  const prefixes = ['/opt/homebrew', '/usr/local', '/home/linuxbrew/.linuxbrew'];
  const out: Runtime[] = [];
  for (const prefix of prefixes) {
    const optDir = join(prefix, 'opt');
    for (const name of listDirs(optDir, (n) => n === 'python' || n.startsWith('python@'))) {
      const minor = name.split('@')[1];
      const r = pyAt(join(optDir, name, 'bin'), 'homebrew', false, undefined, minor ? `python${minor}` : undefined);
      if (r) out.push(r);
    }
  }
  return out;
}

/** macOS python.org framework: `/Library/Frameworks/Python.framework/Versions/<x.y>/bin` (all versions). */
function frameworkMacRuntimes(): Runtime[] {
  const versions = '/Library/Frameworks/Python.framework/Versions';
  const out: Runtime[] = [];
  for (const name of listDirs(versions, (n) => /^\d+\.\d+$/.test(n))) {
    const r = pyAt(join(versions, name, 'bin'), 'pythonorg', false, undefined, `python${name}`);
    if (r) out.push(r);
  }
  return out;
}
