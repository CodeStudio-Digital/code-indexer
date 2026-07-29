#!/usr/bin/env tsx
/**
 * Strict LOC budget for the new Rust agent boundary.
 *
 * Production modules over 250 LOC fail. Generated bindings and tests are
 * excluded because their shape is governed by generators/fixtures instead of
 * module design.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

const REPO_ROOT = process.cwd();
const LOC_CAP = 250;
const ROOTS = [
  'native/agent-runtime/crates',
  'packages/agent-runtime-contracts/src',
  'packages/agent-runtime-host/src',
];
const SOURCE_EXTENSIONS = new Set(['.rs', '.ts', '.tsx']);
const EXCLUDED_DIRECTORIES = new Set([
  '__tests__',
  'generated',
  'target',
  'tests',
]);

interface SourceFile {
  absolutePath: string;
  repoPath: string;
}

function repoPath(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join('/');
}

function isTestFile(name: string): boolean {
  return name === 'tests.rs' || /\.(?:test|spec)\.(?:ts|tsx)$/.test(name);
}

function collect(path: string, output: SourceFile[]): void {
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const absolutePath = join(path, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) collect(absolutePath, output);
      continue;
    }
    if (!entry.isFile()
      || !SOURCE_EXTENSIONS.has(extname(entry.name))
      || isTestFile(entry.name)) {
      continue;
    }
    output.push({ absolutePath, repoPath: repoPath(absolutePath) });
  }
}

function main(): void {
  const files: SourceFile[] = [];
  for (const root of ROOTS) collect(join(REPO_ROOT, root), files);

  const violations = files
    .map((file) => ({
      ...file,
      loc: readFileSync(file.absolutePath, 'utf8').split(/\r?\n/).length,
    }))
    .filter((file) => file.loc > LOC_CAP)
    .sort((left, right) => right.loc - left.loc);

  if (violations.length > 0) {
    console.error(`Rust-agent LOC cap exceeded (${LOC_CAP}):`);
    for (const violation of violations) {
      console.error(`  ${violation.loc.toString().padStart(4)}  ${violation.repoPath}`);
    }
    process.exit(1);
  }

  console.log(
    `Rust-agent LOC budget holds: ${files.length} production module(s), cap ${LOC_CAP}.`,
  );
}

main();
