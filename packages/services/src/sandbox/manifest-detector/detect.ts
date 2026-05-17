/**
 * Manifest detector — probes a directory for a supported project manifest
 * (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`)
 * and returns a typed `ManifestInfo`. Returns `null` when nothing matches.
 *
 * Probing order: node → python → go → rust → ruby. The first match wins;
 * projects that carry both a package.json and a Gemfile are treated as
 * node (this matches user intent ~always — think Rails + assets).
 *
 * Parsing strategy:
 *   - JSON for package.json (real parser).
 *   - Everything else via small regex scans. A full TOML parser isn't a
 *     project dependency and we don't need one: the synthesizer only
 *     asks for a few facts (package name, framework hint, module name).
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import type {
  ManifestInfo,
  NodeManifest,
  NodePackageManager,
  PythonFramework,
  PythonManifest,
  GoManifest,
  RustManifest,
  RubyFramework,
  RubyManifest,
} from './types.js';

const DEV_SCRIPT_PREFERENCE = ['dev', 'start', 'serve'] as const;

export function detectManifest(absPath: string): ManifestInfo | null {
  if (!isAbsolute(absPath)) return null;
  if (!dirExists(absPath)) return null;

  const node = detectNode(absPath);
  if (node) return node;

  const python = detectPython(absPath);
  if (python) return python;

  const go = detectGo(absPath);
  if (go) return go;

  const rust = detectRust(absPath);
  if (rust) return rust;

  const ruby = detectRuby(absPath);
  if (ruby) return ruby;

  return null;
}

function detectNode(root: string): NodeManifest | null {
  const manifestPath = join(root, 'package.json');
  if (!fileExists(manifestPath)) return null;

  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf-8');
  } catch {
    return null;
  }

  let parsed: { name?: unknown; scripts?: unknown } = {};
  try {
    parsed = JSON.parse(raw) as { name?: unknown; scripts?: unknown };
  } catch {
    return null;
  }

  const scripts =
    parsed.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)
      ? Object.fromEntries(
          Object.entries(parsed.scripts as Record<string, unknown>).filter(
            ([, v]) => typeof v === 'string',
          ) as Array<[string, string]>,
        )
      : {};

  const devScriptName = pickDevScript(scripts);
  const packageManager = detectNodePackageManager(root);
  const hasNodeModules = dirExists(join(root, 'node_modules'));
  const packageName = typeof parsed.name === 'string' ? parsed.name : null;

  return {
    kind: 'node',
    rootPath: root,
    manifestPath,
    packageManager,
    scripts,
    devScriptName,
    packageName,
    hasNodeModules,
  };
}

function pickDevScript(scripts: Record<string, string>): string | null {
  for (const name of DEV_SCRIPT_PREFERENCE) {
    if (scripts[name]) return name;
  }
  return null;
}

function detectNodePackageManager(root: string): NodePackageManager {
  if (fileExists(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fileExists(join(root, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function detectPython(root: string): PythonManifest | null {
  const manifestPath = join(root, 'pyproject.toml');
  if (!fileExists(manifestPath)) return null;

  let raw = '';
  try {
    raw = readFileSync(manifestPath, 'utf-8');
  } catch {
    return null;
  }

  const framework = detectPythonFramework(raw, root);
  const entry = detectPythonEntry(root);

  return {
    kind: 'python',
    rootPath: root,
    manifestPath,
    framework,
    entry,
  };
}

function detectPythonFramework(manifest: string, root: string): PythonFramework {
  const haystack = manifest.toLowerCase();
  if (haystack.includes('fastapi')) return 'fastapi';
  if (haystack.includes('django')) return 'django';
  if (haystack.includes('flask')) return 'flask';
  // Requirements.txt fallback for legacy projects that pin deps outside pyproject.
  const reqPath = join(root, 'requirements.txt');
  if (fileExists(reqPath)) {
    let req = '';
    try {
      req = readFileSync(reqPath, 'utf-8').toLowerCase();
    } catch {
      return 'unknown';
    }
    if (req.includes('fastapi')) return 'fastapi';
    if (req.includes('django')) return 'django';
    if (req.includes('flask')) return 'flask';
  }
  return 'unknown';
}

/**
 * Guess the ASGI/WSGI entry point. Prefers `main.py` → `app.py` →
 * `wsgi.py` → `asgi.py`. The module target is the filename without
 * extension; the attribute is `app` by convention (FastAPI/Flask default).
 * Returns `null` when none of these exist.
 */
function detectPythonEntry(root: string): string | null {
  const candidates = [
    { file: 'main.py', attr: 'app' },
    { file: 'app.py', attr: 'app' },
    { file: 'asgi.py', attr: 'application' },
    { file: 'wsgi.py', attr: 'application' },
  ];
  for (const { file, attr } of candidates) {
    if (fileExists(join(root, file))) {
      return `${file.replace(/\.py$/, '')}:${attr}`;
    }
  }
  return null;
}

function detectGo(root: string): GoManifest | null {
  const manifestPath = join(root, 'go.mod');
  if (!fileExists(manifestPath)) return null;

  let raw = '';
  try {
    raw = readFileSync(manifestPath, 'utf-8');
  } catch {
    return null;
  }
  const match = raw.match(/^module\s+(\S+)/m);
  const moduleName = match ? match[1] : '';
  const hasMainGo = fileExists(join(root, 'main.go'));
  return {
    kind: 'go',
    rootPath: root,
    manifestPath,
    moduleName,
    hasMainGo,
  };
}

function detectRust(root: string): RustManifest | null {
  const manifestPath = join(root, 'Cargo.toml');
  if (!fileExists(manifestPath)) return null;

  let raw = '';
  try {
    raw = readFileSync(manifestPath, 'utf-8');
  } catch {
    return null;
  }

  const nameMatch = raw.match(/\[package\][\s\S]*?\bname\s*=\s*"([^"]+)"/);
  const packageName = nameMatch ? nameMatch[1] : '';
  // Collect all [[bin]] blocks' `name = "..."` entries.
  const binaries: string[] = [];
  const binRegex = /\[\[bin\]\][\s\S]*?\bname\s*=\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = binRegex.exec(raw)) !== null) {
    binaries.push(m[1]);
  }
  return {
    kind: 'rust',
    rootPath: root,
    manifestPath,
    packageName,
    binaries,
  };
}

function detectRuby(root: string): RubyManifest | null {
  const manifestPath = join(root, 'Gemfile');
  if (!fileExists(manifestPath)) return null;

  let raw = '';
  try {
    raw = readFileSync(manifestPath, 'utf-8');
  } catch {
    return null;
  }
  const framework = detectRubyFramework(raw);
  return {
    kind: 'ruby',
    rootPath: root,
    manifestPath,
    framework,
  };
}

function detectRubyFramework(gemfile: string): RubyFramework {
  const haystack = gemfile.toLowerCase();
  // Match both single and double-quoted: gem 'rails', gem "rails".
  if (/gem\s+['"]rails['"]/.test(haystack)) return 'rails';
  if (/gem\s+['"]sinatra['"]/.test(haystack)) return 'sinatra';
  return 'unknown';
}

function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return existsSync(p);
  }
}
