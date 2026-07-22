import ts from 'typescript';
import type { LspServerDef } from '@mcp/services/lsp/server-registry.js';

const ANGULAR_COMPONENT_STRING_FIELDS = new Set([
  'template',
  'templateUrl',
  'styles',
  'styleUrl',
  'styleUrls',
]);

interface ParsedRanges {
  content: string;
  lineStarts: readonly number[];
  ranges: Array<{ start: number; end: number }>;
}

const RANGE_CACHE_LIMIT = 256;
const rangeCache = new Map<string, ParsedRanges>();

export function isAngularLanguageServer(def: LspServerDef): boolean {
  return def.role === 'overlay' && def.launchKind === 'angular';
}

function propertyName(node: ts.PropertyName): string | null {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return null;
}

interface ComponentDecoratorImports {
  named: ReadonlySet<string>;
  namespaces: ReadonlySet<string>;
}

function isComponentDecoratorCall(
  node: ts.CallExpression,
  imports: ComponentDecoratorImports,
): boolean {
  if (!ts.isDecorator(node.parent)) return false;
  if (ts.isIdentifier(node.expression)) return imports.named.has(node.expression.text);
  return ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && imports.namespaces.has(node.expression.expression.text)
    && node.expression.name.text === 'Component';
}

function componentDecoratorImports(source: ts.SourceFile): ComponentDecoratorImports {
  const named = new Set(['Component']);
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== '@angular/core') continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      if ((element.propertyName?.text ?? element.name.text) === 'Component') {
        named.add(element.name.text);
      }
    }
  }
  return { named, namespaces };
}

function collectStringRanges(node: ts.Node, out: ParsedRanges['ranges']): void {
  if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
    out.push({ start: node.getStart(), end: node.getEnd() });
    return;
  }
  node.forEachChild((child) => collectStringRanges(child, out));
}

function parseRanges(content: string, file: string): ParsedRanges {
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    /\.tsx$/i.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const ranges: ParsedRanges['ranges'] = [];
  const componentImports = componentDecoratorImports(source);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isComponentDecoratorCall(node, componentImports)) {
      const metadata = node.arguments[0];
      if (metadata && ts.isObjectLiteralExpression(metadata)) {
        for (const property of metadata.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const name = propertyName(property.name);
          if (!name || !ANGULAR_COMPONENT_STRING_FIELDS.has(name)) continue;
          collectStringRanges(property.initializer, ranges);
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  return { content, lineStarts: source.getLineStarts(), ranges };
}

function rangesFor(cacheKey: string, file: string, content: string): ParsedRanges {
  const cached = rangeCache.get(cacheKey);
  if (cached?.content === content) {
    rangeCache.delete(cacheKey);
    rangeCache.set(cacheKey, cached);
    return cached;
  }
  const parsed = parseRanges(content, file);
  rangeCache.set(cacheKey, parsed);
  while (rangeCache.size > RANGE_CACHE_LIMIT) {
    const oldest = rangeCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    rangeCache.delete(oldest);
  }
  return parsed;
}

function offsetAt(parsed: ParsedRanges, position: { line: number; column: number }): number {
  const line = Math.max(0, Math.min(parsed.lineStarts.length - 1, position.line - 1));
  const lineStart = parsed.lineStarts[line] ?? 0;
  const nextLineStart = parsed.lineStarts[line + 1] ?? parsed.content.length;
  return Math.max(lineStart, Math.min(nextLineStart, lineStart + Math.max(0, position.column - 1)));
}

/**
 * The Angular LS shares the TypeScript document selector, but its interactive
 * TS features only belong inside Angular component metadata. Keep the normal
 * TS service authoritative everywhere else, matching the official client.
 */
export function isAngularComponentMetadataPosition(
  cacheKey: string,
  file: string,
  content: string,
  position: { line: number; column: number },
): boolean {
  const parsed = rangesFor(cacheKey, file, content);
  const offset = offsetAt(parsed, position);
  return parsed.ranges.some((range) => offset >= range.start && offset <= range.end);
}

export function shouldUseAngularInteractiveOverlay(input: {
  projectId: number;
  file: string;
  languageId: string;
  content: string | null | undefined;
  position: { line: number; column: number };
}): boolean {
  if (input.languageId === 'html') return true;
  if (input.languageId !== 'typescript' || input.content == null) return false;
  return isAngularComponentMetadataPosition(
    `${input.projectId}:${input.file}`,
    input.file,
    input.content,
    input.position,
  );
}

export function shouldUseAngularInteractiveOverlayRange(input: {
  projectId: number;
  file: string;
  languageId: string;
  content: string | null | undefined;
  range: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
}): boolean {
  if (input.languageId === 'html') return true;
  if (input.languageId !== 'typescript' || input.content == null) return false;
  const parsed = rangesFor(`${input.projectId}:${input.file}`, input.file, input.content);
  const start = offsetAt(parsed, input.range.start);
  const end = offsetAt(parsed, input.range.end);
  const rangeStart = Math.min(start, end);
  const rangeEnd = Math.max(start, end);
  return parsed.ranges.some((metadata) => rangeEnd >= metadata.start && rangeStart <= metadata.end);
}

export function clearAngularOverlayRoutingCache(projectId: number, file: string): void {
  rangeCache.delete(`${projectId}:${file}`);
}
