/**
 * Locate the JSX element a `data-mcp-loc` stamp points at, with the byte
 * ranges the rewriters need. The stamp contract is owned by
 * `sandbox/builder/source-stamp/babel-plugin-source.ts`:
 *
 *     loc = `${relpath}:${loc.start.line}:${loc.start.column + 1}`
 *
 * i.e. 1-based line, 1-based column of the JSXOpeningElement start.
 *
 * Babel's `loc.start.column` is 0-based, so we match `column + 1`. The
 * walker is a ~20-line recursive visitor instead of @babel/traverse — we
 * only need positions, not scopes.
 */
import { parse } from '@babel/parser';
import type { File, JSXElement, JSXOpeningElement, Node } from '@babel/types';

export interface LocatedElement {
  opening: JSXOpeningElement;
  /** Parent element (null for self-closing — no children to text-edit). */
  element: JSXElement | null;
  /** Ordinal of this opening element in document order (newLoc anchor). */
  ordinal: number;
  /** Lowercased tag for stale checks (`div`, `button`, `Button` → original case kept). */
  tagName: string;
}

export function parseSource(code: string): File {
  return parse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'],
    errorRecovery: false,
  });
}

function walk(node: Node | null | undefined, visit: (n: Node) => void): void {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node) as Array<keyof Node>) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
    const value = node[key] as unknown;
    if (Array.isArray(value)) {
      for (const item of value) walk(item as Node, visit);
    } else if (value && typeof (value as Node).type === 'string') {
      walk(value as Node, visit);
    }
  }
}

function tagNameOf(opening: JSXOpeningElement): string {
  const name = opening.name;
  if (name.type === 'JSXIdentifier') return name.name;
  if (name.type === 'JSXMemberExpression') {
    // e.g. <Tabs.Trigger> — property name is the discriminating part.
    return name.property.name;
  }
  return 'unknown';
}

/** Find the opening element whose start matches the stamp's line/column. */
export function locateAt(ast: File, line: number, column: number): LocatedElement | null {
  let ordinal = -1;
  let found: LocatedElement | null = null;
  walk(ast.program, (n) => {
    if (n.type === 'JSXElement') {
      const opening = n.openingElement;
      // Visitation order is document order for JSXElement nodes.
      ordinal += 1;
      if (
        !found &&
        opening.loc &&
        opening.loc.start.line === line &&
        opening.loc.start.column + 1 === column
      ) {
        found = {
          opening,
          element: opening.selfClosing ? null : n,
          ordinal,
          tagName: tagNameOf(opening),
        };
      }
    }
  });
  return found;
}

/**
 * After a rewrite shifted positions, recompute the stamp loc for the same
 * element by ordinal. Returns `line:column` (1-based, stamp convention) or
 * null when the ordinal vanished (should not happen for in-place edits).
 */
export function locByOrdinal(ast: File, targetOrdinal: number): string | null {
  let ordinal = -1;
  let out: string | null = null;
  walk(ast.program, (n) => {
    if (n.type === 'JSXElement') {
      ordinal += 1;
      if (out === null && ordinal === targetOrdinal && n.openingElement.loc) {
        const s = n.openingElement.loc.start;
        out = `${s.line}:${s.column + 1}`;
      }
    }
  });
  return out;
}
