/**
 * HTTPie generator — `http METHOD url Header:val key==query field=val`.
 */
import { bashSingleQuote } from './shell-quote.js';
import type { CodegenRequest } from './types.js';

export function generateHttpie(req: CodegenRequest): string {
  const parts: string[] = ['http', req.method, bashSingleQuote(req.url)];
  for (const h of req.headers) parts.push(bashSingleQuote(`${h.name}:${h.value}`));

  const b = req.body;
  if (b.kind === 'json') {
    // Pipe raw JSON in — HTTPie's key=value syntax can't express arbitrary JSON.
    return `echo ${bashSingleQuote(b.content || '{}')} | ${parts.join(' ')}`;
  }
  if (b.kind === 'raw') {
    return `echo ${bashSingleQuote(b.content)} | ${parts.join(' ')}`;
  }
  if (b.kind === 'graphql') {
    return `echo ${bashSingleQuote(JSON.stringify({ query: b.query, variables: b.variables }))} | ${parts.join(' ')}`;
  }
  if (b.kind === 'urlencoded') {
    for (const [k, v] of b.fields) parts.push(bashSingleQuote(`${k}=${v}`));
    parts.splice(1, 0, '--form');
  } else if (b.kind === 'form-data') {
    for (const f of b.fields) parts.push(bashSingleQuote(f.filename ? `${f.name}@${f.filename}` : `${f.name}=${f.value}`));
    parts.splice(1, 0, '--form');
  }
  return parts.join(' ');
}
