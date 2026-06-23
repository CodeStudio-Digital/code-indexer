/**
 * JavaScript generator — fetch() for the browser variant and Node.js (adds a
 * runtime note; fetch is global on Node 18+).
 */
import type { CodegenRequest } from './types.js';

export function generateJs(req: CodegenRequest, variant: 'fetch' | 'node'): string {
  const headers: Record<string, string> = {};
  for (const h of req.headers) headers[h.name] = h.value;

  const opts: string[] = [`  method: ${j(req.method)},`];
  if (Object.keys(headers).length) opts.push(`  headers: ${JSON.stringify(headers, null, 2).replace(/\n/g, '\n  ')},`);

  const b = req.body;
  if (b.kind === 'json') opts.push(`  body: ${j(b.content)},`);
  else if (b.kind === 'raw') opts.push(`  body: ${j(b.content)},`);
  else if (b.kind === 'graphql') opts.push(`  body: JSON.stringify(${JSON.stringify({ query: b.query, variables: safeParse(b.variables) })}),`);
  else if (b.kind === 'urlencoded') opts.push(`  body: new URLSearchParams(${JSON.stringify(Object.fromEntries(b.fields))}),`);
  else if (b.kind === 'form-data') opts.push(`  // form-data: build a FormData() and append fields/files`);
  else if (b.kind === 'binary') opts.push(`  // binary: read ${b.note} and pass as body`);

  const header = variant === 'node' ? '// Node.js 18+ (global fetch)\n' : '';
  return `${header}const res = await fetch(${j(req.url)}, {\n${opts.join('\n')}\n});\nconst data = await res.json();\nconsole.log(data);`;
}

function j(s: string): string { return JSON.stringify(s); }
function safeParse(s?: string): unknown { if (!s) return undefined; try { return JSON.parse(s); } catch { return s; } }
