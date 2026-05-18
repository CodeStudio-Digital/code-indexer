#!/usr/bin/env tsx
/**
 * LOC cap enforcement — fails CI when a source file exceeds the soft
 * (≤300) or hard (≤500) limits documented in the cross-cutting
 * principles section of the company-mode plan.
 *
 * Scope:
 *   - `packages/{services,company,company-contracts,store,shared,indexer,code-agent,design-system}/src/**\/*.{ts,tsx}`
 *   - `apps/{http-api,dashboard,cli}/**\/*.{ts,tsx}`
 *   - Test files (`*.test.ts`, `__tests__/`) and seeds are excluded.
 *
 * Two levels:
 *   - HARD (>500 LOC) — fails the script with exit 1.
 *   - WARN (>300 LOC) — printed but exit 0.
 *
 * Allowlist `LOC_ALLOWLIST` carries the few files that legitimately
 * exceed the cap (state machines with unavoidable boilerplate, schema
 * snapshots, etc.). Adding to it should be a deliberate PR review item.
 *
 * Usage:
 *   npx tsx scripts/check-loc-cap.ts          # informational + exits 1 on hard violations
 *   npx tsx scripts/check-loc-cap.ts --strict # warns are also failures
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const REPO_ROOT = process.cwd();
const SOFT_CAP = 300;
const HARD_CAP = 500;

const ROOTS = [
  'packages/services/src',
  'packages/company/src',
  'packages/company-contracts/src',
  'packages/store/src',
  'packages/shared/src',
  'packages/indexer/src',
  'packages/code-agent/src',
  'packages/design-system/src',
  'apps/http-api',
  'apps/dashboard',
  'apps/cli',
];

const EXCLUDE_DIRS = new Set([
  'node_modules',
  'dist',
  '__tests__',
  'tests',
  '__snapshots__',
  '.next',
  'data',
]);

const EXCLUDE_FILE_PATTERNS: RegExp[] = [
  /\.test\.tsx?$/i,
  /\.spec\.tsx?$/i,
  /\.d\.ts$/,
  /\bseed[s]?\b.*\.ts$/i, // stack-seeds, fixture seeds
  /\bsnapshot.*\.ts$/i,
];

/**
 * Files we knowingly leave over the hard cap. Each entry needs a one-
 * line rationale so a future reviewer can decide whether it still
 * deserves the exception.
 */
const LOC_ALLOWLIST: Record<string, string> = {
  // Sandbox-manager coordinator after 19 sub-module extractions. The
  // boilerplate (constructor + driver getters/setters + deps bundlers)
  // is the irreducible coordinator shape.
  'packages/services/src/sandbox/sandbox-manager.ts':
    'Coordinator for 19 manager/ submodules; boilerplate + deps bundlers.',
  // Master state machine + bus-emit wrappers; further split would
  // scatter the state surface across multiple files for marginal gain.
  'packages/company/src/services/MasterLifecycle.ts':
    'State machine + bus-emit wrappers; further split scatters state.',
  // CompanyOrchestrator constructor wires every service slot — its
  // entire job is composition. Body decomposition would mostly move
  // wiring around without value.
  'packages/company/src/orchestrator.ts':
    'Composition root for company services; body is mostly slot wiring.',
};

function shouldSkipDir(name: string): boolean {
  return name.startsWith('.') || EXCLUDE_DIRS.has(name);
}

function shouldSkipFile(name: string): boolean {
  for (const re of EXCLUDE_FILE_PATTERNS) {
    if (re.test(name)) return true;
  }
  if (!/\.(ts|tsx)$/.test(name)) return true;
  return false;
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (shouldSkipDir(entry)) continue;
    const abs = join(dir, entry);
    let s;
    try { s = statSync(abs); } catch { continue; }
    if (s.isDirectory()) {
      walk(abs, out);
    } else if (s.isFile() && !shouldSkipFile(entry)) {
      out.push(abs);
    }
  }
}

interface Violation {
  path: string;
  loc: number;
  level: 'WARN' | 'HARD';
}

function main(): void {
  const strict = process.argv.includes('--strict');
  const files: string[] = [];
  for (const root of ROOTS) {
    walk(join(REPO_ROOT, root), files);
  }

  const violations: Violation[] = [];
  for (const file of files) {
    const rel = relative(REPO_ROOT, file).split(sep).join('/');
    const text = readFileSync(file, 'utf8');
    const loc = text.split(/\r?\n/).length;
    if (loc <= SOFT_CAP) continue;
    if (loc > HARD_CAP) {
      if (LOC_ALLOWLIST[rel]) continue;
      violations.push({ path: rel, loc, level: 'HARD' });
    } else {
      violations.push({ path: rel, loc, level: 'WARN' });
    }
  }

  violations.sort((a, b) => b.loc - a.loc);

  const hard = violations.filter((v) => v.level === 'HARD');
  const warn = violations.filter((v) => v.level === 'WARN');

  if (warn.length > 0) {
    console.log(`\n⚠️  ${warn.length} file(s) over soft cap (${SOFT_CAP} LOC):`);
    for (const v of warn) {
      console.log(`   ${v.loc.toString().padStart(4)}  ${v.path}`);
    }
  }

  if (hard.length > 0) {
    console.log(`\n❌ ${hard.length} file(s) over hard cap (${HARD_CAP} LOC):`);
    for (const v of hard) {
      console.log(`   ${v.loc.toString().padStart(4)}  ${v.path}`);
    }
    console.log(
      `\n  Hard cap is ${HARD_CAP} LOC for source files (tests excluded). Either split, ` +
      `or add an allowlist entry with rationale in scripts/check-loc-cap.ts:LOC_ALLOWLIST.`,
    );
    process.exit(1);
  }

  if (strict && warn.length > 0) {
    console.log(`\n--strict: warnings treated as failures.`);
    process.exit(1);
  }

  console.log(
    `\n✅ ${files.length} file(s) scanned. ${hard.length} hard violation(s), ${warn.length} soft warning(s).`,
  );
}

main();
