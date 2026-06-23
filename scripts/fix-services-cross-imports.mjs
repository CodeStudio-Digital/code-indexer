#!/usr/bin/env node
/**
 * One-off fix for Phase 3: rewrite relative imports inside
 * packages/services/src/ that point to siblings still living
 * under src/core/ (coder, search, indexer, design-system, apps).
 *
 * Strategy: re-anchor each relative import as if the file were
 * still at its OLD location (src/core/<subdir>/...), resolve it
 * there, and if the resolved path lives under a known sibling
 * subtree, rewrite to the package alias.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const subtreeAliases = [
  // path-prefix : alias-prefix
  ['src/core/coder/', '@mcp/code-agent/'],
  ['src/core/indexer/', '@mcp/indexer/indexer/'],
  ['src/core/search/', '@mcp/indexer/search/'],
  ['src/core/workers/', '@mcp/indexer/workers/'],
  ['src/core/bootstrap/', '@mcp/indexer/bootstrap/'],
  ['src/core/design-system/', '@mcp/design-system/'],
];

const files = await glob('packages/services/src/**/*.{ts,tsx}', { cwd: ROOT });
const RE = /(from\s+|import\s*\(\s*|export\s+\*\s+from\s+|export\s+\{[^}]*\}\s+from\s+)(['"])([^'"]+)\2/g;

let totalReplaced = 0;
let filesChanged = 0;

for (const file of files) {
  const absFile = resolve(ROOT, file);
  const original = readFileSync(absFile, 'utf8');
  let count = 0;

  // Reconstruct the file's ORIGINAL location (before Phase 3 git mv).
  // packages/services/src/<subdir>/... → src/core/<subdir>/...
  const fileRel = file.replace(/\\/g, '/');
  const m = /^packages\/services\/src\/(.+)$/.exec(fileRel);
  if (!m) continue;
  const oldFile = `src/core/${m[1]}`;
  const oldDir = dirname(oldFile);

  const updated = original.replace(RE, (match, prefix, quote, importPath) => {
    if (!importPath.startsWith('.')) return match;

    // Resolve as if the file were still at oldFile location.
    const resolvedOld = resolve(ROOT, oldDir, importPath).replace(/\\/g, '/');
    const relFromRoot = relative(ROOT, resolvedOld).replace(/\\/g, '/');

    for (const [prefixPath, aliasPrefix] of subtreeAliases) {
      if (relFromRoot.startsWith(prefixPath)) {
        const rest = relFromRoot.slice(prefixPath.length);
        // rest still ends in .js (the import); keep as-is
        count++;
        return `${prefix}${quote}${aliasPrefix}${rest}${quote}`;
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
