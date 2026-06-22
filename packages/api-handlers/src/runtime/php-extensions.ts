/**
 * PHP extension management for a MANAGED install — we own its php.ini, so we
 * can safely toggle the `extension=` lines and seed a sane default ini after
 * extracting the Windows build. System/Homebrew PHP is intentionally NOT
 * touched here (shared config; the UI shows it read-only).
 *
 * Naming: the bundled DLL `ext/php_curl.dll` is enabled by the ini directive
 * `extension=curl`. On unix the file is `curl.so`. We display the bare name.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PhpExtension } from '@mcp/api-bus';
import { isWin, listDirs, probe } from './detect-shared.js';

const PHP_EXE = isWin ? 'php.exe' : 'php';

export function phpIniPath(installDir: string): string {
  return join(installDir, 'php.ini');
}
export function phpExtDir(installDir: string): string {
  return join(installDir, 'ext');
}

/**
 * Zend extensions MUST be loaded via `zend_extension=` — `extension=opcache`
 * makes PHP print "Failed loading ... not a valid Zend extension" and the
 * extension never loads. opcache ships in every Windows build; xdebug is the
 * most common PECL install.
 */
const ZEND_EXTENSIONS = new Set(['opcache', 'xdebug']);
function directiveFor(name: string): string {
  return ZEND_EXTENSIONS.has(name.toLowerCase()) ? 'zend_extension' : 'extension';
}

/** Extension display name from a build's ext file (`php_curl.dll` → `curl`, `curl.so` → `curl`). */
function nameFromFile(file: string): string | null {
  const m = /^(?:php_)?([\w]+)\.(?:dll|so)$/i.exec(file);
  return m ? m[1].toLowerCase() : null;
}

/** Bundled extensions present in the build's ext/ dir. */
function bundledExtensions(installDir: string): string[] {
  const dir = phpExtDir(installDir);
  if (!existsSync(dir)) return [];
  try {
    return [...new Set(readdirSync(dir).map(nameFromFile).filter((n): n is string => !!n))].sort();
  } catch {
    return [];
  }
}

/** Active (uncommented) `extension=` / `zend_extension=` directives in php.ini. */
function enabledInIni(installDir: string): Set<string> {
  const ini = phpIniPath(installDir);
  const out = new Set<string>();
  if (!existsSync(ini)) return out;
  for (const line of readFileSync(ini, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:zend_)?extension\s*=\s*(?:php_)?([\w]+)(?:\.dll|\.so)?\s*$/i.exec(line);
    if (m && !/^\s*;/.test(line)) out.add(m[1].toLowerCase());
  }
  return out;
}

/** Modules `php -c <ini> -m` reports as loaded (best-effort confirmation). */
function loadedModules(installDir: string): Set<string> {
  const out = new Set<string>();
  const raw = probe(join(installDir, PHP_EXE), ['-c', phpIniPath(installDir), '-m']);
  if (!raw) return out;
  for (const line of raw.split(/\r?\n/)) {
    const name = line.trim().toLowerCase();
    if (!name || name.startsWith('[')) continue;
    out.add(name);
    // `php -m` lists opcache under the Zend section as "Zend OPcache".
    if (name.includes('opcache')) out.add('opcache');
  }
  return out;
}

/** List a managed PHP's extensions: bundled + any extra enabled, with state. */
export function listExtensions(installDir: string): PhpExtension[] {
  const bundled = new Set(bundledExtensions(installDir));
  const enabled = enabledInIni(installDir);
  const loaded = loadedModules(installDir);
  const names = [...new Set([...bundled, ...enabled])].sort();
  return names.map((name) => ({
    name,
    enabled: enabled.has(name),
    builtin: bundled.has(name),
    loaded: loaded.has(name),
  }));
}

/**
 * Enable/disable an extension by rewriting its `extension=` line in php.ini.
 * Enable: uncomment an existing line, else append one. Disable: comment any
 * active line. Idempotent; only touches the matching directive.
 */
export function setExtension(installDir: string, name: string, enabled: boolean): void {
  const ini = phpIniPath(installDir);
  if (!existsSync(ini)) throw new Error(`php.ini not found at ${ini}`);
  const lc = name.toLowerCase();
  const dir = directiveFor(lc); // 'extension' or 'zend_extension'
  const isLine = (line: string): boolean =>
    new RegExp(`^\\s*;?\\s*(?:zend_)?extension\\s*=\\s*(?:php_)?${lc}(?:\\.dll|\\.so)?\\s*$`, 'i').test(line);

  const lines = readFileSync(ini, 'utf8').split(/\r?\n/);
  let touched = false;
  const next = lines.map((line) => {
    if (!isLine(line)) return line;
    touched = true;
    return enabled ? `${dir}=${lc}` : `;${dir}=${lc}`;
  });
  if (enabled && !touched) next.push(`${dir}=${lc}`);
  writeFileSync(ini, next.join('\n'), 'utf8');
}

/**
 * After extracting a Windows build, seed php.ini from php.ini-development:
 * point extension_dir at the absolute ext/ folder and enable a small set of
 * extensions that make composer + everyday CLI work out of the box.
 */
export function seedManagedIni(installDir: string, defaults: string[]): void {
  const ini = phpIniPath(installDir);
  if (!existsSync(ini)) {
    const dev = join(installDir, 'php.ini-development');
    const prod = join(installDir, 'php.ini-production');
    const src = existsSync(dev) ? dev : existsSync(prod) ? prod : null;
    writeFileSync(ini, src ? readFileSync(src, 'utf8') : '', 'utf8');
  }
  // extension_dir → absolute ext/ (replace any commented/active directive).
  const abs = phpExtDir(installDir).replace(/\\/g, '\\\\');
  const lines = readFileSync(ini, 'utf8').split(/\r?\n/);
  let setDir = false;
  const next = lines.map((line) => {
    if (/^\s*;?\s*extension_dir\s*=/.test(line)) {
      setDir = true;
      return `extension_dir = "${abs}"`;
    }
    return line;
  });
  if (!setDir) next.unshift(`extension_dir = "${abs}"`);
  writeFileSync(ini, next.join('\n'), 'utf8');
  // Only enable defaults whose DLL actually ships in this build — enabling a
  // missing one (e.g. `zip` is absent from some Windows builds) just spams a
  // "Unable to load dynamic library" warning on every php invocation.
  const present = new Set(bundledExtensions(installDir));
  for (const ext of defaults) {
    if (present.has(ext)) setExtension(installDir, ext, true);
  }
}

/** Available managed install dirs (version folders) under the managed php root. */
export function managedPhpDirs(phpRoot: string): string[] {
  return listDirs(phpRoot);
}
