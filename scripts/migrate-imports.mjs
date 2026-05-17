#!/usr/bin/env node
/**
 * Rewrite import paths for a batch of moved files.
 *
 * Usage:
 *   node scripts/migrate-imports.mjs <moves.json>
 *
 * moves.json shape: { "src/old/path.ts": "@mcp/new/path.js", ... }
 *
 * For each .ts/.tsx file under src/, packages/, apps/, scans `from '…'`
 * (and dynamic import / export-from) clauses, resolves the relative path
 * against the file's own dir, and rewrites the literal when the resolved
 * absolute path matches a key in the map.
 *
 * Keys in moves.json must be project-relative paths to the file's ORIGINAL
 * location (the location it had BEFORE being moved). Values are the new
 * import specifier (e.g. "@mcp/shared/types.js").
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const movesPath = process.argv[2];
if (!movesPath) {
  console.error('Usage: node scripts/migrate-imports.mjs <moves.json>');
  process.exit(1);
}

const moves = JSON.parse(readFileSync(resolve(ROOT, movesPath), 'utf8'));

// Expand prefix mappings (entries ending with '/') by walking the target
// directory and producing one entry per file. Keys ending with '/' indicate
// a directory rename: every file under the NEW location keeps its relative
// path, and the OLD location is reconstructed for the lookup.
const expanded = {};
for (const [oldKey, newValue] of Object.entries(moves)) {
  if (!oldKey.endsWith('/')) {
    expanded[oldKey.replace(/\\/g, '/')] = newValue;
    continue;
  }
  // newValue must start with "@mcp/<pkg>/[<subpath>/]". Files may already
  // be at packages/<pkg>/src/<subpath>/ (moved this phase) OR still at the
  // old key location (when we're rewriting imports BEFORE the move).
  const m = /^@mcp\/([^/]+)\/(.*)$/.exec(newValue);
  if (!m) throw new Error(`prefix value must look like '@mcp/<pkg>/[<subpath>/]': ${newValue}`);
  const [, pkgDir, subPath] = m;
  const targetDir = `packages/${pkgDir}/src/${subPath}`;
  let files = await glob(`${targetDir}**/*.{ts,tsx}`, { cwd: ROOT });
  let baseDir = targetDir;
  if (files.length === 0) {
    files = await glob(`${oldKey}**/*.{ts,tsx}`, { cwd: ROOT });
    baseDir = oldKey;
  }
  for (const file of files) {
    const normalized = file.replace(/\\/g, '/');
    const rel = normalized.replace(baseDir, '');
    const oldPath = oldKey + rel;
    const newImport = newValue + rel.replace(/\.tsx?$/, '.js');
    expanded[oldPath] = newImport;
  }
}
const movedKeys = new Set(Object.keys(expanded));
const movesMap = expanded;

const files = await glob(['src/**/*.{ts,tsx}', 'packages/**/src/**/*.{ts,tsx}', 'apps/**/*.{ts,tsx}'], {
  cwd: ROOT,
  ignore: ['**/node_modules/**', '**/dist/**'],
});

// Captures any string literal that follows a clause known to consume a
// module specifier: ESM imports/exports, dynamic `import(…)`, and
// vitest's `vi.mock`/`vi.doMock`/`vi.importActual<T>` (which are runtime
// module references that must be rewritten the same as imports).
const RE = /((?:from\s+)|(?:import\s*\(\s*)|(?:export\s+\*\s+from\s+)|(?:export\s+\{[^}]*\}\s+from\s+)|(?:vi\.(?:mock|doMock|importActual)(?:<[^>]+>)?\s*\(\s*))(['"])([^'"]+)\2/g;

let totalReplaced = 0;
let filesChanged = 0;

for (const file of files) {
  const absFile = resolve(ROOT, file);
  const original = readFileSync(absFile, 'utf8');
  let count = 0;

  const updated = original.replace(RE, (match, prefix, quote, importPath) => {
    if (!importPath.startsWith('.')) return match;

    const resolved = resolve(dirname(absFile), importPath);
    const candidates = [
      resolved.replace(/\.js$/, '.ts'),
      resolved.replace(/\.js$/, '.tsx'),
      resolved + '.ts',
      resolved + '.tsx',
      resolved,
    ];

    for (const candidate of candidates) {
      const rel = relative(ROOT, candidate).replace(/\\/g, '/');
      if (movedKeys.has(rel)) {
        count++;
        return `${prefix}${quote}${movesMap[rel]}${quote}`;
      }
    }

    return match;
  });

  if (count > 0) {
    writeFileSync(absFile, updated);
    console.log(`  ${file}: ${count}`);
    totalReplaced += count;
    filesChanged++;
  }
}

console.log(`\n${filesChanged} files changed, ${totalReplaced} imports rewritten.`);
