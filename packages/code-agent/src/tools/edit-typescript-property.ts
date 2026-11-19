import type ts from 'typescript';

const MAX_SOURCE_LENGTH = 256 * 1024;
const MAX_SNIPPET_LENGTH = 16 * 1024;

interface TypeProperty {
  literalStart: number;
  afterName: number;
  typeEnd: number | undefined;
}

function typeProperties(compiler: typeof ts, path: string, text: string): TypeProperty[] {
  let file: ts.SourceFile;
  try {
    file = compiler.createSourceFile(path, text, compiler.ScriptTarget.Latest);
  } catch (error) {
    if (error instanceof RangeError) return [];
    throw error;
  }
  const properties: TypeProperty[] = [];
  const pending: ts.Node[] = [file];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (compiler.isTypeLiteralNode(node) && text[node.end - 1] === '}') {
      const literalStart = node.getStart(file);
      for (const member of node.members) {
        if (!compiler.isPropertySignature(member) || !compiler.isIdentifier(member.name)) continue;
        properties.push({
          literalStart,
          afterName: member.questionToken?.end ?? member.name.end,
          typeEnd: member.type?.end,
        });
      }
    }
    compiler.forEachChild(node, child => { pending.push(child); });
  }
  return properties;
}

function propertyAnchor(text: string, property: TypeProperty): string | null {
  const beforeLiteral = property.literalStart - 1;
  const lineStart = Math.max(text.lastIndexOf('\n', beforeLiteral), text.lastIndexOf('\r', beforeLiteral)) + 1;
  // Include the declaration/expression that owns the literal in the anchor.
  if (!text.slice(lineStart, property.literalStart).trim()) return null;
  return text.slice(lineStart, property.afterName).trimStart();
}

/** Restore an annotation omitted from both snippets when every other byte
 * of the old snippet matches live source and the same property is retained. */
export async function recoverOmittedTypeProperty(
  path: string,
  content: string,
  oldStr: string,
  newStr: string,
): Promise<{ occurrences: number; content?: string } | null> {
  if (!/\.(?:[cm]?ts|tsx)$/i.test(path) || !oldStr.includes('{') ||
      content.length > MAX_SOURCE_LENGTH || Math.max(oldStr.length, newStr.length) > MAX_SNIPPET_LENGTH) {
    return null;
  }
  const eol = /\r\n?|\n/.exec(content)?.[0] ?? '\n';
  const oldSnippet = oldStr.replace(/\r\n?|\n/g, eol);
  const newSnippet = newStr.replace(/\r\n?|\n/g, eol);
  const { default: compiler } = await import('typescript');
  const omitted = typeProperties(compiler, path, oldSnippet).filter(property => property.typeEnd === undefined);
  if (omitted.length !== 1) return null;

  const [property] = omitted;
  const anchor = propertyAnchor(oldSnippet, property);
  if (!anchor) return null;
  const prefix = oldSnippet.slice(0, property.afterName);
  const suffix = oldSnippet.slice(property.afterName);
  if (!content.includes(prefix)) return null;
  const replacements = typeProperties(compiler, path, newSnippet)
    .filter(candidate => newSnippet.startsWith(anchor, candidate.afterName - anchor.length) &&
      propertyAnchor(newSnippet, candidate) === anchor);
  if (replacements.length !== 1 || replacements[0].typeEnd !== undefined) return null;

  const matches = typeProperties(compiler, path, content).filter(candidate => {
    if (candidate.typeEnd === undefined) return false;
    const start = candidate.afterName - prefix.length;
    return start >= 0 && content.startsWith(prefix, start) && content.startsWith(suffix, candidate.typeEnd) &&
      propertyAnchor(content, candidate) === anchor;
  });
  if (matches.length === 0) return null;
  if (matches.length > 1) return { occurrences: matches.length };

  const [match] = matches;
  const typeEnd = match.typeEnd!;
  const afterName = replacements[0].afterName;
  const annotation = content.slice(match.afterName, typeEnd);
  const replacement = newSnippet.slice(0, afterName) + annotation + newSnippet.slice(afterName);
  return {
    occurrences: 1,
    content: content.slice(0, match.afterName - prefix.length) + replacement + content.slice(typeEnd + suffix.length),
  };
}
