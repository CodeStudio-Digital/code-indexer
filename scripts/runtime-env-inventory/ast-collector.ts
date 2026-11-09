import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.vite', '.git', 'coverage', '__tests__']);

export interface EnvConsumer {
  file: string;
  line: number;
  column: number;
  readTiming: 'module' | 'construction' | 'runtime';
  expression: string;
}

export interface EnvHit {
  key: string;
  consumers: EnvConsumer[];
  votes: Record<'bool' | 'int' | 'float' | 'enum' | 'string', number>;
  enums: Set<string>;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile() && /\.[cm]?tsx?$/.test(path) && !/\.(?:d\.ts|test\.[cm]?tsx?|spec\.[cm]?tsx?)$/.test(path)) out.push(path);
  }
  return out;
}

function isProcessEnv(node: ts.Node): boolean {
  return ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'process'
    && node.name.text === 'env';
}

function envKey(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression)) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(node.name.text) ? node.name.text : null;
  }
  if (ts.isElementAccessExpression(node) && isProcessEnv(node.expression)) {
    const argument = node.argumentExpression;
    if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(argument.text) ? argument.text : null;
    }
  }
  return null;
}

/** Resolve only a const for-of binding over an inline list of literal names.
 * Mutable bindings, runtime lists and shadowed variables remain dynamic. */
function literalLoopKeys(node: ts.Node): string[] | null {
  if (!ts.isElementAccessExpression(node) || !isProcessEnv(node.expression)
    || !node.argumentExpression || !ts.isIdentifier(node.argumentExpression)) return null;
  const name = node.argumentExpression.text;
  for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) return null;
    if (!ts.isForOfStatement(scope) || node.pos < scope.statement.pos) continue;
    const declarations = scope.initializer;
    if (!ts.isVariableDeclarationList(declarations) || !(declarations.flags & ts.NodeFlags.Const)
      || declarations.declarations.length !== 1 || !ts.isIdentifier(declarations.declarations[0]!.name)
      || declarations.declarations[0]!.name.text !== name || !ts.isArrayLiteralExpression(scope.expression)) return null;
    if (!scope.expression.elements.every(value => ts.isStringLiteral(value)
      && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.text))) return null;
    let shadowed = false;
    const inspect = (child: ts.Node): void => {
      if (ts.isVariableDeclaration(child) || ts.isFunctionDeclaration(child) || ts.isClassDeclaration(child)) {
        const binding = (part: ts.Node): void => {
          if (ts.isIdentifier(part) && part.text === name) shadowed = true;
          ts.forEachChild(part, binding);
        };
        if (child.name) binding(child.name);
      }
      ts.forEachChild(child, inspect);
    };
    inspect(scope.statement);
    if (shadowed) return null;
    return scope.expression.elements.map(value => (value as ts.StringLiteral).text);
  }
  return null;
}

function isWrite(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isDeleteExpression(parent)) return true;
  return ts.isBinaryExpression(parent)
    && parent.left === node
    && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
    && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
}

function readTiming(node: ts.Node): EnvConsumer['readTiming'] {
  let cursor: ts.Node | undefined = node.parent;
  while (cursor && !ts.isSourceFile(cursor)) {
    if (ts.isConstructorDeclaration(cursor)) return 'construction';
    if (ts.isFunctionLike(cursor)) return 'runtime';
    cursor = cursor.parent;
  }
  return 'module';
}

function inferType(expression: string, key: string): { type: keyof EnvHit['votes']; enumLit?: string } {
  if (/===?\s*['"](?:0|1|true|false)['"]|!==?\s*['"](?:0|1|true|false)['"]/.test(expression)) {
    return { type: 'bool' };
  }
  if (/parseFloat\s*\(/.test(expression)) return { type: 'float' };
  if (/(?:Number|parseInt)\s*\(/.test(expression)) return { type: 'int' };
  const enumMatch = /===?\s*['"]([a-z][a-z0-9_-]+)['"]/i.exec(expression);
  if (enumMatch && !/^(?:true|false)$/i.test(enumMatch[1])) {
    return { type: 'enum', enumLit: enumMatch[1].toLowerCase() };
  }
  return { type: 'string' };
}

export function collectEnvReads(repoRoot: string, roots: readonly string[]): {
  scannedFiles: number;
  hits: Map<string, EnvHit>;
  dynamicConsumers: EnvConsumer[];
} {
  const hits = new Map<string, EnvHit>();
  const dynamicConsumers: EnvConsumer[] = [];
  let scannedFiles = 0;
  for (const root of roots) {
    let files: string[];
    try {
      files = walk(join(repoRoot, root));
    } catch {
      continue;
    }
    for (const file of files) {
      scannedFiles++;
      const source = readFileSync(file, 'utf8');
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        const directKey = envKey(node);
        const keys = directKey ? [directKey] : literalLoopKeys(node);
        if (
          !keys
          && ts.isElementAccessExpression(node)
          && isProcessEnv(node.expression)
          && !isWrite(node)
        ) {
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          dynamicConsumers.push({
            file: relative(repoRoot, file).replace(/\\/g, '/'),
            line: position.line + 1,
            column: position.character + 1,
            readTiming: readTiming(node),
            expression: node.parent.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 240),
          });
        }
        for (const key of keys && !isWrite(node) ? keys : []) {
          const parentText = node.parent.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 240);
          const inferred = inferType(parentText, key);
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          const hit = hits.get(key) ?? {
            key,
            consumers: [],
            votes: { bool: 0, int: 0, float: 0, enum: 0, string: 0 },
            enums: new Set<string>(),
          };
          hit.consumers.push({
            file: relative(repoRoot, file).replace(/\\/g, '/'),
            line: position.line + 1,
            column: position.character + 1,
            readTiming: readTiming(node),
            expression: parentText,
          });
          hit.votes[inferred.type]++;
          if (inferred.enumLit) hit.enums.add(inferred.enumLit);
          hits.set(key, hit);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }
  return { scannedFiles, hits, dynamicConsumers };
}

/**
 * Inverse catalog audit. Indirect references (helper arguments, env aliases,
 * policy maps and dashboard settings) are evidence to review, not proof that a
 * value is read. Comments, tests, catalog declarations and migrations do not
 * keep an obsolete setting alive. No values from local env files are returned.
 */
export function collectSettingReferences(repoRoot: string, roots: readonly string[], keys: Iterable<string>): Map<string, EnvConsumer[]> {
  const references = new Map([...keys].map((key) => [key, [] as EnvConsumer[]]));
  for (const root of roots) {
    let files: string[];
    try { files = walk(join(repoRoot, root)); } catch { continue; }
    for (const file of files) {
      const name = relative(repoRoot, file).replace(/\\/g, '/');
      if (/\/migrations\/|\/app-settings(?:\/|-catalog\.ts)/.test(name)) continue;
      const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          const matches = references.get(node.text);
          if (matches) {
            const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            matches.push({ file: name, line: position.line + 1, column: position.character + 1,
              readTiming: readTiming(node), expression: node.parent.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 240) });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }
  return references;
}
