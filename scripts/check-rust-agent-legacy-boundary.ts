#!/usr/bin/env tsx
/**
 * Ratchet for the Rust-agent migration boundary.
 *
 * Existing imports from the legacy runtime are captured in a generated
 * baseline. New files, module specifiers, or imported symbols fail the check;
 * removals are allowed and reported so the baseline can only shrink.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = process.cwd();
const BASELINE_PATH = join(
  REPO_ROOT,
  'scripts',
  'rust-agent-legacy-boundary-baseline.json',
);
const SCAN_ROOTS = ['apps', 'packages', 'services', 'src', 'extensions', 'scripts'];
const ROOT_FILES = ['package.json', 'tsconfig.base.json', 'vitest.config.ts'];
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
]);
const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  'dist',
  'node_modules',
  'target',
  'generated',
]);
const SELF_PATHS = new Set([
  'scripts/check-rust-agent-legacy-boundary.ts',
  'scripts/rust-agent-legacy-boundary-baseline.json',
]);

type ReferenceKind = 'import' | 'export' | 'dynamic' | 'require' | 'literal';

interface BoundaryReference {
  file: string;
  kind: ReferenceKind;
  specifier: string;
  symbols: string[];
}

function toRepoPath(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join('/');
}

function isLegacySpecifier(specifier: string): boolean {
  const normalized = specifier.replaceAll('\\', '/');
  return normalized === '@mcp/code-agent'
    || normalized.startsWith('@mcp/code-agent/')
    || normalized.includes('packages/code-agent/src');
}

function shouldSkipDirectory(path: string, name: string): boolean {
  if (EXCLUDED_DIRECTORIES.has(name) || name.startsWith('.')) return true;
  return toRepoPath(path) === 'packages/code-agent';
}

function collectFiles(path: string, output: string[]): void {
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const absolute = join(path, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkipDirectory(absolute, entry.name)) collectFiles(absolute, output);
      continue;
    }
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extname(entry.name))) continue;
    if (!SELF_PATHS.has(toRepoPath(absolute))) output.push(absolute);
  }
}

function importedSymbols(node: ts.ImportDeclaration): string[] {
  const clause = node.importClause;
  if (!clause) return ['<side-effect>'];

  const symbols: string[] = [];
  if (clause.name) symbols.push('default');
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) symbols.push('*');
  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      symbols.push(element.isTypeOnly ? `type:${imported}` : imported);
    }
  }
  return symbols.sort();
}

function exportedSymbols(node: ts.ExportDeclaration): string[] {
  if (!node.exportClause) return ['*'];
  if (ts.isNamespaceExport(node.exportClause)) return [`* as ${node.exportClause.name.text}`];
  return node.exportClause.elements
    .map((element) => element.propertyName?.text ?? element.name.text)
    .sort();
}

function scriptKind(path: string): ts.ScriptKind {
  const extension = extname(path);
  if (extension === '.tsx') return ts.ScriptKind.TSX;
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function collectAstReferences(path: string, source: string): BoundaryReference[] {
  const file = toRepoPath(path);
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(path),
  );
  const references: BoundaryReference[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (isLegacySpecifier(specifier)) {
        references.push({ file, kind: 'import', specifier, symbols: importedSymbols(node) });
      }
    } else if (ts.isExportDeclaration(node)
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (isLegacySpecifier(specifier)) {
        references.push({ file, kind: 'export', specifier, symbols: exportedSymbols(node) });
      }
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const [argument] = node.arguments;
      if (!ts.isStringLiteral(argument) || !isLegacySpecifier(argument.text)) {
        ts.forEachChild(node, visit);
        return;
      }
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        references.push({
          file,
          kind: 'dynamic',
          specifier: argument.text,
          symbols: ['*'],
        });
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        references.push({
          file,
          kind: 'require',
          specifier: argument.text,
          symbols: ['*'],
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return references;
}

function collectLiteralReferences(path: string, source: string): BoundaryReference[] {
  const file = toRepoPath(path);
  const references: BoundaryReference[] = [];
  const legacyReference =
    /@mcp\/code-agent(?:\/[A-Za-z0-9._*{}@-]+)*|packages[\\/]code-agent(?:[\\/]src)?(?:[\\/][A-Za-z0-9._*{}@-]+)*/g;
  let match: RegExpExecArray | null;
  while ((match = legacyReference.exec(source)) !== null) {
    const specifier = match[0].replaceAll('\\', '/');
    references.push({ file, kind: 'literal', specifier, symbols: [] });
  }
  return references;
}

function referenceKey(reference: BoundaryReference): string {
  return [
    reference.file,
    reference.kind,
    reference.specifier.replaceAll('\\', '/'),
    [...reference.symbols].sort().join(','),
  ].join('::');
}

function scan(): string[] {
  const files = ROOT_FILES
    .map((path) => join(REPO_ROOT, path))
    .filter((path) => existsSync(path) && statSync(path).isFile());
  for (const root of SCAN_ROOTS) collectFiles(join(REPO_ROOT, root), files);

  const references: BoundaryReference[] = [];
  for (const path of files) {
    const source = readFileSync(path, 'utf8');
    if (extname(path) === '.json') {
      references.push(...collectLiteralReferences(path, source));
    } else {
      references.push(...collectAstReferences(path, source));
    }
  }
  return [...new Set(references.map(referenceKey))].sort();
}

function main(): void {
  const current = scan();
  if (process.argv.includes('--write-baseline')) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${current.length} legacy boundary reference(s).`);
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error('Legacy boundary baseline is missing; run with --write-baseline.');
    process.exit(1);
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as string[];
  const allowed = new Set(baseline);
  const actual = new Set(current);
  const additions = current.filter((reference) => !allowed.has(reference));
  const removals = baseline.filter((reference) => !actual.has(reference));

  if (removals.length > 0) {
    console.log(
      `${removals.length} legacy reference(s) were removed; regenerate the baseline to ratchet it down.`,
    );
  }
  if (additions.length > 0) {
    console.error(`${additions.length} new legacy reference(s) are forbidden:`);
    for (const reference of additions) console.error(`  ${reference}`);
    process.exit(1);
  }

  console.log(
    `Legacy boundary holds: ${current.length} active reference(s), ${removals.length} removable baseline entry(s).`,
  );
}

main();
