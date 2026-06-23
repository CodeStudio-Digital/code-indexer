/**
 * cURL generator — bash and Windows-cmd variants. cmd is best-effort (Windows
 * quoting is ambiguous); bash single-quoting is robust.
 */
import { bashSingleQuote, cmdQuote } from './shell-quote.js';
import type { CodegenRequest } from './types.js';

export function generateCurl(req: CodegenRequest, variant: 'bash' | 'cmd'): string {
  const q = variant === 'bash' ? bashSingleQuote : cmdQuote;
  const cont = variant === 'bash' ? '\\' : '^';
  const lines: string[] = [`curl -X ${req.method} ${q(req.url)}`];

  for (const h of req.headers) lines.push(`-H ${q(`${h.name}: ${h.value}`)}`);

  const b = req.body;
  if (b.kind === 'json' || b.kind === 'raw') {
    if (b.content) lines.push(`--data ${q(b.content)}`);
  } else if (b.kind === 'graphql') {
    lines.push(`--data ${q(JSON.stringify({ query: b.query, variables: b.variables ? safeParse(b.variables) : undefined }))}`);
  } else if (b.kind === 'urlencoded') {
    for (const [k, v] of b.fields) lines.push(`--data-urlencode ${q(`${k}=${v}`)}`);
  } else if (b.kind === 'form-data') {
    for (const f of b.fields) lines.push(`-F ${q(f.filename ? `${f.name}=@${f.filename}` : `${f.name}=${f.value}`)}`);
  } else if (b.kind === 'binary') {
    lines.push(`--data-binary ${q(`@${b.note}`)}`);
  }

  return lines.join(` ${cont}\n  `);
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
