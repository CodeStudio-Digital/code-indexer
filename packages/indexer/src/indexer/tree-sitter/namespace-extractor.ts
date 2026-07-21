/**
 * Namespace/FQN extraction per language (migration 187).
 *
 * Two strategies:
 *  - DECLARED: read the namespace/package node from the AST (PHP, Go, Java,
 *    C#, Kotlin) — one pass over the root's children, first match wins
 *    (multi-namespace PHP files are rare enough to accept the first).
 *  - PATH-DERIVED: languages whose module identity IS the file path
 *    (Python dotted module, Rust mod path). `filePath` is the
 *    PROJECT-RELATIVE path (that's what the indexer feeds extract()).
 *
 * TS/JS/Ruby/CSS/HTML/Vue return null: TS/JS resolve imports by file path
 * (the import-plan already uses file_path), Ruby nesting lives in `parent`.
 */
import type Parser from 'web-tree-sitter';

/** PHP trait mixins inside a class body: `use TraitA, TraitB;`. */
export function extractPhpTraitUses(classNode: Parser.SyntaxNode): string[] {
  const body = classNode.childForFieldName('body');
  if (!body) return [];
  const traits: string[] = [];
  for (const child of body.namedChildren) {
    if (child.type !== 'use_declaration') continue;
    for (const name of child.namedChildren) {
      // name / qualified_name children; skip use_list (conflict resolution blocks)
      if (name.type === 'name' || name.type === 'qualified_name') {
        traits.push(lastSegment(name.text, '\\'));
      }
    }
  }
  return traits;
}

export function extractNamespace(
  rootNode: Parser.SyntaxNode,
  language: string,
  filePath: string,
): string | null {
  switch (language) {
    case 'php': return declared(rootNode, 'namespace_definition', ['namespace_name', 'name', 'qualified_name']);
    case 'go': return declared(rootNode, 'package_clause', ['package_identifier', 'identifier']);
    case 'java': return declared(rootNode, 'package_declaration', ['scoped_identifier', 'identifier']);
    case 'kotlin': return declared(rootNode, 'package_header', ['identifier', 'qualified_identifier']);
    case 'csharp': return csharpNamespace(rootNode);
    case 'python': return pythonModule(filePath);
    case 'rust': return rustModPath(filePath);
    default: return null;
  }
}

function lastSegment(text: string, sep: string): string {
  const idx = text.lastIndexOf(sep);
  return idx >= 0 ? text.slice(idx + sep.length) : text;
}

/** First top-level `nodeType` child; namespace text from its first matching child. */
function declared(root: Parser.SyntaxNode, nodeType: string, nameTypes: string[]): string | null {
  for (const child of root.namedChildren) {
    if (child.type !== nodeType) continue;
    for (const sub of child.namedChildren) {
      if (nameTypes.includes(sub.type)) return sub.text || null;
    }
    return null; // e.g. bare `namespace;` — declared but unnamed
  }
  return null;
}

/** C#: classic block namespaces AND file-scoped (`namespace X;`) — nested blocks joined. */
function csharpNamespace(root: Parser.SyntaxNode): string | null {
  const parts: string[] = [];
  let scope: Parser.SyntaxNode | null = root;
  while (scope) {
    let next: Parser.SyntaxNode | null = null;
    for (const child of scope.namedChildren) {
      if (child.type === 'namespace_declaration' || child.type === 'file_scoped_namespace_declaration') {
        const name = child.childForFieldName('name');
        if (name) parts.push(name.text);
        next = child.childForFieldName('body') ?? null;
        break;
      }
    }
    scope = next;
  }
  return parts.length > 0 ? parts.join('.') : null;
}

/** `pkg/mod.py` → `pkg.mod`; `pkg/__init__.py` → `pkg`; root file → module name. */
function pythonModule(filePath: string): string | null {
  const norm = filePath.replace(/\\/g, '/').replace(/\.pyi?$/, '');
  const parts = norm.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  if (parts[parts.length - 1] === '__init__') parts.pop();
  return parts.length > 0 ? parts.join('.') : null;
}

/** `src/foo/bar.rs` → `foo::bar`; crate roots (main/lib/mod) collapse to their dir. */
function rustModPath(filePath: string): string | null {
  const norm = filePath.replace(/\\/g, '/').replace(/\.rs$/, '');
  const parts = norm.split('/').filter(Boolean);
  if (parts[0] === 'src') parts.shift();
  const last = parts[parts.length - 1];
  if (last === 'main' || last === 'lib' || last === 'mod') parts.pop();
  return parts.length > 0 ? parts.join('::') : null;
}

/**
 * Namespace for the PATH-DERIVED languages (Python dotted module, Rust mod
 * path) — computable without an AST. The extract-cache uses this to re-stamp
 * cached symbols when reusing content-keyed analysis at a DIFFERENT path.
 * Returns `undefined` for every other language: their namespace is declared
 * in content, so the cached value is already correct as stored.
 */
export function pathDerivedNamespace(language: string, filePath: string): string | null | undefined {
  switch (language) {
    case 'python': return pythonModule(filePath);
    case 'rust': return rustModPath(filePath);
    default: return undefined;
  }
}
