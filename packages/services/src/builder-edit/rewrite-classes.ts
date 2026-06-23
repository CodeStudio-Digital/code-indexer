/**
 * Surgical className rewrite on a located JSX opening element. Only the
 * exact byte range of the class string changes — the rest of the file is
 * untouched (magic-string), so formatting, comments and diffs stay clean.
 *
 * Editable shapes:
 *   className="a b"            → replace the literal contents
 *   className={"a b"}          → replace the literal contents
 *   className={cn('a b', …)}   → replace the FIRST string-literal arg
 *   <el …> (no className)      → insert ` className="…"` after the name
 *
 * Anything else (template literals, identifiers, conditionals) is refused
 * — the caller falls back to "ask the agent".
 */
import MagicString from 'magic-string';
import type { JSXAttribute, JSXOpeningElement } from '@babel/types';

export type RewriteResult =
  | { ok: true; code: string }
  | { ok: false; reason: string };

function findClassNameAttr(opening: JSXOpeningElement): JSXAttribute | null {
  for (const attr of opening.attributes) {
    if (attr.type === 'JSXAttribute' && attr.name.type === 'JSXIdentifier' && attr.name.name === 'className') {
      return attr;
    }
  }
  return null;
}

/** JSX double-quoted attribute value — escape only the quote itself. */
function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;');
}

export function rewriteClasses(
  code: string,
  opening: JSXOpeningElement,
  classes: string,
): RewriteResult {
  const ms = new MagicString(code);
  const attr = findClassNameAttr(opening);

  if (!attr) {
    const nameEnd = opening.name.end;
    if (typeof nameEnd !== 'number') return { ok: false, reason: 'element has no position info' };
    ms.appendRight(nameEnd, ` className="${escapeAttr(classes)}"`);
    return { ok: true, code: ms.toString() };
  }

  const value = attr.value;
  if (!value) return { ok: false, reason: 'className is a bare attribute' };

  // className="a b"
  if (value.type === 'StringLiteral') {
    if (typeof value.start !== 'number' || typeof value.end !== 'number') {
      return { ok: false, reason: 'literal has no position info' };
    }
    ms.overwrite(value.start, value.end, `"${escapeAttr(classes)}"`);
    return { ok: true, code: ms.toString() };
  }

  if (value.type === 'JSXExpressionContainer') {
    const expr = value.expression;
    // className={"a b"}
    if (expr.type === 'StringLiteral' && typeof expr.start === 'number' && typeof expr.end === 'number') {
      ms.overwrite(expr.start, expr.end, JSON.stringify(classes));
      return { ok: true, code: ms.toString() };
    }
    // className={cn('a b', cond && '…')} — edit the first literal arg only.
    if (
      expr.type === 'CallExpression' &&
      expr.callee.type === 'Identifier' &&
      (expr.callee.name === 'cn' || expr.callee.name === 'clsx' || expr.callee.name === 'cx')
    ) {
      const first = expr.arguments[0];
      if (first && first.type === 'StringLiteral' && typeof first.start === 'number' && typeof first.end === 'number') {
        ms.overwrite(first.start, first.end, JSON.stringify(classes));
        return { ok: true, code: ms.toString() };
      }
      return { ok: false, reason: `dynamic className — ${expr.callee.name}(…) without a leading string literal` };
    }
    return { ok: false, reason: 'dynamic className expression' };
  }

  return { ok: false, reason: `unsupported className value (${value.type})` };
}
