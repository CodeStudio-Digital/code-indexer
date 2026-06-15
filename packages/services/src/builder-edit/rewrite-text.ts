/**
 * Surgical text rewrite for a located JSX element. Only elements whose
 * children are a SINGLE meaningful text node are editable — anything with
 * child elements or live expressions is refused (the caller falls back to
 * "ask the agent"), because blind replacement would delete markup.
 *
 * Editable shapes:
 *   <p>Hello</p>          → replace the trimmed segment of the JSXText
 *   <p>{'Hello'}</p>      → replace the string literal
 *   <p>{"Hello"}</p>      → idem
 *
 * New text goes in as plain JSXText when it is safe, or as a quoted
 * expression container (`{"…"}`) when it contains JSX-special characters
 * — which keeps the node editable by this same path on the next edit.
 */
import MagicString from 'magic-string';
import type { JSXElement } from '@babel/types';
import type { RewriteResult } from './rewrite-classes.js';

const JSX_SPECIAL = /[{}<>]/;

export function rewriteText(code: string, element: JSXElement, text: string): RewriteResult {
  const meaningful = element.children.filter((c) => {
    if (c.type === 'JSXText') return c.value.trim().length > 0;
    return true; // elements, containers, fragments, spreads all count
  });

  if (meaningful.length === 0) {
    return { ok: false, reason: 'element has no editable text' };
  }
  if (meaningful.length > 1) {
    return { ok: false, reason: 'element has mixed children — edit via the agent' };
  }

  const child = meaningful[0];
  const ms = new MagicString(code);

  if (child.type === 'JSXText') {
    const raw = child.value;
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    if (typeof child.start !== 'number' || typeof child.end !== 'number') {
      return { ok: false, reason: 'text node has no position info' };
    }
    const from = child.start + lead;
    const to = child.end - trail;
    const replacement = JSX_SPECIAL.test(text) ? `{${JSON.stringify(text)}}` : text;
    if (from === to) ms.appendRight(from, replacement);
    else ms.overwrite(from, to, replacement);
    return { ok: true, code: ms.toString() };
  }

  if (
    child.type === 'JSXExpressionContainer' &&
    child.expression.type === 'StringLiteral' &&
    typeof child.expression.start === 'number' &&
    typeof child.expression.end === 'number'
  ) {
    ms.overwrite(child.expression.start, child.expression.end, JSON.stringify(text));
    return { ok: true, code: ms.toString() };
  }

  return { ok: false, reason: 'children are dynamic — edit via the agent' };
}
