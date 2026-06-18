/**
 * PowerShell generator — Invoke-RestMethod with a hashtable of headers and a
 * single-quoted/here-string body.
 */
import { psSingleQuote } from './shell-quote.js';
import type { CodegenRequest } from './types.js';

export function generatePowerShell(req: CodegenRequest): string {
  const lines: string[] = [];
  if (req.headers.length) {
    lines.push('$headers = @{');
    for (const h of req.headers) lines.push(`  ${psSingleQuote(h.name)} = ${psSingleQuote(h.value)}`);
    lines.push('}');
  }

  const b = req.body;
  let bodyArg = '';
  if (b.kind === 'json' || b.kind === 'raw') {
    if (b.content) { lines.push(`$body = @'\n${b.content}\n'@`); bodyArg = ' -Body $body'; }
  } else if (b.kind === 'graphql') {
    lines.push(`$body = @'\n${JSON.stringify({ query: b.query, variables: b.variables })}\n'@`); bodyArg = ' -Body $body';
  } else if (b.kind === 'urlencoded') {
    const pairs = b.fields.map(([k, v]) => `${psSingleQuote(k)} = ${psSingleQuote(v)}`).join('; ');
    lines.push(`$body = @{ ${pairs} }`); bodyArg = ' -Body $body';
  } else if (b.kind === 'form-data') {
    const pairs = b.fields.map((f) => `${psSingleQuote(f.name)} = ${f.filename ? `Get-Item ${psSingleQuote(f.filename)}` : psSingleQuote(f.value)}`).join('; ');
    lines.push(`$form = @{ ${pairs} }`); bodyArg = ' -Form $form';
  } else if (b.kind === 'binary') {
    bodyArg = ` -InFile ${psSingleQuote(b.note)}`;
  }

  const headersArg = req.headers.length ? ' -Headers $headers' : '';
  lines.push(`Invoke-RestMethod -Uri ${psSingleQuote(req.url)} -Method ${req.method}${headersArg}${bodyArg}`);
  return lines.join('\n');
}
