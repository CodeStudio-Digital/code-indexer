/**
 * Declarative registry of external linters + project-local detection.
 *
 * A spec parameterizes the generic runner by: which Monaco languages it lints,
 * the npm package to resolve in the project's `node_modules`, the argv it needs
 * (stdin-filename + JSON output), and the parser that normalizes its output to
 * a `SarifRun`. Adding a linter = one entry here (WebStorm's File-Watchers /
 * external-annotator model, generalized).
 *
 * v1: node-based tools (stylelint, eslint), detected via project-local install.
 * Native tools (shellcheck/phpcs/ruff) arrive in phase 2 with a `path`/download
 * detection kind.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SarifRun } from './sarif.js';
import { parseStylelintJson, parseEslintJson } from './parsers.js';

export interface LintToolSpec {
  id: string;
  label: string;
  /** Monaco languageIds this tool lints (matches document-store `languageId`). */
  languages: string[];
  /** npm package resolved in `<root>/node_modules` (node-based tools). */
  npmPackage: string;
  /** Tool args after the resolved bin. `relFile` feeds `--stdin-filename`. */
  args: (relFile: string) => string[];
  /** Normalize tool stdout → unified SARIF run. */
  parse: (stdout: string) => SarifRun;
  /** Whether `<tool> --fix` can auto-correct (A6 "Fix all" action). */
  supportsFix: boolean;
}

/** `--stdin --stdin-filename <rel> -f json` — the shared node-linter invocation. */
const stdinJsonArgs = (relFile: string): string[] => ['--stdin', '--stdin-filename', relFile, '-f', 'json'];

export const LINT_TOOLS: LintToolSpec[] = [
  {
    id: 'stylelint',
    label: 'Stylelint',
    languages: ['css', 'scss', 'less'],
    npmPackage: 'stylelint',
    args: stdinJsonArgs,
    parse: parseStylelintJson,
    supportsFix: true,
  },
  {
    id: 'eslint',
    label: 'ESLint',
    languages: ['javascript', 'typescript'],
    npmPackage: 'eslint',
    args: stdinJsonArgs,
    parse: parseEslintJson,
    supportsFix: true,
  },
];

/** Tools that lint a given Monaco language (multiple may apply to one file). */
export function toolsForLanguage(languageId: string): LintToolSpec[] {
  return LINT_TOOLS.filter((t) => t.languages.includes(languageId));
}

/**
 * Resolve the tool's runnable JS entry inside the project's `node_modules`
 * (spawned as `node <binJs>` for cross-platform uniformity — the `.bin` shim is
 * a bash script on POSIX and a `.cmd` on Windows). Null when not installed:
 * the caller then skips the tool silently (detect-only, no nagging).
 */
export function resolveNodeToolBin(root: string, spec: LintToolSpec): string | null {
  const pkgDir = join(root, 'node_modules', spec.npmPackage);
  const pkgJson = join(pkgDir, 'package.json');
  if (!existsSync(pkgJson)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgJson, 'utf-8')) as { bin?: string | Record<string, string> };
    const bin = pkg.bin;
    const rel = typeof bin === 'string' ? bin : bin?.[spec.id] ?? (bin ? Object.values(bin)[0] : undefined);
    if (!rel) return null;
    const abs = join(pkgDir, rel);
    return existsSync(abs) ? abs : null;
  } catch {
    return null;
  }
}
