/**
 * Java (JDK) runtime detection — enumerates JDK installs on the machine so
 * the project picker can offer a real choice. Best-effort, MUST NOT throw
 * (mirrors detect-php.ts).
 *
 * Sources: system PATH, our managed installs (dataDir/java/<ver>/), JAVA_HOME,
 * well-known JVM dirs (Eclipse Adoptium / Oracle / Microsoft on Windows,
 * /usr/lib/jvm, /Library/Java/JavaVirtualMachines) and SDKMAN candidates.
 *
 * GOTCHA: `java -version` prints to STDERR. Real homes use their `release`
 * metadata; coherent PATH shims fall back to a stderr-capturing probe.
 */

import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Runtime, RuntimeSource } from '@mcp/api-bus';
import { managedRuntimeRoot } from './runtime-shared.js';
import { dirOf, findOnPath, isWin, listDirs, normalizeSemver, probeOutput } from './detect-shared.js';

const JAVA_EXE = isWin ? 'java.exe' : 'java';

/**
 * Resolve the real JDK home inside an install dir: `bin/java` at the root,
 * the macOS `Contents/Home` layout, or a single nested folder (Temurin
 * archives extract as `<dir>/jdk-21.0.11+10/...`). Null when no JDK found.
 */
export function javaHomeOf(installDir: string, depth = 2): string | null {
  if (!installDir || !existsSync(installDir)) return null;
  if (existsSync(join(installDir, 'bin', JAVA_EXE))) return installDir;
  const mac = join(installDir, 'Contents', 'Home');
  if (existsSync(join(mac, 'bin', JAVA_EXE))) return mac;
  if (depth <= 0) return null;
  const children = listDirs(installDir);
  return children.length === 1 ? javaHomeOf(join(installDir, children[0]), depth - 1) : null;
}

/** `JAVA_VERSION="21.0.11"` from the JDK's `release` metadata file; '' if unknown. */
export function javaVersionOf(home: string): string {
  try {
    const text = readFileSync(join(home, 'release'), 'utf8');
    const m = /^JAVA_VERSION="([^"]+)"/m.exec(text);
    return m ? normalizeSemver(m[1]) : '';
  } catch {
    return '';
  }
}

export function detectJavaRuntimes(managedDir: string): Runtime[] {
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
    add(javaHomeRuntime());
    for (const r of jvmDirRuntimes()) add(r);
    for (const r of sdkmanRuntimes()) add(r);
  } catch {
    /* defensive — return whatever we gathered */
  }
  return out;
}

/** Build a Java Runtime from a JDK home (dir holding bin/java). */
function javaAt(home: string | null, source: RuntimeSource, isManaged: boolean, knownVersion?: string): Runtime | null {
  if (!home) return null;
  const binDir = join(home, 'bin');
  if (!existsSync(join(binDir, JAVA_EXE))) return null;
  if (!existsSync(join(binDir, isWin ? 'javac.exe' : 'javac'))) return null;
  const version = knownVersion || javaVersionOf(home);
  const id = source === 'system' ? 'system' : `${source}:${version || home}`;
  const label = version ? `JDK ${version} (${source})` : `JDK (${home})`;
  return { kind: 'java', id, label, version, binDir, source, isManaged };
}

function systemRuntime(): Runtime | null {
  const exe = findOnPath(JAVA_EXE);
  const javac = findOnPath(isWin ? 'javac.exe' : 'javac');
  // A PATH that only exposes `java` is a JRE. A PATH whose java/javac shims
  // point at different bins is ambiguous (and selecting "system" would not
  // inject a corrective PATH), so leave the coherent JDK roots to the normal
  // JAVA_HOME/well-known-directory detectors.
  if (!exe || !javac || dirOf(exe).toLowerCase() !== dirOf(javac).toLowerCase()) return null;
  const binDir = dirOf(exe);
  const home = javaHomeOf(dirname(binDir)) ?? dirname(binDir);
  const r = javaAt(home, 'system', false);
  if (r) return r;
  // PATH shim dirs (e.g. Oracle javapath) have no `release` file next to them:
  // `java -version` works on Java 8+ and writes its banner to stderr.
  const version = normalizeSemver(probeOutput(exe, ['-version']));
  return { kind: 'java', id: 'system', label: version ? `JDK ${version} (system)` : `JDK (${binDir})`, version, binDir, source: 'system', isManaged: false };
}

/** managedDir/java/<version>/… — version folder name is authoritative. */
function managedRuntimes(managedDir: string): Runtime[] {
  const root = managedRuntimeRoot(managedDir, 'java');
  return listDirs(root)
    .map((name) => javaAt(javaHomeOf(join(root, name)), 'managed', true, name))
    .filter((r): r is Runtime => r !== null);
}

function javaHomeRuntime(): Runtime | null {
  const env = process.env.JAVA_HOME;
  return env ? javaAt(javaHomeOf(env), 'javahome', false) : null;
}

/** Well-known JVM install roots per platform. */
function jvmDirRuntimes(): Runtime[] {
  const roots: string[] = [];
  if (isWin) {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
    roots.push(join(pf, 'Eclipse Adoptium'), join(pf, 'Java'), join(pf, 'Microsoft'));
  } else if (process.platform === 'darwin') {
    roots.push('/Library/Java/JavaVirtualMachines');
  } else {
    roots.push('/usr/lib/jvm');
  }
  const out: Runtime[] = [];
  for (const root of roots) {
    for (const name of listDirs(root, (n) => /jdk|java|temurin|zulu|corretto/i.test(n))) {
      const r = javaAt(javaHomeOf(join(root, name)), 'jvmdir', false);
      if (r) out.push(r);
    }
  }
  return out;
}

/** SDKMAN: ~/.sdkman/candidates/java/<version> (skip the `current` symlink). */
function sdkmanRuntimes(): Runtime[] {
  const root = join(homedir(), '.sdkman', 'candidates', 'java');
  const out: Runtime[] = [];
  for (const name of listDirs(root, (n) => n !== 'current')) {
    const r = javaAt(javaHomeOf(join(root, name)), 'sdkman', false);
    if (r) out.push(r);
  }
  return out;
}
