#!/usr/bin/env tsx
/**
 * Circular-import detector — fails CI when a package's TypeScript
 * sources contain an import cycle. No dependency on `madge`: walks the
 * TS source graph directly and runs Tarjan SCC + a one-shot DFS for
 * cycle reporting.
 *
 * Resolution scope:
 *   - Same package's `src/` files (relative imports).
 *   - Cross-package `@mcp/*` aliases mapped to `packages/<name>/src/...`.
 *   - `@apps/*` aliases mapped to `apps/...`.
 *
 * Out of scope:
 *   - `node_modules` (3rd-party deps).
 *   - Type-only imports — these don't create runtime cycles, but they
 *     can still confuse `tsc` so we include them in the graph.
 *
 * Usage:
 *   npx tsx scripts/check-circular-imports.ts
 *
 * Exit 0 when no cycles. Exit 1 + print all cycles when any found.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath, sep } from 'node:path';

const REPO_ROOT = process.cwd();

const ROOTS = [
  'packages/services/src',
  'packages/provider-sdk/src',
  'packages/provider-engine/src',
  'packages/company/src',
  'packages/company-contracts/src',
  'packages/store/src',
  'packages/shared/src',
  'packages/indexer/src',
  'packages/code-agent/src',
  'packages/design-system/src',
  'apps/http-api',
  'apps/dashboard',
];

const ALIAS_MAP: Array<{ prefix: string; replacement: string }> = [
  { prefix: '@mcp/services/', replacement: 'packages/services/src/' },
  { prefix: '@mcp/services', replacement: 'packages/services/src/index.ts' },
  { prefix: '@mcp/provider-sdk/', replacement: 'packages/provider-sdk/src/' },
  { prefix: '@mcp/provider-sdk', replacement: 'packages/provider-sdk/src/index.ts' },
  { prefix: '@mcp/provider-engine/', replacement: 'packages/provider-engine/src/' },
  { prefix: '@mcp/provider-engine', replacement: 'packages/provider-engine/src/index.ts' },
  { prefix: '@mcp/company-contracts/', replacement: 'packages/company-contracts/src/' },
  { prefix: '@mcp/company-contracts', replacement: 'packages/company-contracts/src/index.ts' },
  { prefix: '@mcp/company/', replacement: 'packages/company/src/' },
  { prefix: '@mcp/company', replacement: 'packages/company/src/index.ts' },
  { prefix: '@mcp/store/', replacement: 'packages/store/src/' },
  { prefix: '@mcp/store', replacement: 'packages/store/src/index.ts' },
  { prefix: '@mcp/shared/', replacement: 'packages/shared/src/' },
  { prefix: '@mcp/shared', replacement: 'packages/shared/src/index.ts' },
  { prefix: '@mcp/indexer/', replacement: 'packages/indexer/src/' },
  { prefix: '@mcp/indexer', replacement: 'packages/indexer/src/index.ts' },
  { prefix: '@mcp/code-agent/', replacement: 'packages/code-agent/src/' },
  { prefix: '@mcp/code-agent', replacement: 'packages/code-agent/src/index.ts' },
  { prefix: '@mcp/design-system/', replacement: 'packages/design-system/src/' },
  { prefix: '@mcp/design-system', replacement: 'packages/design-system/src/index.ts' },
  { prefix: '@apps/', replacement: 'apps/' },
];

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist') continue;
    const abs = join(dir, entry);
    let s;
    try { s = statSync(abs); } catch { continue; }
    if (s.isDirectory()) walk(abs, out);
    else if (s.isFile() && /\.(ts|tsx)$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(abs);
  }
}

const IMPORT_RE = /(?:^|;|\n)\s*(?:import|export)\b[\s\S]*?(?:from\s+|^\s*)['"]([^'"]+)['"]/g;

function extractImports(source: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(source)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function resolveAlias(spec: string): string | null {
  for (const { prefix, replacement } of ALIAS_MAP) {
    if (spec === prefix.replace(/\/$/, '') && replacement.endsWith('.ts')) {
      return join(REPO_ROOT, replacement);
    }
    if (spec.startsWith(prefix)) {
      return join(REPO_ROOT, replacement + spec.slice(prefix.length));
    }
  }
  return null;
}

function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  return resolvePath(dirname(fromFile), spec);
}

function tryExtensions(base: string): string | null {
  // Spec ends with `.js`/`.tsx`/`.ts` in some forms; strip then try.
  let candidate = base.replace(/\.js$/, '');
  for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
    try {
      const abs = candidate + ext;
      const s = statSync(abs);
      if (s.isFile()) return abs;
    } catch { /* keep trying */ }
  }
  // Direct hit (already has extension).
  try {
    const s = statSync(base);
    if (s.isFile()) return base;
  } catch { /* nope */ }
  return null;
}

function resolveImport(fromFile: string, spec: string): string | null {
  if (spec.startsWith('node:') || spec.startsWith('@types/')) return null;
  let base = resolveRelative(fromFile, spec) ?? resolveAlias(spec);
  if (!base) return null;
  return tryExtensions(base);
}

interface Graph {
  /** node → outgoing edges */
  edges: Map<string, Set<string>>;
}

function buildGraph(files: string[]): Graph {
  const edges = new Map<string, Set<string>>();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const imports = extractImports(text);
    const out = new Set<string>();
    for (const spec of imports) {
      const target = resolveImport(file, spec);
      if (target && target !== file) out.add(target);
    }
    edges.set(file, out);
  }
  return { edges };
}

/**
 * Tarjan-style strongly-connected-components. We don't print SCCs with
 * size 1 unless they self-loop (rare). Returns SCCs of size ≥ 2.
 */
function findCycles(graph: Graph): string[][] {
  const indexes = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let index = 0;
  const sccs: string[][] = [];

  function strongConnect(v: string): void {
    indexes.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    const out = graph.edges.get(v) ?? new Set();
    for (const w of out) {
      if (!indexes.has(w)) {
        strongConnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indexes.get(w)!));
      }
    }
    if (lowlinks.get(v) === indexes.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) sccs.push(scc);
      else if (graph.edges.get(v)?.has(v)) sccs.push(scc);
    }
  }

  for (const v of graph.edges.keys()) {
    if (!indexes.has(v)) strongConnect(v);
  }
  return sccs;
}

function main(): void {
  const files: string[] = [];
  for (const root of ROOTS) walk(join(REPO_ROOT, root), files);

  const graph = buildGraph(files);
  const cycles = findCycles(graph);

  if (cycles.length === 0) {
    console.log(`✅ ${files.length} TypeScript file(s) scanned. No circular imports detected.`);
    return;
  }

  console.log(`❌ ${cycles.length} circular import cluster(s) detected:`);
  for (let i = 0; i < cycles.length; i++) {
    console.log(`\n  Cycle ${i + 1} (${cycles[i].length} files):`);
    for (const f of cycles[i]) {
      const rel = relative(REPO_ROOT, f).split(sep).join('/');
      console.log(`    ${rel}`);
    }
  }
  process.exit(1);
}

main();
