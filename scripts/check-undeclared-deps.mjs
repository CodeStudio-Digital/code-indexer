/**
 * Scan all imports/requires across apps/ + packages/ and print module
 * specifiers that aren't declared in package.json (or known workspace
 * packages / node builtins). Helps catch "works in tsc, fails in runtime"
 * gaps when developing locally with pnpm's strict module resolution.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const declared = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
]);

const workspacePrefixes = [
  '@mcp/', '@apps/',
];

const builtins = new Set([
  'fs', 'fs/promises', 'path', 'crypto', 'child_process', 'os', 'http',
  'https', 'stream', 'url', 'util', 'events', 'buffer', 'worker_threads',
  'module', 'tls', 'net', 'querystring', 'zlib', 'assert', 'perf_hooks',
  'readline', 'process', 'diagnostics_channel', 'string_decoder', 'timers',
]);

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'build']);

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry)) out.push(full);
  }
}

const files = [];
walk(join(root, 'apps'), files);
walk(join(root, 'packages'), files);

const importRe = /(?:from\s+|require\(\s*)['"]([^'"]+)['"]/g;
const undeclared = new Map(); // spec → list of files

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(importRe)) {
    const spec = m[1];
    if (spec.startsWith('.') || spec.startsWith('/')) continue; // relative
    if (spec.startsWith('node:')) continue; // explicit builtin
    const root = spec.startsWith('@')
      ? spec.split('/').slice(0, 2).join('/')
      : spec.split('/')[0];
    if (builtins.has(root)) continue;
    if (declared.has(root)) continue;
    if (workspacePrefixes.some((p) => root.startsWith(p))) continue;
    const list = undeclared.get(root) ?? [];
    list.push(file);
    undeclared.set(root, list);
  }
}

const sorted = [...undeclared.entries()].sort(([a], [b]) => a.localeCompare(b));
if (sorted.length === 0) {
  console.log('No undeclared dependencies found.');
  process.exit(0);
}
for (const [spec, locs] of sorted) {
  console.log(`${spec}  (${locs.length} usage${locs.length === 1 ? '' : 's'})`);
  for (const f of locs.slice(0, 3)) console.log(`  - ${f.replace(root + '\\', '').replace(root + '/', '')}`);
  if (locs.length > 3) console.log(`  ... +${locs.length - 3} more`);
}
