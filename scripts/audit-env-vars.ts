/**
 * audit-env-vars — discover every `process.env.*` knob read across the repo,
 * diff it against the app-settings catalog, infer a type, and classify it so
 * the Settings "Fase 1" backlog is data-driven instead of guesswork.
 *
 * Output:
 *   - console summary (coverage %, counts per prefix/tier)
 *   - scripts/.audit/env-vars.json  (full machine-readable report)
 *
 * Re-run any time; wire into CI as an anti-drift guard (fail if a NEW
 * user-facing-looking var lands without a catalog entry).
 *
 * Run: pnpm tsx scripts/audit-env-vars.ts
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_SETTINGS } from '../packages/store/src/app-settings-catalog.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const ROOTS = ['apps', 'packages', 'src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.vite', '.git', 'coverage', '__tests__']);

/** Owned elsewhere / not a CodeStudio knob — never a catalog candidate. */
const EXCLUDE_PREFIX = ['CLAUDE_CODE_', 'NODE_', 'npm_', 'VITE_', 'AWS_', 'GITHUB_ACTIONS'];
const EXCLUDE_EXACT = new Set([
  'NODE_ENV', 'CI', 'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'PWD', 'SHELL',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'BRAVE_API_KEY',
  'PORT', 'DEBUG', 'FORCE_COLOR', 'TERM', 'COLORTERM', 'APPDATA', 'LOCALAPPDATA',
]);

type TypeGuess = 'bool' | 'int' | 'float' | 'enum' | 'string';
interface Hit {
  count: number;
  files: Set<string>;
  votes: Record<TypeGuess, number>;
  enums: Set<string>;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.[cm]?tsx?$/.test(p) && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const ENV_RE = /process\.env\.([A-Z][A-Z0-9_]+)|process\.env\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g;

function inferType(ctx: string, name: string): { type: TypeGuess; enumLit?: string } {
  // bool: compared against 0/1/true/false
  if (new RegExp(`${name}\\s*(===|!==|==|!=)\\s*['"](0|1|true|false)['"]`).test(ctx)) return { type: 'bool' };
  if (new RegExp(`${name}\\s*===\\s*['"]1['"]`).test(ctx)) return { type: 'bool' };
  // numeric coercion
  if (new RegExp(`parseFloat\\(\\s*process\\.env\\.${name}`).test(ctx)) return { type: 'float' };
  if (new RegExp(`(Number|parseInt)\\(\\s*process\\.env\\.${name}`).test(ctx)) return { type: 'int' };
  // enum: compared against a non-numeric word literal
  const em = new RegExp(`${name}\\s*===\\s*['"]([a-z][a-z0-9_-]{1,})['"]`, 'i').exec(ctx);
  if (em && !/^(0|1|true|false)$/i.test(em[1])) return { type: 'enum', enumLit: em[1].toLowerCase() };
  return { type: 'string' };
}

function excluded(name: string): boolean {
  if (EXCLUDE_EXACT.has(name)) return true;
  return EXCLUDE_PREFIX.some((p) => name.startsWith(p));
}

const hits = new Map<string, Hit>();
let scanned = 0;
for (const root of ROOTS) {
  let files: string[];
  try {
    files = walk(join(repoRoot, root));
  } catch {
    continue;
  }
  for (const file of files) {
    scanned++;
    const src = readFileSync(file, 'utf8');
    const rel = relative(repoRoot, file).replace(/\\/g, '/');
    ENV_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ENV_RE.exec(src))) {
      const name = m[1] ?? m[2];
      if (!name) continue;
      const ctx = src.slice(Math.max(0, m.index - 8), m.index + name.length + 60);
      const { type, enumLit } = inferType(ctx, name);
      let h = hits.get(name);
      if (!h) {
        h = { count: 0, files: new Set(), votes: { bool: 0, int: 0, float: 0, enum: 0, string: 0 }, enums: new Set() };
        hits.set(name, h);
      }
      h.count++;
      h.files.add(rel);
      h.votes[type]++;
      if (enumLit) h.enums.add(enumLit);
    }
  }
}

const catalogKeys = new Set(APP_SETTINGS.map((d) => d.key));
const prefixOf = (n: string): string => n.split('_')[0];

const report = [...hits.entries()]
  .map(([key, h]) => {
    const inferred = (Object.entries(h.votes) as [TypeGuess, number][])
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'string';
    const isExcluded = excluded(key);
    const inCatalog = catalogKeys.has(key);
    const looksDebug = /_(DEBUG|VERBOSE|TRACE)$|_LOG/.test(key);
    const tier = inCatalog ? 'cataloged' : isExcluded ? 'excluded' : looksDebug ? 'tier3-debug' : 'review';
    return {
      key,
      prefix: prefixOf(key),
      inferred_type: inferred,
      enums: [...h.enums].sort(),
      usage_count: h.count,
      files: [...h.files].slice(0, 6),
      in_catalog: inCatalog,
      tier,
    };
  })
  .sort((a, b) => a.key.localeCompare(b.key));

const distinct = report.length;
const cataloged = report.filter((r) => r.in_catalog).length;
const excludedN = report.filter((r) => r.tier === 'excluded').length;
const debugN = report.filter((r) => r.tier === 'tier3-debug').length;
const review = report.filter((r) => r.tier === 'review').length;
const eligible = distinct - excludedN; // catalog-eligible universe
const coverage = eligible ? ((cataloged / eligible) * 100).toFixed(1) : '0';

const byPrefix = new Map<string, number>();
for (const r of report) if (r.tier === 'review') byPrefix.set(r.prefix, (byPrefix.get(r.prefix) ?? 0) + 1);

const outDir = join(repoRoot, 'scripts', '.audit');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'env-vars.json'), JSON.stringify({ generatedFrom: scanned, report }, null, 2) + '\n');

console.log(`[audit-env-vars] scanned ${scanned} files, ${distinct} distinct env vars`);
console.log(`  cataloged:    ${cataloged}`);
console.log(`  excluded:     ${excludedN} (SDK/OS/provider keys)`);
console.log(`  tier3-debug:  ${debugN} (debug/verbose/log — hide by default)`);
console.log(`  review:       ${review} (candidate user-facing → classify)`);
console.log(`  coverage:     ${coverage}% of ${eligible} catalog-eligible vars`);
console.log('  review candidates by prefix:');
for (const [p, n] of [...byPrefix.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${p.padEnd(10)} ${n}`);
console.log(`  full report → scripts/.audit/env-vars.json`);
