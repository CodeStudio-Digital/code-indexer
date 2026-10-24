import type Parser from 'web-tree-sitter';

const namedType = new Set(['identifier', 'type_identifier', 'nested_type_identifier', 'scoped_type_identifier',
  'qualified_name', 'scoped_identifier', 'member_expression']);
function typeName(node: Parser.SyntaxNode): string | null {
  if (namedType.has(node.type)) return node.text;
  if (node.type === 'generic_type') {
    const base = node.childForFieldName('name') ?? node.namedChildren.find(child => child.type !== 'type_arguments');
    return base ? typeName(base) : null;
  }
  return null;
}
function names(clause: Parser.SyntaxNode): string[] {
  return clause.namedChildren.flatMap(child => {
    if (child.type === 'type_list') return names(child);
    const name = typeName(child); return name ? [name] : [];
  });
}

export function extendsNames(node: Parser.SyntaxNode): string[] {
  const result: string[] = [];
  for (const child of node.namedChildren) {
    if (['extends_clause', 'extends_type_clause', 'superclass'].includes(child.type)) result.push(...names(child));
    if (child.type === 'class_heritage') {
      // TypeScript nests extends/implements clauses; JavaScript exposes its
      // superclass directly. Never reinterpret an implements-only heritage.
      for (const part of child.namedChildren) {
        if (part.type === 'extends_clause') result.push(...names(part));
        else { const name = typeName(part); if (name) result.push(name); }
      }
    }
  }
  if (node.type === 'impl_item') {
    const trait = node.childForFieldName('trait'); if (trait) result.push(typeName(trait) ?? trait.text);
  }
  return [...new Set(result)];
}

export function implementedNames(node: Parser.SyntaxNode): string[] {
  const result: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'implements_clause' || child.type === 'super_interfaces') result.push(...names(child));
    if (child.type === 'class_heritage') {
      for (const clause of child.namedChildren) if (clause.type === 'implements_clause') result.push(...names(clause));
    }
  }
  return [...new Set(result)];
}
